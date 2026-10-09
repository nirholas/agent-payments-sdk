// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * Fixture-based tests for the pump bonding-curve event parser.
 * Fixtures are real mainnet transaction logs, not synthesized bytes.
 * create, trade-buy and trade-sell were logged before the October 2026
 * program upgrade (shorter events); create-v2 and sweep-creator-fee were
 * logged after it (full-length events).
 */
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BN } from "@coral-xyz/anchor";
import {
  createPumpEventParser,
  decodePumpEvent,
  subscribeToPumpEvents,
  eventDiscriminatorMap,
  RETIRED_EVENTS,
  SWEEP_BUCKET,
  type PumpEventName,
  type ParsedPumpEvent,
  PUMP_BONDING_CURVE_PROGRAM_ID,
} from "./pump-events.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

interface Fixture {
  signature: string;
  slot: number;
  logMessages: string[];
  expected: { name: string; data: Record<string, unknown> };
}

function loadFixture(name: string): Fixture {
  const p = join(
    new URL(".", import.meta.url).pathname,
    "fixtures/pump-events",
    `${name}.json`,
  );
  return JSON.parse(readFileSync(p, "utf8")) as Fixture;
}

/**
 * BN values come out of JSON as hex strings (BN.toJSON() returns hex).
 * Normalise both sides to string before comparing.
 */
function normalise(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof PublicKey) return v.toBase58();
  if (typeof v === "object" && !Array.isArray(v)) {
    // BN: { words, negative, length, red } or just a hex string in fixture
    if ("words" in (v as object)) {
      // A BN: toJSON() gives hex, so compare via toString(16)
      const bn = v as { toString: (r?: number) => string };
      return bn.toString(16);
    }
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [
        k,
        normalise(val),
      ]),
    );
  }
  if (Array.isArray(v)) return (v as unknown[]).map(normalise);
  return v;
}

// ─── Discriminator coverage ───────────────────────────────────────────────────

describe("eventDiscriminatorMap", () => {
  it("covers every event in the IDL plus the retired ones", async () => {
    const { default: IDL_JSON } = await import("./idl/pump.json", {
      with: { type: "json" },
    });
    expect(eventDiscriminatorMap.size).toBe(
      IDL_JSON.events.length + RETIRED_EVENTS.length,
    );
    for (const ev of IDL_JSON.events) {
      expect(
        eventDiscriminatorMap.get(ev.name as PumpEventName)?.equals(
          Buffer.from(ev.discriminator),
        ),
      ).toBe(true);
    }
  });
});

// ─── Parser: fixture round-trips ─────────────────────────────────────────────

