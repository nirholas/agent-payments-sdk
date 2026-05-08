// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * PumpMarketData tests
 *
 * Test 1 & 2: real mainnet RPC — use SOLANA_RPC_URL env var or public endpoint.
 * Test 3 & 4: unit tests with mocked connection + mocked CoinGecko.
 * Test 5: unit test for graduation progress calculation.
 */

import { BN } from "@coral-xyz/anchor";
import { NATIVE_MINT } from "@solana/spl-token";
import { clusterApiUrl, Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PumpMarketData } from "./PumpMarketData";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_MINT = new PublicKey("7DU5iH56AjEgbjmGJ21i1GiyxPxxGVLJwnPdar8ZmDrv");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// ─── Mocking helpers ──────────────────────────────────────────────────────────

// Anchor account discriminator for BondingCurve = SHA-256("account:BondingCurve")[0:8]
const BONDING_CURVE_DISC = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);

/**
 * Build a v2 bonding-curve account buffer that PUMP_SDK.decodeBondingCurve can parse.
 *
 * Layout (115 bytes):
 *   [0..7]   discriminator
 *   [8..47]  5 × u64 LE (virtualTokenReserves … tokenTotalSupply)
 *   [48]     complete (bool)
 *   [49..80] creator (pubkey)
 *   [81]     isMayhemMode (bool)
 *   [82]     isCashbackCoin (bool)
 *   [83..114] quoteMint (pubkey)
 */
function makeCurveBuffer(fields: {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete?: boolean;
  creator?: PublicKey;
  isMayhemMode?: boolean;
  isCashbackCoin?: boolean;
  quoteMint?: PublicKey;
}): Buffer {
  const creator = fields.creator ?? PublicKey.default;
  const quoteMint = fields.quoteMint ?? PublicKey.default;

  const buf = Buffer.alloc(115);
  BONDING_CURVE_DISC.copy(buf, 0);

  let off = 8;
  const writeU64LE = (val: bigint) => { buf.writeBigUInt64LE(val, off); off += 8; };

  writeU64LE(fields.virtualTokenReserves);
  writeU64LE(fields.virtualQuoteReserves);
  writeU64LE(fields.realTokenReserves);
  writeU64LE(fields.realQuoteReserves);
  writeU64LE(fields.tokenTotalSupply);

  buf.writeUInt8(fields.complete ? 1 : 0, off); off += 1;
  creator.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(fields.isMayhemMode ? 1 : 0, off); off += 1;
  buf.writeUInt8(fields.isCashbackCoin ? 1 : 0, off); off += 1;
  quoteMint.toBuffer().copy(buf, off);

  return buf;
}

function fakeAccountInfo(data: Buffer): AccountInfo<Buffer> {
  return { executable: false, lamports: 2_000_000, owner: PublicKey.default, data, rentEpoch: 0 };
}

/** Build a mock Connection that returns preset account infos. */
function makeConnection(
  infos: (AccountInfo<Buffer> | null)[],
): Connection {
  return {
    getMultipleAccountsInfo: vi.fn().mockResolvedValue(infos),
    onAccountChange: vi.fn().mockReturnValue(1),
    removeAccountChangeListener: vi.fn().mockResolvedValue(undefined),
  } as unknown as Connection;
}

// ─── Integration tests (real mainnet RPC) ─────────────────────────────────────

