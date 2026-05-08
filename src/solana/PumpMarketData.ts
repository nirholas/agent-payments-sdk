import {
  type AccountInfo,
  type Commitment,
  type Connection,
  PublicKey,
} from "@solana/web3.js";
import { NATIVE_MINT, getMint } from "@solana/spl-token";
import BN from "bn.js";
import {
  PUMP_SDK,
  bondingCurveMarketCap,
  bondingCurvePda,
  type BondingCurve,
} from "@pump-fun/pump-sdk";

import { USDC_SOLANA_MINT } from "../constants.js";

const USDC_MINT = new PublicKey(USDC_SOLANA_MINT);

const PUMP_TOKEN_DECIMALS = 6;
const TOKEN_DECIMALS_SCALE = new BN(10).pow(new BN(PUMP_TOKEN_DECIMALS));

export interface BondingCurveMarketData {
  mint: PublicKey;
  quoteMint: PublicKey;
  quoteSymbol: string;
  quoteDecimals: number;
  virtualQuoteReserves: BN;
  virtualTokenReserves: BN;
  realQuoteReserves: BN;
  realTokenReserves: BN;
  tokenTotalSupply: BN;
  circulatingSupply: BN;
  marketCapInQuote: BN;
  pricePerTokenInQuote: BN;
  complete: boolean;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  creator: PublicKey;
}

interface QuoteMeta {
  symbol: string;
  decimals: number;
}

function isSolQuoteMint(quoteMint: PublicKey): boolean {
  return quoteMint.equals(NATIVE_MINT) || quoteMint.equals(PublicKey.default);
}

export class PumpMarketData {
  constructor(private readonly connection: Connection) {}

  async getBondingCurveData(mint: PublicKey): Promise<BondingCurveMarketData> {
    const pda = bondingCurvePda(mint);
    const accountInfo = await this.connection.getAccountInfo(pda);
    if (!accountInfo) {
      throw new Error(
        `Bonding curve not found for mint ${mint.toBase58()} (PDA ${pda.toBase58()})`,
      );
    }
    const bc = PUMP_SDK.decodeBondingCurve(accountInfo);
    const meta = await this.resolveQuoteMeta(bc.quoteMint);
    return buildMarketData(mint, bc, meta);
  }

  async getBondingCurveDataBatch(
    mints: PublicKey[],
  ): Promise<Map<string, BondingCurveMarketData | null>> {
    const result = new Map<string, BondingCurveMarketData | null>();
    if (mints.length === 0) return result;

    const pdas = mints.map((m) => bondingCurvePda(m));
    const accounts = await this.connection.getMultipleAccountsInfo(pdas);

    const decoded: Array<{ mint: PublicKey; bc: BondingCurve } | null> =
      accounts.map((ai, i) => {
        if (!ai) return null;
        try {
          return { mint: mints[i]!, bc: PUMP_SDK.decodeBondingCurve(ai) };
        } catch {
          return null;
        }
      });

    const quoteMints = new Set<string>();
    for (const d of decoded) {
      if (d) quoteMints.add(d.bc.quoteMint.toBase58());
    }
    const metaCache = new Map<string, QuoteMeta>();
    await Promise.all(
      Array.from(quoteMints).map(async (key) => {
        metaCache.set(key, await this.resolveQuoteMeta(new PublicKey(key)));
      }),
    );

    for (let i = 0; i < mints.length; i++) {
      const mint = mints[i]!;
      const d = decoded[i];
      if (!d) {
        result.set(mint.toBase58(), null);
        continue;
      }
      const meta = metaCache.get(d.bc.quoteMint.toBase58())!;
      result.set(mint.toBase58(), buildMarketData(mint, d.bc, meta));
    }
    return result;
  }

  subscribeToPriceUpdates(
    mint: PublicKey,
    onUpdate: (data: BondingCurveMarketData) => void,
    options?: { commitment?: Commitment },
  ): () => Promise<void> {
    const pda = bondingCurvePda(mint);
    let cachedMeta: QuoteMeta | undefined;
    let cachedQuoteMint: string | undefined;

    const subId = this.connection.onAccountChange(
      pda,
      (accountInfo: AccountInfo<Buffer>) => {
        void (async () => {
          try {
            const bc = PUMP_SDK.decodeBondingCurve(accountInfo);
            const quoteKey = bc.quoteMint.toBase58();
            if (!cachedMeta || cachedQuoteMint !== quoteKey) {
              cachedMeta = await this.resolveQuoteMeta(bc.quoteMint);
              cachedQuoteMint = quoteKey;
            }
            onUpdate(buildMarketData(mint, bc, cachedMeta));
          } catch {
            // swallow per-update errors so the subscription remains alive
          }
        })();
      },
      options?.commitment,
    );

    return async () => {
      await this.connection.removeAccountChangeListener(subId);
    };
  }

