/**
 * PumpTradeClient — v2 trading client for the pump.fun bonding curve program.
 *
 * Routes buy/sell/exact-quote-in/cashback operations to the correct v2
 * instructions and resolves the quote mint (SOL or USDC) automatically by
 * reading the on-chain `BondingCurve` account.
 *
 * NOTE: This is a stub surface. The full implementation lands via the
 * companion PR ("Prompt A"). The shape here is intentionally minimal so
 * that the v2 solana-agent-kit actions can compile and be unit-tested with
 * mocks. Once the companion PR merges, this file is replaced wholesale.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);

export interface BuildBuyParams {
  mint: PublicKey;
  quoteAmount: BN;
  slippagePct?: number;
}

export interface BuildSellParams {
  mint: PublicKey;
  baseAmount: BN;
  slippagePct?: number;
}

export interface BuildBuyExactQuoteInParams {
  mint: PublicKey;
  spendableQuoteIn: BN;
  minBaseOut: BN;
}

export interface BuildClaimCashbackParams {
  quoteMint?: PublicKey;
}

export interface BuildBuyResult {
  instructions: TransactionInstruction[];
  quoteMint: PublicKey;
  expectedBaseTokens: BN;
}

export interface BuildSellResult {
  instructions: TransactionInstruction[];
  quoteMint: PublicKey;
  expectedQuoteOut: BN;
}

export interface BuildBuyExactQuoteInResult {
  instructions: TransactionInstruction[];
  quoteMint: PublicKey;
}

export interface BuildClaimCashbackResult {
  instructions: TransactionInstruction[];
  quoteMint: PublicKey;
}

export interface CreateV2AndBuyV2InstructionsParams {
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
  user: PublicKey;
  amount: BN;
  quoteAmount: BN;
  mayhemMode: boolean;
  cashback?: boolean;
  quoteMint?: PublicKey;
}

/**
 * Minimal facade for the `@pump-fun/pump-sdk` `PUMP_SDK` singleton's
 * `createV2AndBuyV2Instructions` method. Replaced wholesale by Prompt A's PR.
 */
export const PUMP_SDK = {
  async createV2AndBuyV2Instructions(
    _params: CreateV2AndBuyV2InstructionsParams,
  ): Promise<TransactionInstruction[]> {
    throw new Error(
      "PUMP_SDK.createV2AndBuyV2Instructions is a stub — companion PR (Prompt A) provides the implementation.",
    );
  },
};

export class PumpTradeClient {
  constructor(
    public readonly connection: Connection,
    public readonly wallet: Keypair | { publicKey: PublicKey },
  ) {}

  async buildBuyInstructions(_params: BuildBuyParams): Promise<BuildBuyResult> {
    throw new Error(
      "PumpTradeClient.buildBuyInstructions is a stub — companion PR (Prompt A) provides the implementation.",
    );
  }

  async buildSellInstructions(
    _params: BuildSellParams,
  ): Promise<BuildSellResult> {
    throw new Error(
      "PumpTradeClient.buildSellInstructions is a stub — companion PR (Prompt A) provides the implementation.",
    );
  }

  async buildBuyExactQuoteInInstructions(
    _params: BuildBuyExactQuoteInParams,
  ): Promise<BuildBuyExactQuoteInResult> {
    throw new Error(
      "PumpTradeClient.buildBuyExactQuoteInInstructions is a stub — companion PR (Prompt A) provides the implementation.",
    );
  }

  async buildClaimCashbackInstructions(
    _params: BuildClaimCashbackParams,
  ): Promise<BuildClaimCashbackResult[]> {
    throw new Error(
      "PumpTradeClient.buildClaimCashbackInstructions is a stub — companion PR (Prompt A) provides the implementation.",
    );
  }
}
