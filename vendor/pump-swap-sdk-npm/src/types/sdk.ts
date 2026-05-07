import BN from "bn.js";
import { AccountInfo, PublicKey } from "@solana/web3.js";
import { RawAccount, RawMint } from "@solana/spl-token";

export interface DepositBaseResult {
  quote: BN;
  lpToken: BN;
  maxBase: BN;
  maxQuote: BN;
}

export interface DepositQuoteAndLpTokenFromBaseResult {
  quote: BN;
  lpToken: BN;
}

export interface DepositQuoteResult {
  base: BN;
  lpToken: BN;
  maxBase: BN;
  maxQuote: BN;
}

export interface DepositBaseAndLpTokenFromQuoteResult {
  base: BN;
  lpToken: BN;
}

export interface DepositResult {
  token1: BN;
  lpToken: BN;
  maxToken0: BN;
  maxToken1: BN;
}

export interface DepositLpTokenResult {
  maxBase: BN;
  maxQuote: BN;
}

export interface WithdrawResult {
  base: BN;
  quote: BN;
  minBase: BN;
  minQuote: BN;
}

export interface WithdrawAutocompleteResult {
  base: BN;
  quote: BN;
}

export interface BuyBaseInputResult {
  internalQuoteAmount: BN;

  /**
   * The total amount of quote tokens required to buy `base` tokens,
   * including LP fee and protocol fee.
   */
  uiQuote: BN;

  /**
   * The maximum quote tokens that you are willing to pay,
   * given the specified slippage tolerance.
   */
  maxQuote: BN;
}

export interface BuyQuoteInputResult {
  /**
   * The amount of base tokens received after fees.
   */
  base: BN;

  internalQuoteWithoutFees: BN;

  /**
   * The maximum quote tokens that you are willing to pay,
   * given the specified slippage tolerance.
   */
  maxQuote: BN;
}

export interface SellBaseInputResult {
  /**
   * The final amount of quote tokens the user receives (after subtracting LP and protocol fees).
   */
  uiQuote: BN;

  /**
   * The minimum quote tokens the user is willing to receive,
   * given their slippage tolerance.
   */
  minQuote: BN;
  internalQuoteAmountOut: BN;
}

export interface SellQuoteInputResult {
  internalRawQuote: BN;
  base: BN;
  minQuote: BN;
}

export interface Pool {
  poolBump: number;
  index: number;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: BN;
  coinCreator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
}

export interface GlobalConfig {
  admin: PublicKey;
  lpFeeBasisPoints: BN;
  protocolFeeBasisPoints: BN;
  disableFlags: number;
  protocolFeeRecipients: PublicKey[];
  coinCreatorFeeBasisPoints: BN;
  adminSetCoinCreatorAuthority: PublicKey;
  whitelistPda: PublicKey;
  reservedFeeRecipient: PublicKey;
  mayhemModeEnabled: boolean;
  reservedFeeRecipients: PublicKey[];
  buybackFeeRecipients: PublicKey[];
  buybackBasisPoints: BN;
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
}

export interface SwapAccounts {
  pool: PublicKey;
  globalConfig: PublicKey;
  user: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  userBaseTokenAccount: PublicKey;
  userQuoteTokenAccount: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  protocolFeeRecipient: PublicKey;
  protocolFeeRecipientTokenAccount: PublicKey;
  buybackFeeRecipient: PublicKey;
  buybackFeeRecipientTokenAccount: PublicKey;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  systemProgram: PublicKey;
  associatedTokenProgram: PublicKey;
  eventAuthority: PublicKey;
  program: PublicKey;
  coinCreatorVaultAta: PublicKey;
  coinCreatorVaultAuthority: PublicKey;
}

export interface LiquidityAccounts {
  pool: PublicKey;
  globalConfig: PublicKey;
  user: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  userBaseTokenAccount: PublicKey;
  userQuoteTokenAccount: PublicKey;
  userPoolTokenAccount: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  tokenProgram: PublicKey;
  token2022Program: PublicKey;
  eventAuthority: PublicKey;
  program: PublicKey;
}

export interface CommonSolanaState {
  poolKey: PublicKey;
  poolAccountInfo: AccountInfo<Buffer> | null;
  user: PublicKey;
}

export interface CreatePoolSolanaState {
  index: number;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  creator: PublicKey;
  globalConfig: GlobalConfig;
  poolKey: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  userBaseTokenAccount: PublicKey;
  userQuoteTokenAccount: PublicKey;
  userBaseAccountInfo: AccountInfo<Buffer> | null;
  userQuoteAccountInfo: AccountInfo<Buffer> | null;
  poolBaseAccountInfo: AccountInfo<Buffer> | null;
  poolQuoteAccountInfo: AccountInfo<Buffer> | null;
}

export interface SwapSolanaState {
  globalConfig: GlobalConfig;
  feeConfig: FeeConfig | null;
  poolKey: PublicKey;
  poolAccountInfo: AccountInfo<Buffer> | null;
  pool: Pool;
  poolBaseAmount: BN;
  poolQuoteAmount: BN;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  baseMint: PublicKey;
  baseMintAccount: RawMint;
  user: PublicKey;
  userBaseTokenAccount: PublicKey;
  userQuoteTokenAccount: PublicKey;
  userBaseAccountInfo: AccountInfo<Buffer> | null;
  userQuoteAccountInfo: AccountInfo<Buffer> | null;
}

export interface LiquiditySolanaState {
  globalConfig: GlobalConfig;
  poolKey: PublicKey;
  poolAccountInfo: AccountInfo<Buffer>;
  pool: Pool;
  poolBaseTokenAccount: RawAccount;
  poolQuoteTokenAccount: RawAccount;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  user: PublicKey;
  userBaseTokenAccount: PublicKey;
  userQuoteTokenAccount: PublicKey;
  userPoolTokenAccount: PublicKey;
  userBaseAccountInfo: AccountInfo<Buffer> | null;
  userQuoteAccountInfo: AccountInfo<Buffer> | null;
  userPoolAccountInfo: AccountInfo<Buffer> | null;
}

export interface CollectCoinCreatorFeeSolanaState {
  coinCreator: PublicKey;
  quoteMint: PublicKey;
  quoteTokenProgram: PublicKey;
  coinCreatorVaultAuthority: PublicKey;
  coinCreatorVaultAta: PublicKey;
  coinCreatorTokenAccount: PublicKey;
  coinCreatorVaultAtaAccountInfo: AccountInfo<Buffer> | null;
  coinCreatorTokenAccountInfo: AccountInfo<Buffer> | null;
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
