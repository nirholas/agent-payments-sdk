// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * PumpMarketData — real-time price & market cap for pump.fun coins.
 *
 * Handles both v1 (SOL-only) and v2 (multi-quote) bonding curves.
 * SOL prices are fetched from CoinGecko with a 60-second cache.
 * USDC-quoted coins skip the SOL price lookup entirely.
 */

import { BN } from "@coral-xyz/anchor";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  type AccountInfo,
  Connection,
  PublicKey,
} from "@solana/web3.js";
import {
  PUMP_SDK,
  bondingCurveMarketCap,
  bondingCurvePda,
  isLegacyQuoteMint,
} from "@pump-fun/pump-sdk";

// ─── Constants ────────────────────────────────────────────────────────────────

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const COIN_DECIMALS = 6;

// v1 bonding curves are 49 bytes (8-byte discriminator + 5 u64 fields + bool).
// v2 adds quoteMint + extra fields; account data is > 49 bytes.
const V1_CURVE_MAX_SIZE = 49;

// 85 SOL (in lamports) — the threshold at which a SOL-quoted bonding curve
// graduates to the AMM. Used to compute graduation progress percentage.
// For USDC-quoted coins we apply the same formula but units differ.
const GRADUATION_THRESHOLD = new BN(85_000_000_000);

