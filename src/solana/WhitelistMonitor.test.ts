import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { WhitelistMonitor, type WhitelistChangeEvent } from "./WhitelistMonitor.js";

// ---------------------------------------------------------------------------
// Helpers to build valid encoded Global account buffers.
//
// We build the buffer manually instead of using BorshAccountsCoder.encode()
// because Anchor 0.31's encoder allocates a fixed 1000-byte buffer that is
// too small for the full Global struct (~1045 bytes incl. discriminator).
//
// Layout (Borsh, LE u64, fixed-size arrays — from pump.json IDL):
//   disc(8) bool(1) pk(32)*2 u64*5 pk(32) bool u64*2 pk*7 pk*2 bool pk*2
//   bool pk*7 bool pk*8 u64*2 pk*1
// ---------------------------------------------------------------------------

const ZERO_KEY = PublicKey.default;
const MINT_A = new PublicKey("So11111111111111111111111111111111111111112");
const MINT_B = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const GLOBAL_DISCRIMINATOR = Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]);
const U64_ZERO = Buffer.alloc(8, 0);
const BOOL_FALSE = Buffer.from([0]);

function pk(key: PublicKey): Buffer {
  return Buffer.from(key.toBytes());
}

function pks(keys: PublicKey[]): Buffer {
  return Buffer.concat(keys.map(pk));
}

function encodeGlobal(whitelistedQuoteMints: PublicKey[]): Buffer {
  const padded = [...whitelistedQuoteMints];
  while (padded.length < 1) padded.push(ZERO_KEY);

  return Buffer.concat([
    GLOBAL_DISCRIMINATOR,
    BOOL_FALSE,                    // initialized
    pk(ZERO_KEY),                  // authority
    pk(ZERO_KEY),                  // fee_recipient
    U64_ZERO, U64_ZERO, U64_ZERO,  // initial_virtual_token/sol/real_token_reserves
    U64_ZERO, U64_ZERO,            // token_total_supply, fee_basis_points
    pk(ZERO_KEY),                  // withdraw_authority
    BOOL_FALSE,                    // enable_migrate
    U64_ZERO, U64_ZERO,            // pool_migration_fee, creator_fee_basis_points
    pks(Array(7).fill(ZERO_KEY)),  // fee_recipients[7]
    pk(ZERO_KEY),                  // set_creator_authority
    pk(ZERO_KEY),                  // admin_set_creator_authority
    BOOL_FALSE,                    // create_v2_enabled
    pk(ZERO_KEY),                  // whitelist_pda
    pk(ZERO_KEY),                  // reserved_fee_recipient
    BOOL_FALSE,                    // mayhem_mode_enabled
    pks(Array(7).fill(ZERO_KEY)),  // reserved_fee_recipients[7]
    BOOL_FALSE,                    // is_cashback_enabled
    pks(Array(8).fill(ZERO_KEY)),  // buyback_fee_recipients[8]
    U64_ZERO, U64_ZERO,            // buyback_basis_points, initial_virtual_quote_reserves
    pks(padded),                   // whitelisted_quote_mints[1]
  ]);
}

// Flush pending microtasks — multiple passes for chained awaits in bootstrap.
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type AccountChangeCb = (info: { data: Buffer }, ctx: { slot: number }) => void;

function makeConnection(
  initialData: Buffer,
  { subscriptionId = 42 }: { subscriptionId?: number } = {},
) {
  let registeredCb: AccountChangeCb | null = null;

  const mockConnection = {
    getAccountInfo: vi.fn().mockResolvedValue({ data: initialData }),
    onAccountChange: vi.fn().mockImplementation(
      (_pubkey: PublicKey, cb: AccountChangeCb, _commitment: string) => {
        registeredCb = cb;
        return subscriptionId;
      },
    ),
    removeAccountChangeListener: vi.fn().mockResolvedValue(undefined),
    simulateChange(data: Buffer, slot = 100): void {
      registeredCb?.({ data }, { slot });
    },
  };

  return mockConnection as unknown as typeof mockConnection & Connection;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WhitelistMonitor", () => {
  it("start() fires onChanged immediately with current state (initial snapshot)", async () => {
    const buf = encodeGlobal([MINT_A]);
    const conn = makeConnection(buf);
    const events: WhitelistChangeEvent[] = [];

    const monitor = new WhitelistMonitor(conn, (e) => events.push(e));
    const stop = monitor.start();

    await flushPromises();

    expect(events.length).toBe(1);
    expect(events[0].slot).toBe(0); // slot=0 is the initial-snapshot sentinel
    expect(events[0].addedMints.map((k) => k.toBase58())).toContain(MINT_A.toBase58());
    expect(events[0].removedMints).toHaveLength(0);
    expect(events[0].currentWhitelist.map((k) => k.toBase58())).toContain(MINT_A.toBase58());

    await stop();
  });

  it("start() fires onChanged with correct addedMints/removedMints on account change", async () => {
    const initial = encodeGlobal([MINT_A]);
    const conn = makeConnection(initial);
    const events: WhitelistChangeEvent[] = [];

    const monitor = new WhitelistMonitor(conn, (e) => events.push(e));
    const stop = monitor.start();

    await flushPromises();

    const updated = encodeGlobal([MINT_B]);
    conn.simulateChange(updated, 200);

    expect(events.length).toBe(2);
    const change = events[1];
    expect(change.slot).toBe(200);
    expect(change.addedMints.map((k) => k.toBase58())).toContain(MINT_B.toBase58());
    expect(change.removedMints.map((k) => k.toBase58())).toContain(MINT_A.toBase58());
    expect(change.currentWhitelist.map((k) => k.toBase58())).toContain(MINT_B.toBase58());

    await stop();
  });

  it("start() does NOT fire when watchMints is set and changed mint is not in watchMints", async () => {
    const initial = encodeGlobal([MINT_A]);
    const conn = makeConnection(initial);
    const events: WhitelistChangeEvent[] = [];

    const WATCHED = new PublicKey("11111111111111111111111111111112");
    const monitor = new WhitelistMonitor(conn, (e) => events.push(e), {
      watchMints: [WATCHED],
    });
    const stop = monitor.start();

    await flushPromises();

    // Initial snapshot is always delivered regardless of watchMints.
    expect(events.length).toBe(1);

    // Change: MINT_A → MINT_B — neither is WATCHED.
    conn.simulateChange(encodeGlobal([MINT_B]), 300);

    expect(events.length).toBe(1); // change was filtered out

    await stop();
  });

  it("isWhitelisted returns true when mint is in the list", async () => {
    const conn = makeConnection(encodeGlobal([MINT_A]));
    expect(await WhitelistMonitor.isWhitelisted(conn, MINT_A)).toBe(true);
  });

  it("isWhitelisted returns false when mint is not in the list", async () => {
    const conn = makeConnection(encodeGlobal([MINT_A]));
    expect(await WhitelistMonitor.isWhitelisted(conn, MINT_B)).toBe(false);
  });

  it("cleanup function calls removeAccountChangeListener with correct subscriptionId", async () => {
    const conn = makeConnection(encodeGlobal([MINT_A]), { subscriptionId: 77 });

    const monitor = new WhitelistMonitor(conn, () => {});
    const stop = monitor.start();

    await flushPromises();
    await stop();

    expect(conn.removeAccountChangeListener).toHaveBeenCalledWith(77);
  });
});
