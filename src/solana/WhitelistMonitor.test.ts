import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { PUMP_GLOBAL_PDA, WhitelistMonitor, type WhitelistChangeEvent } from "./WhitelistMonitor.js";

// Global account data is opaque to the monitor: it hands the bytes to
// PUMP_SDK.decodeGlobal. The tests encode the whitelist as concatenated
// 32-byte keys and the mocked decoder reads them back, so the monitor's
// subscription, diffing and filtering logic runs against the real flow.

const MINT_A = new PublicKey("So11111111111111111111111111111111111111112");
const MINT_B = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

vi.mock("@pump-fun/pump-sdk", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@pump-fun/pump-sdk")>();
  return {
    ...orig,
    PUMP_SDK: {
      ...orig.PUMP_SDK,
      decodeGlobal: (info: { data: Buffer }) => {
        const keys: PublicKey[] = [];
        for (let i = 0; i < info.data.length; i += 32) {
          keys.push(new PublicKey(info.data.subarray(i, i + 32)));
        }
        return { whitelistedQuoteMints: keys };
      },
    },
  };
});

function encodeGlobal(whitelistedQuoteMints: PublicKey[]): Buffer {
  return Buffer.concat(whitelistedQuoteMints.map((k) => Buffer.from(k.toBytes())));
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

  it("subscribes to the pump Global PDA", async () => {
    const conn = makeConnection(encodeGlobal([MINT_A]));
    const stop = new WhitelistMonitor(conn, () => {}).start();
    await flushPromises();
    expect(conn.onAccountChange).toHaveBeenCalledWith(
      PUMP_GLOBAL_PDA,
      expect.any(Function),
      "confirmed",
    );
    await stop();
  });
});