describe("createPumpEventParser", () => {
  const parser = createPumpEventParser();

  it("decodes create fixture: event name is CreateEvent", () => {
    const { logMessages } = loadFixture("create");
    const events = parser.parseLogs(logMessages);
    const ev = events.find((e) => e.name === "CreateEvent");
    expect(ev).toBeDefined();
    expect(ev!.name).toBe("CreateEvent");
  });

  it("decodes create fixture: mint is valid base58 pubkey", () => {
    const { logMessages } = loadFixture("create");
    const events = parser.parseLogs(logMessages);
    const ev = events.find((e) => e.name === "CreateEvent")!;
    const data = ev.data as { mint: unknown };
    expect(data.mint).toBeInstanceOf(PublicKey);
    expect(() => (data.mint as PublicKey).toBase58()).not.toThrow();
  });

  it("decodes create fixture: name/symbol are non-empty strings", () => {
    const { logMessages, expected } = loadFixture("create");
    const events = parser.parseLogs(logMessages);
    const ev = events.find((e) => e.name === "CreateEvent")!;
    const data = ev.data as { name: string; symbol: string };
    expect(typeof data.name).toBe("string");
    expect(data.name.length).toBeGreaterThan(0);
    expect(data.name).toBe(expected.data.name);
    expect(data.symbol).toBe(expected.data.symbol);
  });

  it("decodes trade-buy fixture: event name is TradeEvent", () => {
    const { logMessages } = loadFixture("trade-buy");
    const events = parser.parseLogs(logMessages);
    const ev = events.find((e) => e.name === "TradeEvent");
    expect(ev).toBeDefined();
  });

  it("decodes trade-buy fixture: is_buy is true", () => {
    const { logMessages } = loadFixture("trade-buy");
    const events = parser.parseLogs(logMessages);
    const ev = events.find(
      (e) => e.name === "TradeEvent" && (e.data as { is_buy: boolean }).is_buy,
    );
    expect(ev).toBeDefined();
    expect((ev!.data as { is_buy: boolean }).is_buy).toBe(true);
  });

  it("decodes trade-sell fixture: is_buy is false", () => {
    const { logMessages } = loadFixture("trade-sell");
    const events = parser.parseLogs(logMessages);
    const ev = events.find(
      (e) => e.name === "TradeEvent" && !(e.data as { is_buy: boolean }).is_buy,
    );
    expect(ev).toBeDefined();
    expect((ev!.data as { is_buy: boolean }).is_buy).toBe(false);
  });

  it("decoded trade-buy mint matches fixture expected", () => {
    const { logMessages, expected } = loadFixture("trade-buy");
    const events = parser.parseLogs(logMessages);
    const ev = events.find((e) => e.name === "TradeEvent") as
      | ParsedPumpEvent<"TradeEvent">
      | undefined;
    expect(ev).toBeDefined();
    expect((ev!.data.mint as PublicKey).toBase58()).toBe(expected.data.mint);
  });

  it("decoded trade-buy sol_amount is a non-zero BN", () => {
    const { logMessages } = loadFixture("trade-buy");
    const events = parser.parseLogs(logMessages);
    const ev = events.find(
      (e) => e.name === "TradeEvent" && (e.data as { is_buy: boolean }).is_buy,
    ) as ParsedPumpEvent<"TradeEvent"> | undefined;
    expect(ev).toBeDefined();
    // BN is an object with a `words` array; verify it converts to a positive int
    const solAmt = ev!.data.sol_amount;
    expect(solAmt).toBeTruthy();
    expect(Number(solAmt.toString()) > 0).toBe(true);
  });

  it("ignores log lines without Program data: prefix", () => {
    const events = parser.parseLogs([
      "Program log: something",
      "Program invoke [1]",
      "Program 6EF8rrec... success",
    ]);
    expect(events).toHaveLength(0);
  });

  it("ignores base64 with unknown discriminator", () => {
    // 8 zero bytes + empty payload: matches no event
    const unknown = Buffer.alloc(8).toString("base64");
    const events = parser.parseLogs([`Program data: ${unknown}`]);
    expect(events).toHaveLength(0);
  });

  it("empty logs array returns empty array", () => {
    expect(parser.parseLogs([])).toHaveLength(0);
  });
});

// ─── Length tolerance ─────────────────────────────────────────────────────────

function programDataBytes(logMessages: string[], name: PumpEventName): Buffer {
  const disc = eventDiscriminatorMap.get(name)!;
  for (const line of logMessages) {
    if (!line.startsWith("Program data: ")) continue;
    const bytes = Buffer.from(line.slice("Program data: ".length), "base64");
    if (bytes.subarray(0, 8).equals(disc)) return bytes;
  }
  throw new Error(`fixture has no ${name}`);
}

