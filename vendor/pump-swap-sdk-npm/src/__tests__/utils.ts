import BN from "bn.js";
import { GlobalConfig, FeeConfig, Fees } from "../types/sdk";

export function createFeeConfigFromGlobalConfig(
  globalConfig: GlobalConfig,
): FeeConfig {
  let fees: Fees = {
    lpFeeBps: globalConfig.lpFeeBasisPoints,
    protocolFeeBps: globalConfig.protocolFeeBasisPoints,
    creatorFeeBps: globalConfig.coinCreatorFeeBasisPoints,
  };
  return {
    admin: globalConfig.admin,
    flatFees: fees,
    feeTiers: [
      {
        marketCapLamportsThreshold: new BN(0),
        fees,
      },
    ],
  };
}
