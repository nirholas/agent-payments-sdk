import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { PUMP_SDK, type BondingCurve } from "@pump-fun/pump-sdk";

import {
  PumpMarketData,
  estimatePriceImpact,
  humanReadablePrice,
  quoteToGraduation,
  type BondingCurveMarketData,
} from "./PumpMarketData.js";
import { USDC_SOLANA_MINT } from "../constants.js";

const USDC_MINT = new PublicKey(USDC_SOLANA_MINT);

const FAKE_AI: AccountInfo<Buffer> = {
  data: Buffer.alloc(0),
  executable: false,
  lamports: 0,
  owner: PublicKey.default,
};

function makeCurve(over: Partial<BondingCurve> = {}): BondingCurve {
  return {
    virtualTokenReserves: new BN("1073000000000000"),
    virtualQuoteReserves: new BN("30000000000"),
    realTokenReserves: new BN("793100000000000"),
    realQuoteReserves: new BN("0"),
    tokenTotalSupply: new BN("1000000000000000"),
    complete: false,
    creator: PublicKey.default,
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint: NATIVE_MINT,
    ...over,
  };
}

function fakeConnection(): Connection {
  // We don't need a working RPC — methods are stubbed per-test.
  return new Connection("http://127.0.0.1:9999", "confirmed");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PumpMarketData.getBondingCurveData", () => {
  it("decodes a SOL-paired bonding curve into normalized fields", async () => {
    const conn = fakeConnection();
    const curve = makeCurve();
    vi.spyOn(conn, "getAccountInfo").mockResolvedValue(FAKE_AI);
    vi.spyOn(PUMP_SDK, "decodeBondingCurve").mockReturnValue(curve);

    const md = new PumpMarketData(conn);
    const mint = new PublicKey("So11111111111111111111111111111111111111112");
    const data = await md.getBondingCurveData(mint);

    expect(data.mint.equals(mint)).toBe(true);
    expect(data.quoteMint.equals(NATIVE_MINT)).toBe(true);
    expect(data.quoteSymbol).toBe("SOL");
    expect(data.quoteDecimals).toBe(9);
    expect(data.virtualQuoteReserves.toString()).toBe(
      curve.virtualQuoteReserves.toString(),
    );
    expect(data.tokenTotalSupply.toString()).toBe(
      curve.tokenTotalSupply.toString(),
    );

    // circulatingSupply = totalSupply - realTokenReserves
    expect(data.circulatingSupply.toString()).toBe(
      curve.tokenTotalSupply.sub(curve.realTokenReserves).toString(),
    );

    // marketCap = vQuote * supply / vTok
    const expectedMcap = curve.virtualQuoteReserves
      .mul(curve.tokenTotalSupply)
      .div(curve.virtualTokenReserves);
    expect(data.marketCapInQuote.toString()).toBe(expectedMcap.toString());

    // pricePerTokenInQuote = vQuote * 10^6 / vTok
    const expectedPrice = curve.virtualQuoteReserves
      .mul(new BN(10).pow(new BN(6)))
      .div(curve.virtualTokenReserves);
    expect(data.pricePerTokenInQuote.toString()).toBe(
      expectedPrice.toString(),
    );

    expect(data.complete).toBe(false);
    expect(md.isNativeSolPair(data)).toBe(true);
  });
});

describe("PumpMarketData.getBondingCurveDataBatch", () => {
  it("returns null entries for missing accounts and decodes the rest", async () => {
    const conn = fakeConnection();
    const mintA = new PublicKey("So11111111111111111111111111111111111111112");
    const mintB = new PublicKey(USDC_SOLANA_MINT);
    const mintC = new PublicKey(
      "11111111111111111111111111111112",
    );

    const curveA = makeCurve();
    const curveB = makeCurve({ quoteMint: USDC_MINT });

    vi.spyOn(conn, "getMultipleAccountsInfo").mockResolvedValue([
      FAKE_AI,
      FAKE_AI,
      null,
    ]);
    const decodeSpy = vi
      .spyOn(PUMP_SDK, "decodeBondingCurve")
      .mockReturnValueOnce(curveA)
      .mockReturnValueOnce(curveB);

    const md = new PumpMarketData(conn);
    const result = await md.getBondingCurveDataBatch([mintA, mintB, mintC]);

    expect(result.size).toBe(3);
    expect(result.get(mintA.toBase58())?.quoteSymbol).toBe("SOL");
    expect(result.get(mintB.toBase58())?.quoteSymbol).toBe("USDC");
    expect(result.get(mintC.toBase58())).toBeNull();
    expect(decodeSpy).toHaveBeenCalledTimes(2);
  });
});

