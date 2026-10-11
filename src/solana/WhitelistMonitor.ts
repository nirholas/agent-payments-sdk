// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { GLOBAL_PDA, PUMP_PROGRAM_ID, PUMP_SDK } from "@pump-fun/pump-sdk";
import {
  type AccountInfo,
  type Commitment,
  type Connection,
  type PublicKey,
} from "@solana/web3.js";

export { PUMP_PROGRAM_ID };

/** The pump bonding-curve program's `Global` account. */
export const PUMP_GLOBAL_PDA: PublicKey = GLOBAL_PDA;

export interface WhitelistChangeEvent {
  addedMints: PublicKey[];
  removedMints: PublicKey[];
  currentWhitelist: PublicKey[];
  timestamp: Date;
  slot: number;
}

function decodeWhitelist(data: Buffer): PublicKey[] {
  const global = PUMP_SDK.decodeGlobal({ data } as AccountInfo<Buffer>);
  return global.whitelistedQuoteMints ?? [];
}

function setDiff(a: PublicKey[], b: PublicKey[]): PublicKey[] {
  const bSet = new Set(b.map((k) => k.toBase58()));
  return a.filter((k) => !bSet.has(k.toBase58()));
}

function setsEqual(a: PublicKey[], b: PublicKey[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b.map((k) => k.toBase58()));
  return a.every((k) => bs.has(k.toBase58()));
}

/**
 * Watches `Global.whitelistedQuoteMints` on the Pump bonding-curve program, decoded with the pinned `@pump-fun/pump-sdk` so the layout always matches the deployed `Global` account.
 *
 * Uses `connection.onAccountChange` on the Global PDA — detection latency is
 * measured in seconds from the on-chain write, before any Discord announcement.
 */
export class WhitelistMonitor {
  constructor(
    private readonly connection: Connection,
    private readonly onChanged: (event: WhitelistChangeEvent) => void,
    private readonly options?: {
      commitment?: Commitment;
      watchMints?: PublicKey[];
    },
  ) {}

  /**
   * Start watching. Fires `onChanged` immediately with the current state, then
   * on every subsequent on-chain change. Returns an async cleanup function.
   */
  start(): () => Promise<void> {
    const commitment: Commitment = this.options?.commitment ?? "confirmed";
    let prev: PublicKey[] = [];
    let bootstrapped = false;
    const buffered: Array<{ data: Buffer; slot: number }> = [];

    const fire = (
      addedMints: PublicKey[],
      removedMints: PublicKey[],
      currentWhitelist: PublicKey[],
      slot: number,
    ): void => {
      if (
        this.options?.watchMints &&
        this.options.watchMints.length > 0 &&
        // Initial snapshot always fires; subsequent fires filter by watchMints.
        (addedMints.length > 0 || removedMints.length > 0)
      ) {
        const watch = new Set(
          this.options.watchMints.map((k) => k.toBase58()),
        );
        const touched =
          addedMints.some((k) => watch.has(k.toBase58())) ||
          removedMints.some((k) => watch.has(k.toBase58()));
        if (!touched) return;
      }
      this.onChanged({
        addedMints,
        removedMints,
        currentWhitelist,
        timestamp: new Date(),
        slot,
      });
    };

    const applyUpdate = (data: Buffer, slot: number): void => {
      let next: PublicKey[];
      try {
        next = decodeWhitelist(data);
      } catch (err) {
        console.error("WhitelistMonitor: decode error:", err);
        return;
      }
      if (setsEqual(prev, next)) return;
      const addedMints = setDiff(next, prev);
      const removedMints = setDiff(prev, next);
      prev = next;
      if (addedMints.length === 0 && removedMints.length === 0) return;
      fire(addedMints, removedMints, next, slot);
    };

    const subscriptionId = this.connection.onAccountChange(
      PUMP_GLOBAL_PDA,
      (info: AccountInfo<Buffer>, ctx) => {
        if (!bootstrapped) {
          buffered.push({ data: info.data, slot: ctx.slot });
          return;
        }
        applyUpdate(info.data, ctx.slot);
      },
      commitment,
    );

    const bootstrap = (async () => {
      try {
        const info = await this.connection.getAccountInfo(
          PUMP_GLOBAL_PDA,
          commitment,
        );
        if (!info) {
          throw new Error(
            `Pump Global PDA ${PUMP_GLOBAL_PDA.toBase58()} not found`,
          );
        }
        const initial = decodeWhitelist(info.data);
        prev = initial;
        // Always fire for the initial snapshot — no watchMints filter.
        this.onChanged({
          addedMints: initial,
          removedMints: [],
          currentWhitelist: initial,
          timestamp: new Date(),
          slot: 0,
        });
      } catch (err) {
        console.error("WhitelistMonitor: bootstrap failed:", err);
      } finally {
        bootstrapped = true;
        for (const { data, slot } of buffered.splice(0)) {
          applyUpdate(data, slot);
        }
      }
    })();

    return async () => {
      await bootstrap;
      await this.connection.removeAccountChangeListener(subscriptionId);
    };
  }

  /** Fetch current `whitelistedQuoteMints` without subscribing. */
  static async getCurrentWhitelist(
    connection: Connection,
  ): Promise<PublicKey[]> {
    const info = await connection.getAccountInfo(PUMP_GLOBAL_PDA);
    if (!info) {
      throw new Error(
        `Pump Global PDA ${PUMP_GLOBAL_PDA.toBase58()} not found`,
      );
    }
    return decodeWhitelist(info.data);
  }

  /** True if `mint` is currently in `whitelistedQuoteMints`. */
  static async isWhitelisted(
    connection: Connection,
    mint: PublicKey,
  ): Promise<boolean> {
    const list = await WhitelistMonitor.getCurrentWhitelist(connection);
    return list.some((k) => k.equals(mint));
  }
}
