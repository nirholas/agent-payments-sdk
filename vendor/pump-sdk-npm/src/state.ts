import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/**
 * Platform identifiers for social handle mappings.
 */
export enum Platform {
  Pump = 0,
  X = 1,
  GitHub = 2,
  // Google = 3,
  // Discord = 4,
  // Reddit = 5,
  // TikTok = 6,
  // Youtube = 7,
  // Twitch = 8,
  // LinkedIn = 9,
  // Facebook = 10,
  // Instagram = 11,
  // Snapchat = 12,
  // Telegram = 13,
  // WhatsApp = 14,
  // Threads = 15,
}

export const stringToPlatform = (value: string): Platform => {
  const normalized = value.trim().toUpperCase();
  const entry = Object.entries(Platform).find(
    ([key, val]) => typeof val === "number" && key.toUpperCase() === normalized,
  );
  if (entry) {
    return entry[1] as Platform;
  }
  const validNames = Object.entries(Platform)
    .filter(([, val]) => typeof val === "number")
    .map(([key]) => key.toUpperCase())
    .join(", ");
  throw new Error(
    `Unknown platform "${value}". Expected one of: ${validNames}`,
  );
};

export const platformToString = (platform: Platform): string => {
  const name = Platform[platform];
  if (name !== undefined) {
    return name;
  }
  throw new Error(`Unknown platform value: ${platform}`);
};

export interface Global {
  // unused
  initialized: boolean;
  authority: PublicKey;
  feeRecipient: PublicKey;
  initialVirtualTokenReserves: BN;
  initialVirtualSolReserves: BN;
  initialRealTokenReserves: BN;
  tokenTotalSupply: BN;
  feeBasisPoints: BN;
  withdrawAuthority: PublicKey;
  // Unused
  enableMigrate: boolean;
  poolMigrationFee: BN;
  creatorFeeBasisPoints: BN;
  feeRecipients: PublicKey[];
  setCreatorAuthority: PublicKey;
  adminSetCreatorAuthority: PublicKey;
  createV2Enabled: boolean;
  whitelistPda: PublicKey;
  reservedFeeRecipient: PublicKey;
  mayhemModeEnabled: boolean;
  reservedFeeRecipients: PublicKey[];
  isCashbackEnabled: boolean;
  buybackFeeRecipients: PublicKey[];
  buybackBasisPoints: BN;
  initialVirtualQuoteReserves: BN;
  whitelistedQuoteMints: PublicKey[];
}

export interface BondingCurve {
  virtualTokenReserves: BN;
  virtualQuoteReserves: BN;
  realTokenReserves: BN;
  realQuoteReserves: BN;
  tokenTotalSupply: BN;
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: PublicKey;
}

export interface GlobalVolumeAccumulator {
  startTime: BN;
  endTime: BN;
  secondsInADay: BN;
  mint: PublicKey;
  totalTokenSupply: BN[];
  solVolumes: BN[];
}

export interface UserVolumeAccumulator {
  user: PublicKey;
  needsClaim: boolean;
  totalUnclaimedTokens: BN;
  totalClaimedTokens: BN;
  currentSolVolume: BN;
  lastUpdateTimestamp: BN;
  hasTotalClaimedTokens: boolean;
  cashbackEarned: BN;
  totalCashbackClaimed: BN;
}

export interface UserVolumeAccumulatorTotalStats {
  totalUnclaimedTokens: BN;
  totalClaimedTokens: BN;
  currentSolVolume: BN;
}

export interface FeeConfig {
  admin: PublicKey;
  flatFees: Fees;
  feeTiers: FeeTier[];
}

export interface FeeTier {
  marketCapLamportsThreshold: BN;
  fees: Fees;
}

export interface Fees {
  lpFeeBps: BN;
  protocolFeeBps: BN;
  creatorFeeBps: BN;
}

export interface Shareholder {
  address: PublicKey;
  shareBps: number;
}

export interface SharingConfig {
  version: number;
  mint: PublicKey;
  admin: PublicKey;
  adminRevoked: boolean;
  shareholders: Shareholder[];
}

export interface DistributeCreatorFeesEvent {
  timestamp: BN;
  mint: PublicKey;
  sharingConfig: PublicKey;
  admin: PublicKey;
  shareholders: Shareholder[];
  distributed: BN;
}

export interface MinimumDistributableFeeEvent {
  minimumRequired: BN;
  distributableFees: BN;
  canDistribute: boolean;
}

export interface SocialFeePda {
  bump: number;
  version: number;
  userId: string;
  platform: number;
  totalClaimed: BN;
  lastClaimed: BN;
}

export interface SocialFeePdaClaimedEvent {
  timestamp: BN;
  userId: string;
  platform: number;
  socialFeePda: PublicKey;
  recipient: PublicKey;
  socialClaimAuthority: PublicKey;
  amountClaimed: BN;
  claimableBefore: BN;
  lifetimeClaimed: BN;
  recipientBalanceBefore: BN;
  recipientBalanceAfter: BN;
}

export interface SocialFeePdaCreatedEvent {
  timestamp: BN;
  userId: string;
  platform: number;
  socialFeePda: PublicKey;
  createdBy: PublicKey;
}

export interface DonationFeePda {
  bump: number;
  version: number;
  configId: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  creator: PublicKey;
  totalDonated: BN;
  lastCrankTs: BN;
  reserved: number[];
}