describe("humanReadablePrice", () => {
  it("scales by 10^quoteDecimals (SOL coin: 1e9 / 1e9 = 1.0)", () => {
    expect(humanReadablePrice(new BN("1000000000"), 9)).toBe(1.0);
    expect(humanReadablePrice(new BN("1500000"), 6)).toBe(1.5);
  });
});

describe("estimatePriceImpact", () => {
  it("returns ~1% impact for buying ~1% of market cap", () => {
    // Construct a curve where vTok == supply, so marketCap == vQuote.
    // Then 1% of marketCap == 1% of vQuote, and impact = dQuote/vQuote.
    const data: BondingCurveMarketData = {
      mint: PublicKey.default,
      quoteMint: NATIVE_MINT,
      quoteSymbol: "SOL",
      quoteDecimals: 9,
      virtualTokenReserves: new BN("1000000000000000"),
      virtualQuoteReserves: new BN("100000000000"),
      realTokenReserves: new BN("0"),
      realQuoteReserves: new BN("0"),
      tokenTotalSupply: new BN("1000000000000000"),
      circulatingSupply: new BN("0"),
      marketCapInQuote: new BN("100000000000"),
      pricePerTokenInQuote: new BN("100"),
      complete: false,
      isMayhemMode: false,
      isCashbackCoin: false,
      creator: PublicKey.default,
    };

    const onePctOfMarketCap = data.marketCapInQuote.divn(100);
    const impact = estimatePriceImpact(data, onePctOfMarketCap);
    expect(impact).toBeGreaterThan(0.95);
    expect(impact).toBeLessThan(1.05);
  });
});

describe("quoteToGraduation", () => {
  it("computes additional quote needed to drain real token reserves", () => {
    const vTok = new BN("1073000000000000");
    const real = new BN("793100000000000");
    const vQuote = new BN("30000000000");
    const data: BondingCurveMarketData = {
      mint: PublicKey.default,
      quoteMint: NATIVE_MINT,
      quoteSymbol: "SOL",
      quoteDecimals: 9,
      virtualTokenReserves: vTok,
      virtualQuoteReserves: vQuote,
      realTokenReserves: real,
      realQuoteReserves: new BN("0"),
      tokenTotalSupply: new BN("1000000000000000"),
      circulatingSupply: new BN("0"),
      marketCapInQuote: new BN("0"),
      pricePerTokenInQuote: new BN("0"),
      complete: false,
      isMayhemMode: false,
      isCashbackCoin: false,
      creator: PublicKey.default,
    };
    const expected = real.mul(vQuote).div(vTok.sub(real)).addn(1);
    expect(quoteToGraduation(data)?.toString()).toBe(expected.toString());
  });

  it("returns null for a completed curve", () => {
    const data: BondingCurveMarketData = {
      mint: PublicKey.default,
      quoteMint: NATIVE_MINT,
      quoteSymbol: "SOL",
      quoteDecimals: 9,
      virtualTokenReserves: new BN("1"),
      virtualQuoteReserves: new BN("1"),
      realTokenReserves: new BN("0"),
      realQuoteReserves: new BN("0"),
      tokenTotalSupply: new BN("1"),
      circulatingSupply: new BN("1"),
      marketCapInQuote: new BN("0"),
      pricePerTokenInQuote: new BN("0"),
      complete: true,
      isMayhemMode: false,
      isCashbackCoin: false,
      creator: PublicKey.default,
    };
    expect(quoteToGraduation(data)).toBeNull();
  });
});

describe("isNativeSolPair", () => {
  it("returns true for NATIVE_MINT and false for USDC", () => {
    const md = new PumpMarketData(fakeConnection());
    const sol: BondingCurveMarketData = {
      mint: PublicKey.default,
      quoteMint: NATIVE_MINT,
      quoteSymbol: "SOL",
      quoteDecimals: 9,
      virtualTokenReserves: new BN("1"),
      virtualQuoteReserves: new BN("1"),
      realTokenReserves: new BN("0"),
      realQuoteReserves: new BN("0"),
      tokenTotalSupply: new BN("1"),
      circulatingSupply: new BN("0"),
      marketCapInQuote: new BN("0"),
      pricePerTokenInQuote: new BN("0"),
      complete: false,
      isMayhemMode: false,
      isCashbackCoin: false,
      creator: PublicKey.default,
    };
    expect(md.isNativeSolPair(sol)).toBe(true);
    expect(md.isNativeSolPair({ ...sol, quoteMint: USDC_MINT })).toBe(false);
  });
});