  isNativeSolPair(data: BondingCurveMarketData): boolean {
    return isSolQuoteMint(data.quoteMint);
  }

  private async resolveQuoteMeta(quoteMint: PublicKey): Promise<QuoteMeta> {
    if (isSolQuoteMint(quoteMint)) return { symbol: "SOL", decimals: 9 };
    if (quoteMint.equals(USDC_MINT)) return { symbol: "USDC", decimals: 6 };
    const info = await getMint(this.connection, quoteMint);
    return {
      symbol: quoteMint.toBase58().slice(0, 8),
      decimals: info.decimals,
    };
  }
}

function buildMarketData(
  mint: PublicKey,
  bc: BondingCurve,
  meta: QuoteMeta,
): BondingCurveMarketData {
  const marketCapInQuote = bondingCurveMarketCap({
    mintSupply: bc.tokenTotalSupply,
    virtualQuoteReserves: bc.virtualQuoteReserves,
    virtualTokenReserves: bc.virtualTokenReserves,
  });
  const pricePerTokenInQuote = bc.virtualQuoteReserves
    .mul(TOKEN_DECIMALS_SCALE)
    .div(bc.virtualTokenReserves);
  const circulatingSupply = bc.tokenTotalSupply.sub(bc.realTokenReserves);

  return {
    mint,
    quoteMint: bc.quoteMint,
    quoteSymbol: meta.symbol,
    quoteDecimals: meta.decimals,
    virtualQuoteReserves: bc.virtualQuoteReserves,
    virtualTokenReserves: bc.virtualTokenReserves,
    realQuoteReserves: bc.realQuoteReserves,
    realTokenReserves: bc.realTokenReserves,
    tokenTotalSupply: bc.tokenTotalSupply,
    circulatingSupply,
    marketCapInQuote,
    pricePerTokenInQuote,
    complete: bc.complete,
    isMayhemMode: bc.isMayhemMode,
    isCashbackCoin: bc.isCashbackCoin,
    creator: bc.creator,
  };
}

/**
 * Convert pricePerTokenInQuote to a human-readable number of quote units per
 * whole token. For SOL: divide by 1e9. For USDC: divide by 1e6.
 *
 * Display only — JS numbers lose precision past ~2^53.
 */
export function humanReadablePrice(
  pricePerTokenInQuote: BN,
  quoteDecimals: number,
): number {
  return (
    Number(pricePerTokenInQuote.toString()) / Math.pow(10, quoteDecimals)
  );
}

/**
 * Estimate the average price impact (slippage) of a buy that pays
 * `quoteAmount` to the curve, expressed as a percent.
 *
 * Average effective price = (vQuote + dQuote) / vTok; spot price = vQuote/vTok;
 * impact = dQuote / vQuote.
 */
export function estimatePriceImpact(
  data: BondingCurveMarketData,
  quoteAmount: BN,
): number {
  if (data.virtualQuoteReserves.isZero()) return 0;
  const vQuote = Number(data.virtualQuoteReserves.toString());
  const dQuote = Number(quoteAmount.toString());
  if (vQuote === 0) return 0;
  return (dQuote / vQuote) * 100;
}

/**
 * Returns the additional quote needed to drain all `realTokenReserves`
 * (graduating the curve). Returns `null` if the curve is already complete or
 * has no real tokens remaining.
 */
export function quoteToGraduation(data: BondingCurveMarketData): BN | null {
  if (data.complete) return null;
  if (data.realTokenReserves.isZero()) return null;
  const denominator = data.virtualTokenReserves.sub(data.realTokenReserves);
  if (denominator.lten(0)) return null;
  return data.realTokenReserves
    .mul(data.virtualQuoteReserves)
    .div(denominator)
    .addn(1);
}
