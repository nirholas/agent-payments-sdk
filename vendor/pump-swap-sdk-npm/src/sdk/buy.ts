import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { RawMint } from "@solana/spl-token";
import { ceilDiv, fee } from "./util";
import { computeFeesBps } from "./fees";
import {
  BuyBaseInputResult,
  BuyQuoteInputResult,
  FeeConfig,
  GlobalConfig,
} from "../types/sdk";

export function buyBaseInput({
  base,
  slippage,
  baseReserve,
  quoteReserve,
  globalConfig,
  baseMintAccount,
  baseMint,
  coinCreator,
  creator,
  feeConfig,
}: {
  base: BN;
  slippage: number; // 1 => 1%
  baseReserve: BN;
  quoteReserve: BN;
  globalConfig: GlobalConfig;
  baseMintAccount: RawMint;
  baseMint: PublicKey;
  coinCreator: PublicKey;
  creator: PublicKey;
  feeConfig: FeeConfig | null;
}): BuyBaseInputResult {
  // -----------------------------------------------------
  // 1) Basic validations
  // -----------------------------------------------------
  if (baseReserve.isZero() || quoteReserve.isZero()) {
    throw new Error(
      "Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero.",
    );
  }
  if (base.gt(baseReserve)) {
    throw new Error("Cannot buy more base tokens than the pool reserves.");
  }

  // -----------------------------------------------------
  // 2) Calculate the raw quote needed (Raydium-like formula)
  //    quote_amount_in = ceil_div(quote_reserve * base, base_reserve - base)
  // -----------------------------------------------------
  const numerator = quoteReserve.mul(base);
  const denominator = baseReserve.sub(base);

  if (denominator.isZero()) {
    throw new Error("Pool would be depleted; denominator is zero.");
  }

  const quoteAmountIn = ceilDiv(numerator, denominator);

  // -----------------------------------------------------
  // 3) Calculate fees
  //    - LP Fee = floor((quoteAmountIn * lpFeeBps) / 10000)
  //    - Protocol Fee = floor((quoteAmountIn * protocolFeeBps) / 10000)
  // -----------------------------------------------------
  const {
    lpFeeBps,
    protocolFeeBps,
    creatorFeeBps: coinCreatorFeeBps,
  } = computeFeesBps({
    globalConfig,
    feeConfig,
    creator,
    baseMintSupply: new BN(baseMintAccount.supply.toString()),
    baseMint,
    baseReserve,
    quoteReserve,
    tradeSize: quoteAmountIn,
  });

  const lpFee = fee(quoteAmountIn, lpFeeBps);
  const protocolFee = fee(quoteAmountIn, protocolFeeBps);
  const coinCreatorFee = PublicKey.default.equals(coinCreator)
    ? new BN(0)
    : fee(quoteAmountIn, coinCreatorFeeBps);

  const totalQuote = quoteAmountIn
    .add(lpFee)
    .add(protocolFee)
    .add(coinCreatorFee);

  // -----------------------------------------------------
  // 4) Calculate maxQuote with slippage
  //    If slippage=1 => factor = (1 + 1/100) = 1.01
  // -----------------------------------------------------
  const precision = new BN(1_000_000_000); // For slippage calculations
  const slippageFactorFloat = (1 + slippage / 100) * 1_000_000_000;
  const slippageFactor = new BN(Math.floor(slippageFactorFloat));

  // maxQuote = totalQuote * slippageFactor / 1e9
  const maxQuote = totalQuote.mul(slippageFactor).div(precision);

  return {
    internalQuoteAmount: quoteAmountIn,
    uiQuote: totalQuote, // Final total quote after fees
    maxQuote,
  };
}

export function buyQuoteInput({
  quote,
  slippage,
  baseReserve,
  quoteReserve,
  globalConfig,
  baseMintAccount,
  baseMint,
  coinCreator,
  creator,
  feeConfig,
}: {
  quote: BN;
  slippage: number; // 1 => 1%
  baseReserve: BN;
  quoteReserve: BN;
  globalConfig: GlobalConfig;
  baseMintAccount: RawMint;
  baseMint: PublicKey;
  coinCreator: PublicKey;
  creator: PublicKey;
  feeConfig: FeeConfig | null;
}): BuyQuoteInputResult {
  // -----------------------------------------------------
  // 1) Basic validations
  // -----------------------------------------------------
  if (baseReserve.isZero() || quoteReserve.isZero()) {
    throw new Error(
      "Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero.",
    );
  }

  // -----------------------------------------------------
  // 2) Calculate fees total fee basis points and denominator
  // -----------------------------------------------------
  const {
    lpFeeBps,
    protocolFeeBps,
    creatorFeeBps: coinCreatorFeeBps,
  } = computeFeesBps({
    globalConfig,
    feeConfig,
    creator,
    baseMintSupply: new BN(baseMintAccount.supply.toString()),
    baseMint,
    baseReserve,
    quoteReserve,
    tradeSize: quote,
  });

  const totalFeeBps = lpFeeBps
    .add(protocolFeeBps)
    .add(PublicKey.default.equals(coinCreator) ? new BN(0) : coinCreatorFeeBps);
  const denominator = new BN(10_000).add(totalFeeBps);
  // -----------------------------------------------------
  // 3) Calculate effective quote amount
  // -----------------------------------------------------
  const effectiveQuote = quote.mul(new BN(10_000)).div(denominator);

  // -----------------------------------------------------
  // 4) Calculate the base tokens received using effectiveQuote
  //    base_amount_out = floor(base_reserve * effectiveQuote / (quote_reserve + effectiveQuote))
  // -----------------------------------------------------
  const numerator = baseReserve.mul(effectiveQuote);
  const denominatorEffective = quoteReserve.add(effectiveQuote);

  if (denominatorEffective.isZero()) {
    throw new Error("Pool would be depleted; denominator is zero.");
  }

  const baseAmountOut = numerator.div(denominatorEffective);

  // -----------------------------------------------------
  // 5) Calculate maxQuote with slippage
  //    If slippage=1 => factor = (1 + 1/100) = 1.01
  // -----------------------------------------------------
  const precision = new BN(1_000_000_000); // For slippage calculations
  const slippageFactorFloat = (1 + slippage / 100) * 1_000_000_000;
  const slippageFactor = new BN(Math.floor(slippageFactorFloat));

  // maxQuote = quote * slippageFactor / 1e9
  const maxQuote = quote.mul(slippageFactor).div(precision);

  return {
    base: baseAmountOut, // Base tokens received after fees
    internalQuoteWithoutFees: effectiveQuote,
    maxQuote, // Maximum quote tokens to pay (with slippage)
  };
}