describe("length-tolerant decoding", () => {
  const parser = createPumpEventParser();

  it("decodes a pre-upgrade CreateEvent and lists the fields it predates", () => {
    const { logMessages } = loadFixture("create");
    const ev = parser
      .parseLogs(logMessages)
      .find((e) => e.name === "CreateEvent") as ParsedPumpEvent<"CreateEvent">;
    expect(ev.absentFields).toEqual(["creator_fee_bps", "is_holder_reward", "depth"]);
    expect(ev.data.creator_fee_bps.isZero()).toBe(true);
    expect(ev.data.is_holder_reward).toBe(false);
    expect(ev.data.depth).toBe(0);
  });

  it("decodes a pre-upgrade TradeEvent and zero-fills the holder reward fields", () => {
    const { logMessages } = loadFixture("trade-buy");
    const ev = parser
      .parseLogs(logMessages)
      .find((e) => e.name === "TradeEvent") as ParsedPumpEvent<"TradeEvent">;
    expect(ev.absentFields).toEqual([
      "holder_rewards_bps",
      "holder_rewards",
      "creator_fee_unclaimed",
    ]);
    expect(ev.data.holder_rewards.isZero()).toBe(true);
  });

  it("decodes post-upgrade create_v2 + buy_v2 events with no absent fields", () => {
    const { logMessages, expected } = loadFixture("create-v2");
    const events = parser.parseLogs(logMessages);
    expect(events.map((e) => e.name)).toEqual(["CreateEvent", "TradeEvent"]);
    for (const ev of events) expect(ev.absentFields).toEqual([]);
    const create = events[0] as ParsedPumpEvent<"CreateEvent">;
    expect(create.data.mint.toBase58()).toBe(expected.data.mint);
    expect(create.data.depth).toBe(expected.data.depth);
    expect(create.data.creator_fee_bps.toString()).toBe(expected.data.creator_fee_bps);
  });

  it("decodes the creator-fee sweep that precedes collect_creator_fee_v2", () => {
    const { logMessages, expected } = loadFixture("sweep-creator-fee");
    const events = parser.parseLogs(logMessages);
    expect(events.map((e) => e.name)).toEqual([
      "SweepBondingCurveFeeEvent",
      "CollectCreatorFeeEvent",
    ]);
    const sweep = events[0] as ParsedPumpEvent<"SweepBondingCurveFeeEvent">;
    expect(sweep.absentFields).toEqual([]);
    expect(sweep.data.bucket).toBe(SWEEP_BUCKET.creator);
    expect(sweep.data.amount.toString()).toBe(expected.data.amount);
    expect(sweep.data.mint.toBase58()).toBe(expected.data.mint);
  });

  it("ignores bytes past the last known field", () => {
    const { logMessages } = loadFixture("create-v2");
    const bytes = programDataBytes(logMessages, "CreateEvent");
    const longer = Buffer.concat([bytes, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])]);
    const a = decodePumpEvent(bytes)!;
    const b = decodePumpEvent(longer)!;
    expect(b.absentFields).toEqual([]);
    expect(normalise(b.data)).toEqual(normalise(a.data));
  });

  it("skips an event whose bytes end inside a field", () => {
    const { logMessages } = loadFixture("sweep-creator-fee");
    const bytes = programDataBytes(logMessages, "SweepBondingCurveFeeEvent");
    // Cut 4 bytes into the 8-byte `amount` field (bucket u8 is the last byte).
    const truncated = bytes.subarray(0, bytes.length - 1 - 4);
    expect(decodePumpEvent(truncated)).toBeNull();
    expect(
      parser.parseLogs([`Program data: ${truncated.toString("base64")}`]),
    ).toHaveLength(0);
  });

  it("decodes the retired AdminSetCreatorEvent from historical logs", () => {
    const retired = RETIRED_EVENTS.find((e) => e.name === "AdminSetCreatorEvent")!;
    const keys = Array.from({ length: 5 }, (_, i) => new PublicKey(Buffer.alloc(32, i + 1)));
    const ts = new BN(1_760_000_000);
    const bytes = Buffer.concat([
      Buffer.from(retired.discriminator),
      ts.toArrayLike(Buffer, "le", 8),
      ...keys.map((k) => k.toBuffer()),
    ]);
    const ev = decodePumpEvent(bytes) as ParsedPumpEvent<"AdminSetCreatorEvent">;
    expect(ev.name).toBe("AdminSetCreatorEvent");
    expect(ev.absentFields).toEqual([]);
    expect(ev.data.timestamp.eq(ts)).toBe(true);
    expect(ev.data.new_creator.equals(keys[4])).toBe(true);
  });
});

