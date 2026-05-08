/** Returned by buildChallenge — attach header to 402 response, pass memo back to client. */
export interface PaymentChallenge {
  header: string;
  memo: string;
  expiresAt: number;
}

/** Decoded from the X-Payment-Required header (base64 JSON). */
export interface EvmX402Requirements {
  scheme: "pump-agent-evm";
  agentMint: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  /** Solana vault address — used as destinationSolanaWallet in the bridge tx. */
  payTo: string;
  memo: string;
}

/** Proof attached as X-Payment header (base64 JSON). */
export interface EvmPaymentProof {
  scheme: "pump-agent-evm";
  chainId: number;
  txHash: `0x${string}`;
  quoteId: string;
  memo: string;
}

/** Shape of the /api/proxy/build-tx response. */
export interface BuiltPaymentTx {
  approval?: {
    to: string;
    data: string;
    value: string;
  };
  bridge: {
    to: string;
    data: string;
    value: string;
    chainId: number;
  };
}

/** Shape of the /api/proxy/quote response (subset we use). */
export interface CrossChainQuote {
  quoteId: string;
  fromChainId: number;
  fromToken: string;
  fromAmount: string;
  toAmountUsdc: string;
  estimatedUsd: number;
  bridgeFeeUsd: number;
  estimatedTimeSeconds: number;
  expiresAt: number;
}
