import BN from "bn.js";
import { FeeConfig, Fees, FeeTier, GlobalConfig } from "../types/sdk";
import { isPumpPool, poolMarketCap } from "./util";
import { PublicKey } from "@solana/web3.js";

export function computeFeesBps({
  globalConfig,
  feeConfig,
  creator,
  baseMintSupply,
  baseMint,
  baseReserve,
  quoteReserve,
  tradeSize,
}: {
  globalConfig: GlobalConfig;
  feeConfig: FeeConfig | null;
  creator: PublicKey;
  baseMintSupply: BN;
  baseMint: PublicKey;
  baseReserve: BN;
  quoteReserve: BN;
  tradeSize: BN;
}): Fees {
  if (feeConfig != null) {
    const marketCap = poolMarketCap({
      baseMintSupply,
      baseReserve,
      quoteReserve,
    });

    return getFees({
      feeConfig,
      isPumpPool: isPumpPool(baseMint, creator),
      marketCap,
      tradeSize,
    });
  }

  return {
    lpFeeBps: globalConfig.lpFeeBasisPoints,
    protocolFeeBps: globalConfig.protocolFeeBasisPoints,
    creatorFeeBps: globalConfig.coinCreatorFeeBasisPoints,
  };
}

/// rust reference: pump-fees::get_fees()
function getFees({
  feeConfig,
  isPumpPool,
  marketCap,
}: {
  feeConfig: FeeConfig;
  isPumpPool: boolean;
  marketCap: BN;
  tradeSize: BN;
}): Fees {
  if (isPumpPool) {
    return calculateFeeTier({
      feeTiers: feeConfig.feeTiers,
      marketCap,
    });
  } else {
    return feeConfig.flatFees;
  }
}

/// rust reference: pump-fees-math::calculate_fee_tier()
export function calculateFeeTier({
  feeTiers,
  marketCap,
}: {
  feeTiers: FeeTier[];
  marketCap: BN;
}): Fees {
  const firstTier = feeTiers[0];

  if (marketCap.lt(firstTier.marketCapLamportsThreshold)) {
    return firstTier.fees;
  }

  for (const tier of feeTiers.slice().reverse()) {
    if (marketCap.gte(tier.marketCapLamportsThreshold)) {
      return tier.fees;
    }
  }

  return firstTier.fees;
}

export function getFeeRecipient(
  globalConfig: GlobalConfig,
  isMayhemMode: boolean,
): PublicKey {
  if (isMayhemMode) {
    const feeRecipients = [
      globalConfig.reservedFeeRecipient,
      ...globalConfig.reservedFeeRecipients,
    ];
    return feeRecipients[Math.floor(Math.random() * feeRecipients.length)];
  } else {
    return globalConfig.protocolFeeRecipients[
      Math.floor(Math.random() * globalConfig.protocolFeeRecipients.length)
    ];
  }
}

export function getBuybackFeeRecipient(globalConfig: GlobalConfig): PublicKey {
  return globalConfig.buybackFeeRecipients[
    Math.floor(Math.random() * globalConfig.buybackFeeRecipients.length)
  ];
}