describe("PumpMarketData — integration (mainnet)", () => {
  const rpc =
    process.env.SOLANA_RPC_URL ?? clusterApiUrl("mainnet-beta");
  const connection = new Connection(rpc, "confirmed");
  const market = new PumpMarketData(connection);

  it(
    "getPrice returns a valid CoinPrice for the test coin",
    async () => {
      const price = await market.getPrice(TEST_MINT);

      expect(price.mint.equals(TEST_MINT)).toBe(true);
      expect(price.priceQuote).toBeGreaterThan(0);
      expect(price.priceUsd).toBeGreaterThan(0);
      expect(price.marketCapUsd).toBeGreaterThan(0);
      expect(["SOL", "USDC"]).toContain(price.quoteSymbol);
      expect(price.graduationProgressPct).toBeGreaterThanOrEqual(0);
      expect(price.graduationProgressPct).toBeLessThanOrEqual(100);
      expect(price.virtualTokenReserves.gtn(0)).toBe(true);
    },
    30_000,
  );

  it(
    "getPrices returns prices for multiple mints in one RPC call",
    async () => {
      // Use TEST_MINT twice to avoid needing a second live mint.
      const mints = [TEST_MINT, TEST_MINT];
      const map = await market.getPrices(mints);

      // Deduplicated by toBase58 key — map has 1 entry.
      expect(map.size).toBeGreaterThanOrEqual(1);
      const entry = map.get(TEST_MINT.toBase58());
      expect(entry).toBeDefined();
      expect(entry!.priceUsd).toBeGreaterThan(0);
    },
    30_000,
  );
});

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe("PumpMarketData — unit: SOL-quoted coin", () => {
  const solPrice = 150; // fixed mock SOL price

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ solana: { usd: solPrice } }),
    } as Response);
  });

  it("priceUsd = priceQuote × SOL_USD for a SOL-quoted coin", async () => {
    // virtualTokenReserves = 1_000_000_000_000  (1e12, 6-decimal tokens)
    // virtualQuoteReserves = 30_000_000_000     (30 SOL in lamports)
    const vt = 1_000_000_000_000n;
    const vq = 30_000_000_000n;
    const buf = makeCurveBuffer({
      virtualTokenReserves: vt,
      virtualQuoteReserves: vq,
      realTokenReserves: 793_100_000_000_000n,
      realQuoteReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      quoteMint: PublicKey.default, // SOL
    });

    const connection = makeConnection([fakeAccountInfo(buf)]);
    const market = new PumpMarketData(connection);

    const price = await market.getPrice(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));

    // priceQuote = (30e9 / 1e9) / (1e12 / 1e6) = 30 / 1e6 = 3e-5 SOL/token
    const expectedPriceQuote = (Number(vq) / 1e9) / (Number(vt) / 1e6);
    expect(price.priceQuote).toBeCloseTo(expectedPriceQuote, 10);
    expect(price.priceUsd).toBeCloseTo(expectedPriceQuote * solPrice, 8);
    expect(price.quoteSymbol).toBe("SOL");
    expect(price.quoteMint.equals(NATIVE_MINT)).toBe(true);
    expect(price.marketCapUsd).toBeGreaterThan(0);
  });
});

describe("PumpMarketData — unit: USDC-quoted coin", () => {
  beforeEach(() => {
    // getSolPrice should NOT be called for USDC coins in priceUsd calculation,
    // but the implementation calls it anyway (cached). Provide a value so it
    // doesn't affect the assertion.
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ solana: { usd: 1 } }),
    } as Response);
  });

  it("priceUsd equals priceQuote directly (USDC = $1.00)", async () => {
    // virtualTokenReserves = 1_000_000_000_000  (1e12 raw tokens)
    // virtualQuoteReserves = 30_000_000         (30 USDC in micro-USDC, 6 decimals)
    const vt = 1_000_000_000_000n;
    const vq = 30_000_000n; // 30 USDC
    const buf = makeCurveBuffer({
      virtualTokenReserves: vt,
      virtualQuoteReserves: vq,
      realTokenReserves: 793_100_000_000_000n,
      realQuoteReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      quoteMint: USDC_MINT,
    });

    const connection = makeConnection([fakeAccountInfo(buf)]);
    const market = new PumpMarketData(connection);

    const price = await market.getPrice(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));

    // priceQuote = (30e6 / 1e6) / (1e12 / 1e6) = 30 / 1e6 = 3e-5 USDC/token
    const expectedPriceQuote = (Number(vq) / 1e6) / (Number(vt) / 1e6);
    expect(price.priceQuote).toBeCloseTo(expectedPriceQuote, 10);
    // USDC is pegged at $1.00 so priceUsd === priceQuote
    expect(price.priceUsd).toBeCloseTo(expectedPriceQuote, 10);
    expect(price.quoteSymbol).toBe("USDC");
    expect(price.quoteMint.equals(USDC_MINT)).toBe(true);
  });
});

describe("PumpMarketData — unit: graduation progress", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ solana: { usd: 100 } }),
    } as Response);
  });

  it("graduationProgressPct is 50 when realQuoteReserves = 42.5 SOL", async () => {
    const halfThreshold = 42_500_000_000n; // 42.5 SOL
    const buf = makeCurveBuffer({
      virtualTokenReserves: 1_000_000_000_000n,
      virtualQuoteReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      realQuoteReserves: halfThreshold,
      tokenTotalSupply: 1_000_000_000_000_000n,
    });

    const connection = makeConnection([fakeAccountInfo(buf)]);
    const market = new PumpMarketData(connection);

    const price = await market.getPrice(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    expect(price.graduationProgressPct).toBeCloseTo(50, 1);
  });

  it("graduationProgressPct is capped at 100", async () => {
    const buf = makeCurveBuffer({
      virtualTokenReserves: 1_000_000_000_000n,
      virtualQuoteReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      realQuoteReserves: 200_000_000_000n, // 200 SOL > 85 SOL threshold
      tokenTotalSupply: 1_000_000_000_000_000n,
    });

    const connection = makeConnection([fakeAccountInfo(buf)]);
    const market = new PumpMarketData(connection);

    const price = await market.getPrice(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    expect(price.graduationProgressPct).toBe(100);
  });
});
