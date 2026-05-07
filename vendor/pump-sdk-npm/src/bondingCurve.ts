import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import { computeFeesBps, getFee } from "./fees";
import { BondingCurve, FeeConfig, Global } from "./state";
import { NATIVE_MINT } from "@solana/spl-token";

export function newBondingCurve(
  global: Global,
  quoteMint: PublicKey = PublicKey.default,
): BondingCurve {
  return {
    virtualTokenReserves: global.initialVirtualTokenReserves,
    virtualQuoteReserves: quoteMint
      ? quoteMint.equals(NATIVE_MINT) || quoteMint.equals(PublicKey.default)
        ? global.initialVirtualSolReserves
        : global.initialVirtualQuoteReserves
      : global.initialVirtualSolReserves,
    realTokenReserves: global.initialRealTokenReserves,
    realQuoteReserves: new BN(0),
    tokenTotalSupply: global.tokenTotalSupply,
    complete: false,
    creator: PublicKey.default,
    isMayhemMode: global.mayhemModeEnabled,
    isCashbackCoin: false,
    quoteMint: PublicKey.default,
  };
}

function getBuySolAmountFromTokenAmountQuote({
  minAmount,
  virtualTokenReserves,
  virtualQuoteReserves,
}: {
  minAmount: BN;
  virtualTokenReserves: BN;
  virtualQuoteReserves: BN;
}): BN {
  return minAmount
    .mul(virtualQuoteReserves)
    .div(virtualTokenReserves.sub(minAmount))
    .add(new BN(1));
}

function getBuyTokenAmountFromSolAmountQuote({
  inputAmount,
  virtualTokenReserves,
  virtualQuoteReserves,
}: {
  inputAmount: BN;
  virtualTokenReserves: BN;
  virtualQuoteReserves: BN;
}): BN {
  return inputAmount
    .mul(virtualTokenReserves)
    .div(virtualQuoteReserves.add(inputAmount));
}

function getSellSolAmountFromTokenAmountQuote({
  inputAmount,
  virtualTokenReserves,
  virtualQuoteReserves,
}: {
  inputAmount: BN;
  virtualTokenReserves: BN;
  virtualQuoteReserves: BN;
}): BN {
  return inputAmount
    .mul(virtualQuoteReserves)
    .div(virtualTokenReserves.add(inputAmount));
}

export function getBuyTokenAmountFromSolAmount({
  global,
  feeConfig,
  mintSupply,
  bondingCurve,
  amount,
}: {
  global: Global;
  feeConfig: FeeConfig | null;
  mintSupply: BN | null;
  bondingCurve: BondingCurve | null;
  amount: BN;
}): BN {
  if (amount.eq(new BN(0))) {
    return new BN(0);
  }

  let isNewBondingCurve = false;

  if (bondingCurve === null || mintSupply === null) {
    bondingCurve = newBondingCurve(global);
    mintSupply = global.tokenTotalSupply;
    isNewBondingCurve = true;
  }

  // migrated bonding curve
  if (bondingCurve.virtualTokenReserves.eq(new BN(0))) {
    return new BN(0);
  }

  const { virtualQuoteReserves, virtualTokenReserves } = bondingCurve;
  const { protocolFeeBps, creatorFeeBps } = computeFeesBps({
    global,
    feeConfig,
    mintSupply,
    virtualQuoteReserves,
    virtualTokenReserves,
  });

  const totalFeeBasisPoints = protocolFeeBps.add(
    isNewBondingCurve || !PublicKey.default.equals(bondingCurve.creator)
      ? creatorFeeBps
      : new BN(0),
  );

  const inputAmount = amount
    .subn(1)
    .muln(10_000)
    .div(totalFeeBasisPoints.addn(10_000));

  const tokensReceived = getBuyTokenAmountFromSolAmountQuote({
    inputAmount,
    virtualTokenReserves: bondingCurve.virtualTokenReserves,
    virtualQuoteReserves: bondingCurve.virtualQuoteReserves,
  });

  return BN.min(tokensReceived, bondingCurve.realTokenReserves);
}

export function getBuySolAmountFromTokenAmount({
  global,
  feeConfig,
  mintSupply,
  bondingCurve,
  amount,
}: {
  global: Global;
  feeConfig: FeeConfig | null;
  mintSupply: BN | null;
  bondingCurve: BondingCurve | null;
  amount: BN;
}): BN {
  if (amount.eq(new BN(0))) {
    return new BN(0);
  }

  let isNewBondingCurve = false;

  if (bondingCurve === null || mintSupply === null) {
    bondingCurve = newBondingCurve(global);
    mintSupply = global.tokenTotalSupply;
    isNewBondingCurve = true;
  }

  // migrated bonding curve
  if (bondingCurve.virtualTokenReserves.eq(new BN(0))) {
    return new BN(0);
  }

  const minAmount = BN.min(amount, bondingCurve.realTokenReserves);

  const solCost = getBuySolAmountFromTokenAmountQuote({
    minAmount,
    virtualTokenReserves: bondingCurve.virtualTokenReserves,
    virtualQuoteReserves: bondingCurve.virtualQuoteReserves,
  });

  return solCost.add(
    getFee({
      global,
      feeConfig,
      mintSupply,
      bondingCurve,
      amount: solCost,
      isNewBondingCurve,
    }),
  );
}

export function getSellSolAmountFromTokenAmount({
  global,
  feeConfig,
  mintSupply,
  bondingCurve,
  amount,
}: {
  global: Global;
  feeConfig: FeeConfig | null;
  mintSupply: BN;
  bondingCurve: BondingCurve;
  amount: BN;
}): BN {
  if (amount.eq(new BN(0))) {
    return new BN(0);
  }

  // migrated bonding curve
  if (bondingCurve.virtualTokenReserves.eq(new BN(0))) {
    return new BN(0);
  }

  const solCost = getSellSolAmountFromTokenAmountQuote({
    inputAmount: amount,
    virtualTokenReserves: bondingCurve.virtualTokenReserves,
    virtualQuoteReserves: bondingCurve.virtualQuoteReserves,
  });

  return solCost.sub(
    getFee({
      global,
      feeConfig,
      mintSupply,
      bondingCurve,
      amount: solCost,
      isNewBondingCurve: false,
    }),
  );
}

export function getStaticRandomFeeRecipient(): PublicKey {
  const randomIndex = Math.floor(Math.random() * CURRENT_FEE_RECIPIENTS.length);
  return new PublicKey(CURRENT_FEE_RECIPIENTS[randomIndex]);
}

const CURRENT_FEE_RECIPIENTS = [
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
  "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
  "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
  "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
  "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
];

export function getStaticRandomFeeRecipientForBuyback(): PublicKey {
  const randomIndex = Math.floor(
    Math.random() * CURRENT_FEE_RECIPIENTS_FOR_BUYBACK.length,
  );
  return new PublicKey(CURRENT_FEE_RECIPIENTS_FOR_BUYBACK[randomIndex]);
}

const CURRENT_FEE_RECIPIENTS_FOR_BUYBACK = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
];

export function bondingCurveMarketCap({
  mintSupply,
  virtualQuoteReserves,
  virtualTokenReserves,
}: {
  mintSupply: BN;
  virtualQuoteReserves: BN;
  virtualTokenReserves: BN;
}): BN {
  if (virtualTokenReserves.isZero()) {
    throw new Error("Division by zero: virtual token reserves cannot be zero");
  }
  return virtualQuoteReserves.mul(mintSupply).div(virtualTokenReserves);
}