// ─── subscribeToPumpEvents ────────────────────────────────────────────────────

describe("subscribeToPumpEvents", () => {
  it("calls onEvent with parsed events from stubbed connection", async () => {
    const { logMessages, expected } = loadFixture("trade-sell");

    let capturedCallback: ((logs: unknown, ctx: unknown) => void) | null = null;
    const mockConn = {
      onLogs: vi.fn((_id: unknown, cb: (logs: unknown, ctx: unknown) => void) => {
        capturedCallback = cb;
        return 42; // subscription id
      }),
      removeOnLogsListener: vi.fn(() => Promise.resolve()),
    };

    const received: ParsedPumpEvent[] = [];
    const sub = subscribeToPumpEvents(
      mockConn,
      { programId: PUMP_BONDING_CURVE_PROGRAM_ID },
      (ev) => received.push(ev),
    );

    // Fire the stub callback with the real fixture logs
    capturedCallback!({ logs: logMessages, err: null, signature: expected.name }, { slot: 12345 });

    expect(received.length).toBeGreaterThan(0);
    expect(received.some((e) => e.name === "TradeEvent")).toBe(true);
  });

  it("unsubscribe is idempotent: calling twice does not throw", async () => {
    const mockConn = {
      onLogs: vi.fn(() => 99),
      removeOnLogsListener: vi.fn(() => Promise.resolve()),
    };
    const sub = subscribeToPumpEvents(mockConn, {}, vi.fn());
    await sub.unsubscribe();
    await sub.unsubscribe(); // second call: must not throw
    expect(mockConn.removeOnLogsListener).toHaveBeenCalledTimes(1);
  });

  it("mint filter: only emits events whose mint field matches", () => {
    const { logMessages, expected } = loadFixture("trade-sell");
    const targetMint = new PublicKey(expected.data.mint as string);
    const differentMint = new PublicKey(
      "So11111111111111111111111111111111111111112",
    );

    let capturedCallback: ((logs: unknown, ctx: unknown) => void) | null = null;
    const mockConn = {
      onLogs: vi.fn((_: unknown, cb: (logs: unknown, ctx: unknown) => void) => {
        capturedCallback = cb;
        return 1;
      }),
      removeOnLogsListener: vi.fn(() => Promise.resolve()),
    };

    const matchingEvents: ParsedPumpEvent[] = [];
    const sub = subscribeToPumpEvents(
      mockConn,
      { mint: targetMint },
      (ev) => matchingEvents.push(ev),
    );
    capturedCallback!(
      { logs: logMessages, err: null, signature: "sig1" },
      { slot: 1 },
    );
    expect(matchingEvents.length).toBeGreaterThan(0);

    const filteredEvents: ParsedPumpEvent[] = [];
    const sub2 = subscribeToPumpEvents(
      mockConn,
      { mint: differentMint },
      (ev) => filteredEvents.push(ev),
    );
    capturedCallback!(
      { logs: logMessages, err: null, signature: "sig2" },
      { slot: 2 },
    );
    expect(filteredEvents).toHaveLength(0);
  });

  it("skips errored log callbacks", () => {
    const { logMessages } = loadFixture("create");
    let capturedCallback: ((logs: unknown, ctx: unknown) => void) | null = null;
    const mockConn = {
      onLogs: vi.fn((_: unknown, cb: (logs: unknown, ctx: unknown) => void) => {
        capturedCallback = cb;
        return 1;
      }),
      removeOnLogsListener: vi.fn(() => Promise.resolve()),
    };

    const received: ParsedPumpEvent[] = [];
    subscribeToPumpEvents(mockConn, {}, (ev) => received.push(ev));

    // err != null → should be ignored
    capturedCallback!({ logs: logMessages, err: new Error("oops"), signature: "" }, { slot: 1 });
    expect(received).toHaveLength(0);
  });
});
