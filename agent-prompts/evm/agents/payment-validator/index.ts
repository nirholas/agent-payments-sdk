export {
  // Core functions
  decodeAndValidateHeader,
  validatePayment,
  buildChallenge,
  isExpired,

  // Error types
  InvalidSchemeError,
  MemoMismatchError,
  InsufficientAmountError,
  DepositNotFoundError,
  SolanaArrivalTimeoutError,

  // Chain helpers re-exported for convenience
  EVM_CHAINS,
  SUPPORTED_CHAIN_IDS,
} from "./validator.js";

export type {
  EvmPaymentProof,
  ValidationResult,
  ValidatePaymentParams,
  BuildChallengeOpts,
} from "./validator.js";

export { createEvmPaymentMiddleware } from "./middleware.js";
export type { EvmPaymentMiddlewareOpts } from "./middleware.js";