const SOL_PRICE_CACHE_MS = 60_000;
const COINGECKO_SOL_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CoinPrice {
  mint: PublicKey;
  /** Price denominated in the coin's quote currency (SOL or USDC). */
  priceQuote: number;
  /** USD-equivalent price per token. */
  priceUsd: number;
  marketCapUsd: number;
  quoteMint: PublicKey;
  quoteSymbol: "SOL" | "USDC" | string;
  isV2: boolean;
  /** True once the bonding curve has graduated to the AMM. */
  complete: boolean;
  /** 0–100, based on realQuoteReserves vs 85-SOL graduation threshold. */
  graduationProgressPct: number;
  virtualTokenReserves: BN;
  virtualQuoteReserves: BN;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function resolveQuoteMint(quoteMintOnChain: PublicKey): PublicKey {
  if (!quoteMintOnChain || quoteMintOnChain.equals(PublicKey.default)) {
    return NATIVE_MINT;
  }
  return quoteMintOnChain;
}

function quoteDecimalsFor(quoteMint: PublicKey): number {
  return isLegacyQuoteMint(quoteMint) ? SOL_DECIMALS : USDC_DECIMALS;
}

function computeCoinPrice(
  mint: PublicKey,
  info: AccountInfo<Buffer>,
  solPriceUsd: number,
): CoinPrice {
  const curve = PUMP_SDK.decodeBondingCurve(info);

  // Data length distinguishes v1 (≤ 49 bytes) from v2 (> 49 bytes).
  const isV2 = info.data.length > V1_CURVE_MAX_SIZE;
  const quoteMint = resolveQuoteMint(curve.quoteMint);
  const isSOL = isLegacyQuoteMint(quoteMint);
  const quoteDecimals = quoteDecimalsFor(quoteMint);
  const quoteSymbol: CoinPrice["quoteSymbol"] = isSOL
    ? "SOL"
    : quoteMint.equals(USDC_MINT)
      ? "USDC"
      : quoteMint.toBase58();

  // price = (virtualQuoteReserves / 10^quoteDecimals) / (virtualTokenReserves / 10^coinDecimals)
  const priceQuote =
    curve.virtualTokenReserves.isZero()
      ? 0
      : curve.virtualQuoteReserves.toNumber() /
        Math.pow(10, quoteDecimals) /
        (curve.virtualTokenReserves.toNumber() / Math.pow(10, COIN_DECIMALS));

  const quotePriceUsd = isSOL ? solPriceUsd : 1.0;
  const priceUsd = priceQuote * quotePriceUsd;

  // bondingCurveMarketCap() → virtualQuoteReserves * tokenTotalSupply / virtualTokenReserves
  // Units: raw quote (lamports for SOL, micro-USDC for USDC)
  const mcRaw = bondingCurveMarketCap({
    mintSupply: curve.tokenTotalSupply,
    virtualQuoteReserves: curve.virtualQuoteReserves,
    virtualTokenReserves: curve.virtualTokenReserves,
  });
  const marketCapQuote = mcRaw.toNumber() / Math.pow(10, quoteDecimals);
  const marketCapUsd = marketCapQuote * quotePriceUsd;

  const graduationProgressPct = GRADUATION_THRESHOLD.isZero()
    ? 0
    : Math.min(
        100,
        (curve.realQuoteReserves.toNumber() /
          GRADUATION_THRESHOLD.toNumber()) *
          100,
      );

  return {
    mint,
    priceQuote,
    priceUsd,
    marketCapUsd,
    quoteMint,
    quoteSymbol,
    isV2,
    complete: curve.complete,
    graduationProgressPct,
    virtualTokenReserves: curve.virtualTokenReserves,
    virtualQuoteReserves: curve.virtualQuoteReserves,
  };
}

// ─── PumpMarketData ───────────────────────────────────────────────────────────

export class PumpMarketData {
  private solPriceCache: { price: number; ts: number } | null = null;

  constructor(private readonly connection: Connection) {}

  // ── getPrice ────────────────────────────────────────────────────────────────

  async getPrice(mint: PublicKey): Promise<CoinPrice> {
    const map = await this.getPrices([mint]);
    const result = map.get(mint.toBase58());
    if (!result) throw new Error(`Bonding curve not found for ${mint.toBase58()}`);
    return result;
  }

  // ── getPrices ───────────────────────────────────────────────────────────────

  /** Batch-fetches prices for multiple mints in a single RPC call. */
  async getPrices(mints: PublicKey[]): Promise<Map<string, CoinPrice>> {
    if (mints.length === 0) return new Map();

    const bcAddrs = mints.map((m) => bondingCurvePda(m));
    const [infos, solPrice] = await Promise.all([
      this.connection.getMultipleAccountsInfo(bcAddrs),
      this.getSolPrice(),
    ]);

    const result = new Map<string, CoinPrice>();
    for (let i = 0; i < mints.length; i++) {
      const info = infos[i];
      if (!info) continue;
      result.set(
        mints[i].toBase58(),
        computeCoinPrice(mints[i], info, solPrice),
      );
    }
    return result;
  }

  // ── getSolPrice ─────────────────────────────────────────────────────────────

  /** Returns the current SOL/USD price; caches for 60 seconds. */
  async getSolPrice(): Promise<number> {
    const now = Date.now();
    if (
      this.solPriceCache &&
      now - this.solPriceCache.ts < SOL_PRICE_CACHE_MS
    ) {
      return this.solPriceCache.price;
    }

    try {
      const resp = await fetch(COINGECKO_SOL_URL);
      if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
      const data = (await resp.json()) as { solana: { usd: number } };
      const price = data.solana.usd;
      this.solPriceCache = { price, ts: now };
      return price;
    } catch {
      // Fall back to last known price on error.
      if (this.solPriceCache) return this.solPriceCache.price;
      return 0;
    }
  }

  // ── subscribe ───────────────────────────────────────────────────────────────

  /** Subscribe to real-time price updates for a single mint. Returns unsubscribe fn. */
  subscribe(
    mint: PublicKey,
    callback: (price: CoinPrice) => void,
  ): () => void {
    const bcAddr = bondingCurvePda(mint);
    const id = this.connection.onAccountChange(bcAddr, (info) => {
      void this.getSolPrice().then((solPrice) => {
        const price = computeCoinPrice(
          mint,
          info as AccountInfo<Buffer>,
          solPrice,
        );
        callback(price);
      });
    });
    return () => void this.connection.removeAccountChangeListener(id);
  }

  /** Subscribe to real-time price updates for multiple mints. Returns unsubscribe fn. */
  subscribeMultiple(
    mints: PublicKey[],
    callback: (prices: Map<string, CoinPrice>) => void,
  ): () => void {
    const unsubs = mints.map((mint) => {
      const bcAddr = bondingCurvePda(mint);
      const id = this.connection.onAccountChange(bcAddr, (info) => {
        void this.getSolPrice().then((solPrice) => {
          const price = computeCoinPrice(
            mint,
            info as AccountInfo<Buffer>,
            solPrice,
          );
          callback(new Map([[mint.toBase58(), price]]));
        });
      });
      return () => void this.connection.removeAccountChangeListener(id);
    });
    return () => unsubs.forEach((u) => u());
  }
}
