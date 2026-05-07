import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { RawMint } from "@solana/spl-token";
import { ceilDiv, fee } from "./util";
import { computeFeesBps } from "./fees";
import {
  GlobalConfig,
  FeeConfig,
  SellBaseInputResult,
  SellQuoteInputResult,
} from "../types/sdk";

export function sellBaseInput({
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
  slippage: number; // e.g. 1 => 1% slippage tolerance
  baseReserve: BN;
  quoteReserve: BN;
  globalConfig: GlobalConfig;
  baseMintAccount: RawMint;
  baseMint: PublicKey;
  coinCreator: PublicKey;
  creator: PublicKey;
  feeConfig: FeeConfig | null;
}): SellBaseInputResult {
  // -----------------------------------------
  // 1) Basic validations
  // -----------------------------------------
  if (baseReserve.isZero() || quoteReserve.isZero()) {
    throw new Error(
      "Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero.",
    );
  }

  // -----------------------------------------
  // 2) Calculate the raw quote output (no fees)
  //    This matches a typical constant-product formula for selling base to get quote:
  //      quote_amount_out = floor( (quoteReserve * base) / (baseReserve + base) )
  // -----------------------------------------
  const quoteAmountOut = quoteReserve.mul(base).div(baseReserve.add(base)); // floor by BN.div

  // -----------------------------------------
  // 3) Calculate fees
  //    LP fee and protocol fee are both taken from 'quoteAmountOut'
  // -----------------------------------------
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
    tradeSize: quoteAmountOut,
  });

  const lpFee = fee(quoteAmountOut, lpFeeBps);
  const protocolFee = fee(quoteAmountOut, protocolFeeBps);
  const coinCreatorFee = PublicKey.default.equals(coinCreator)
    ? new BN(0)
    : fee(quoteAmountOut, coinCreatorFeeBps);

  // Subtract fees to get the actual user receive
  const finalQuote = quoteAmountOut
    .sub(lpFee)
    .sub(protocolFee)
    .sub(coinCreatorFee);
  if (finalQuote.isNeg()) {
    // Theoretically shouldn't happen unless fees exceed quoteAmountOut
    throw new Error("Fees exceed total output; final quote is negative.");
  }

  // -----------------------------------------
  // 4) Calculate minQuote with slippage
  //    - If slippage=1 => 1%, we allow receiving as low as 99% of finalQuote
  // -----------------------------------------
  const precision = new BN(1_000_000_000); // For safe integer math
  // (1 - slippage/100) => e.g. slippage=1 => factor= 0.99
  const slippageFactorFloat = (1 - slippage / 100) * 1_000_000_000;
  const slippageFactor = new BN(Math.floor(slippageFactorFloat));

  // minQuote = finalQuote * (1 - slippage/100)
  const minQuote = finalQuote.mul(slippageFactor).div(precision);

  return {
    uiQuote: finalQuote, // actual tokens user receives after fees
    minQuote, // minimum acceptable tokens after applying slippage
    internalQuoteAmountOut: quoteAmountOut,
  };
}

const MAX_FEE_BASIS_POINTS = new BN(10_000); // Assuming MAX_FEE_BASIS_POINTS is 10,000 (100%)

function calculateQuoteAmountOut(
  userQuoteAmountOut: BN,
  lpFeeBasisPoints: BN,
  protocolFeeBasisPoints: BN,
  coinCreatorFeeBasisPoints: BN,
): BN {
  // Calculate the total fee basis points
  const totalFeeBasisPoints = lpFeeBasisPoints
    .add(protocolFeeBasisPoints)
    .add(coinCreatorFeeBasisPoints);
  // Calculate the denominator
  const denominator = MAX_FEE_BASIS_POINTS.sub(totalFeeBasisPoints);
  // Calculate the quote_amount_out
  return ceilDiv(userQuoteAmountOut.mul(MAX_FEE_BASIS_POINTS), denominator);
}

export function sellQuoteInput({
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
  slippage: number; // e.g. 1 => 1% slippage tolerance
  baseReserve: BN;
  quoteReserve: BN;
  globalConfig: GlobalConfig;
  baseMintAccount: RawMint;
  baseMint: PublicKey;
  coinCreator: PublicKey;
  creator: PublicKey;
  feeConfig: FeeConfig | null;
}): SellQuoteInputResult {
  // -----------------------------------------
  // 1) Basic validations
  // -----------------------------------------
  if (baseReserve.isZero() || quoteReserve.isZero()) {
    throw new Error(
      "Invalid input: 'baseReserve' or 'quoteReserve' cannot be zero.",
    );
  }
  if (quote.gt(quoteReserve)) {
    throw new Error(
      "Cannot receive more quote tokens than the pool quote reserves.",
    );
  }

  // -----------------------------------------
  // 2) Calculate the fees included in the quote
  // -----------------------------------------
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

  const rawQuote = calculateQuoteAmountOut(
    quote,
    lpFeeBps,
    protocolFeeBps,
    PublicKey.default.equals(coinCreator) ? new BN(0) : coinCreatorFeeBps,
  );

  // -----------------------------------------
  // 3) Calculate the base amount needed for the raw quote output
  //    Invert the constant product formula:
  //    base_amount_in = ceil((baseReserve * rawQuote) / (quoteReserve - rawQuote))
  // -----------------------------------------
  if (rawQuote.gte(quoteReserve)) {
    throw new Error(
      "Invalid input: Desired quote amount exceeds available reserve.",
    );
  }

  const baseAmountIn = ceilDiv(
    baseReserve.mul(rawQuote),
    quoteReserve.sub(rawQuote),
  );

  // -----------------------------------------
  // 4) Calculate minQuote with slippage
  //    - If slippage=1 => 1%, we allow receiving as low as 99% of the desired quote
  // -----------------------------------------
  const precision = new BN(1_000_000_000); // For slippage calculations
  const slippageFactorFloat = (1 - slippage / 100) * 1_000_000_000;
  const slippageFactor = new BN(Math.floor(slippageFactorFloat));

  const minQuote = quote.mul(slippageFactor).div(precision);

  return {
    internalRawQuote: rawQuote,
    base: baseAmountIn, // amount of base tokens required to get the desired quote
    minQuote, // minimum acceptable tokens after applying slippage
  };
}
