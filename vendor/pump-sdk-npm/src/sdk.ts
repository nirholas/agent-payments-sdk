import { AnchorProvider, Program } from "@coral-xyz/anchor";
import {
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
} from "@pump-fun/pump-swap-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AccountInfo,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { PumpAgentOffline } from "@pump-fun/agent-payments-sdk";
import BN from "bn.js";

import {
  getStaticRandomFeeRecipient,
  getStaticRandomFeeRecipientForBuyback,
} from "./bondingCurve";
import {
  NoShareholdersError,
  TooManyShareholdersError,
  ZeroShareError,
  InvalidShareTotalError,
  DuplicateShareholderError,
} from "./errors";
import { getFeeRecipient } from "./fees";
import { Pump } from "./idl/pump";
import pumpIdl from "./idl/pump.json";
import { PumpAmm } from "./idl/pump_amm";
import PumpAmmIdl from "./idl/pump_amm.json";
import { PumpFees } from "./idl/pump_fees";
import PumpFeesIdl from "./idl/pump_fees.json";
import { OFFLINE_PUMP_PROGRAM } from "./onlineSdk";
import {
  bondingCurvePda,
  canonicalPumpPoolPda,
  creatorVaultPda,
  donationFeePda,
  donationRelayDebouncerPda,
  donationRelayEpochTrackerPda,
  donationRelayEventAuthorityPda,
  donationRelayMintWhitelistPda,
  getGlobalParamsPda,
  getMayhemStatePda,
  getSolVaultPda,
  getTokenVaultPda,
  pumpPoolAuthorityPda,
  feeSharingConfigPda,
  socialFeePda,
  userVolumeAccumulatorPda,
  bondingCurveV2Pda,
  quoteAta,
  isLegacyQuoteMint,
  getEventAuthorityPda,
  canonicalPumpPoolPdaWithQuote,
} from "./pda";
import {
  BondingCurve,
  DonationFeePda as DonationFeePdaState,
  FeeConfig,
  Global,
  GlobalVolumeAccumulator,
  UserVolumeAccumulator,
  Shareholder,
  SharingConfig,
  DistributeCreatorFeesEvent,
  MinimumDistributableFeeEvent,
  SocialFeePda as SocialFeePdaState,
  SocialFeePdaClaimedEvent,
  SocialFeePdaCreatedEvent,
} from "./state";

export function getPumpProgram(connection: Connection): Program<Pump> {
  return new Program(
    pumpIdl as Pump,
    new AnchorProvider(connection, null as any, {}),
  );
}

export const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);

export function getPumpAmmProgram(connection: Connection): Program<PumpAmm> {
  return new Program(
    PumpAmmIdl as PumpAmm,
    new AnchorProvider(connection, null as any, {}),
  );
}

export function getPumpFeeProgram(connection: Connection): Program<PumpFees> {
  return new Program(
    PumpFeesIdl as PumpFees,
    new AnchorProvider(connection, null as any, {}),
  );
}

export const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
);

export const MAYHEM_PROGRAM_ID = new PublicKey(
  "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e",
);

export const PUMP_FEE_PROGRAM_ID = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);

export const BONDING_CURVE_NEW_SIZE = 151;

export const PUMP_TOKEN_MINT = new PublicKey(
  "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
);

export const MAX_SHAREHOLDERS = 10;

export class PumpSdk {
  private readonly offlinePumpProgram: Program<Pump>;
  private readonly offlinePumpFeeProgram: Program<PumpFees>;
  private readonly offlinePumpAmmProgram: Program<PumpAmm>;

  constructor() {
    this.offlinePumpProgram = OFFLINE_PUMP_PROGRAM;
    // Create offline programs for fee and AMM
    this.offlinePumpFeeProgram = new Program(
      PumpFeesIdl as PumpFees,
      new AnchorProvider(null as any, null as any, {}),
    );
    this.offlinePumpAmmProgram = new Program(
      PumpAmmIdl as PumpAmm,
      new AnchorProvider(null as any, null as any, {}),
    );
  }

  decodeGlobal(accountInfo: AccountInfo<Buffer>): Global {
    return this.offlinePumpProgram.coder.accounts.decode<Global>(
      "global",
      accountInfo.data,
    );
  }

  decodeFeeConfig(accountInfo: AccountInfo<Buffer>): FeeConfig {
    return this.offlinePumpProgram.coder.accounts.decode<FeeConfig>(
      "feeConfig",
      accountInfo.data,
    );
  }

  decodeBondingCurve(accountInfo: AccountInfo<Buffer>): BondingCurve {
    return this.offlinePumpProgram.coder.accounts.decode<BondingCurve>(
      "bondingCurve",
      accountInfo.data,
    );
  }

  decodeBondingCurveNullable(
    accountInfo: AccountInfo<Buffer>,
  ): BondingCurve | null {
    try {
      const data = accountInfo.data;
      // Ensure buffer is at least 83 bytes
      // one byte for the mayhem mode
      // one byte for the cashback coin
      if (data.length < 83) {
        const padded = Buffer.alloc(83);
        data.copy(padded);
        accountInfo = {
          ...accountInfo,
          data: padded,
        };
      }

      return this.decodeBondingCurve(accountInfo);
    } catch (error) {
      console.warn("Failed to decode bonding curve", error);
      return null;
    }
  }

  decodeGlobalVolumeAccumulator(
    accountInfo: AccountInfo<Buffer>,
  ): GlobalVolumeAccumulator {
    return this.offlinePumpProgram.coder.accounts.decode<GlobalVolumeAccumulator>(
      "globalVolumeAccumulator",
      accountInfo.data,
    );
  }

  decodeUserVolumeAccumulator(
    accountInfo: AccountInfo<Buffer>,
  ): UserVolumeAccumulator {
    return this.offlinePumpProgram.coder.accounts.decode<UserVolumeAccumulator>(
      "userVolumeAccumulator",
      accountInfo.data,
    );
  }

  decodeUserVolumeAccumulatorNullable(
    accountInfo: AccountInfo<Buffer>,
  ): UserVolumeAccumulator | null {
    try {
      return this.decodeUserVolumeAccumulator(accountInfo);
    } catch (error) {
      console.warn("Failed to decode user volume accumulator", error);
      return null;
    }
  }

  decodeSharingConfig(accountInfo: AccountInfo<Buffer>): SharingConfig {
    return this.offlinePumpFeeProgram.coder.accounts.decode<SharingConfig>(
      "sharingConfig",
      accountInfo.data,
    );
  }

  decodeSocialFeePda(accountInfo: AccountInfo<Buffer>): SocialFeePdaState {
    return this.offlinePumpFeeProgram.coder.accounts.decode<SocialFeePdaState>(
      "socialFeePda",
      accountInfo.data,
    );
  }

  decodeSocialFeePdaClaimedEvent(data: Buffer): SocialFeePdaClaimedEvent {
    return this.offlinePumpFeeProgram.coder.types.decode<SocialFeePdaClaimedEvent>(
      "socialFeePdaClaimed",
      data,
    );
  }

  decodeSocialFeePdaCreatedEvent(data: Buffer): SocialFeePdaCreatedEvent {
    return this.offlinePumpFeeProgram.coder.types.decode<SocialFeePdaCreatedEvent>(
      "socialFeePdaCreated",
      data,
    );
  }

  decodeDonationFeePda(accountInfo: AccountInfo<Buffer>): DonationFeePdaState {
    return this.offlinePumpFeeProgram.coder.accounts.decode<DonationFeePdaState>(
      "donationFeePda",
      accountInfo.data,
    );
  }

  /**
   * @deprecated Use `createV2Instruction` instead.
   */
  async createInstruction({
    mint,
    name,
    symbol,
    uri,
    creator,
    user,
  }: {
    mint: PublicKey;
    name: string;
    symbol: string;
    uri: string;
    creator: PublicKey;
    user: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpProgram.methods
      .create(name, symbol, uri, creator)
      .accountsPartial({
        mint,
        user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async createV2Instruction({
    mint,
    name,
    symbol,
    uri,
    creator,
    user,
    mayhemMode,
    cashback = false,
    quoteMint,
  }: {
    mint: PublicKey;
    name: string;
    symbol: string;
    uri: string;
    creator: PublicKey;
    user: PublicKey;
    mayhemMode: boolean;
    cashback?: boolean;
    quoteMint?: PublicKey;
  }): Promise<TransactionInstruction> {
    const builder = this.offlinePumpProgram.methods
      .createV2(name, symbol, uri, creator, mayhemMode, [cashback ?? false])
      .accountsPartial({
        mint,
        user,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        mayhemProgramId: MAYHEM_PROGRAM_ID,
        globalParams: getGlobalParamsPda(),
        solVault: getSolVaultPda(),
        mayhemState: getMayhemStatePda(mint),
        mayhemTokenVault: getTokenVaultPda(mint),
      });

    if (quoteMint && !isLegacyQuoteMint(quoteMint)) {
      return await builder
        .remainingAccounts([
          { pubkey: quoteMint, isWritable: false, isSigner: false },
          {
            pubkey: quoteAta(
              bondingCurvePda(mint),
              quoteMint,
              TOKEN_PROGRAM_ID,
            ),
            isWritable: true,
            isSigner: false,
          },
          { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        ])
        .instruction();
    }

    return await builder.instruction();
  }

  async buyInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    associatedUserAccountInfo,
    mint,
    user,
    amount,
    solAmount,
    slippage,
    tokenProgram = TOKEN_PROGRAM_ID,
  }: {
    global: Global;
    bondingCurveAccountInfo: AccountInfo<Buffer>;
    bondingCurve: BondingCurve;
    associatedUserAccountInfo: AccountInfo<Buffer> | null;
    mint: PublicKey;
    user: PublicKey;
    amount: BN;
    solAmount: BN;
    slippage: number;
    tokenProgram: PublicKey;
  }): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];

    const associatedUser = getAssociatedTokenAddressSync(
      mint,
      user,
      true,
      tokenProgram,
    );

    if (!associatedUserAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          user,
          associatedUser,
          user,
          mint,
          tokenProgram,
        ),
      );
    }

    instructions.push(
      await this.buyInstruction({
        global,
        mint,
        creator: bondingCurve.creator,
        user,
        associatedUser,
        amount,
        solAmount,
        slippage,
        tokenProgram,
        mayhemMode: bondingCurve.isMayhemMode,
      }),
    );

    return instructions;
  }

  async createV2AndBuyInstructions({
    global,
    mint,
    name,
    symbol,
    uri,
    creator,
    user,
    amount,
    solAmount,
    mayhemMode,
    cashback,
    isTokenizedAgent = false,
    buyBackBps = 0,
  }: {
    global: Global;
    mint: PublicKey;
    name: string;
    symbol: string;
    uri: string;
    creator: PublicKey;
    user: PublicKey;
    amount: BN;
    solAmount: BN;
    mayhemMode: boolean;
    cashback?: boolean;
    isTokenizedAgent?: boolean;
    buyBackBps?: number;
  }): Promise<TransactionInstruction[]> {
    const associatedUser = getAssociatedTokenAddressSync(
      mint,
      user,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const buyInstruction = await this.buyInstruction({
      global,
      mint,
      creator,
      user,
      associatedUser,
      amount,
      solAmount,
      slippage: 1,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      mayhemMode,
    });

    const instructions = [
      await this.createV2Instruction({
        mint,
        name,
        symbol,
        uri,
        creator,
        user,
        mayhemMode,
        cashback,
      }),
      createAssociatedTokenAccountIdempotentInstruction(
        user,
        associatedUser,
        user,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
      buyInstruction,
    ];

    if (isTokenizedAgent) {
      const agentPaymentsSdk = PumpAgentOffline.load(mint);
      const agentInitializeIx = await agentPaymentsSdk.create({
        authority: creator,
        mint,
        agentAuthority: creator,
        buybackBps: buyBackBps,
      });
      instructions.push(agentInitializeIx);
    }

    return instructions;
  }

  /**
   * @deprecated Use `createV2AndBuyInstructions` instead.
   */
  async createAndBuyInstructions({
    global,
    mint,
    name,
    symbol,
    uri,
    creator,
    user,
    amount,
    solAmount,
    isTokenizedAgent = false,
    buyBackBps = 0,
  }: {
    global: Global;
    mint: PublicKey;
    name: string;
    symbol: string;
    uri: string;
    creator: PublicKey;
    user: PublicKey;
    amount: BN;
    solAmount: BN;
    isTokenizedAgent?: boolean;
    buyBackBps?: number;
  }): Promise<TransactionInstruction[]> {
    const associatedUser = getAssociatedTokenAddressSync(mint, user, true);
    const buyInstruction = await this.buyInstruction({
      global,
      mint,
      creator,
      user,
      associatedUser,
      amount,
      solAmount,
      slippage: 1,
      tokenProgram: TOKEN_PROGRAM_ID,
      mayhemMode: false,
    });

    const instructions = [
      await this.createInstruction({ mint, name, symbol, uri, creator, user }),
      createAssociatedTokenAccountIdempotentInstruction(
        user,
        associatedUser,
        user,
        mint,
      ),
      buyInstruction,
    ];

    if (isTokenizedAgent) {
      const agentPaymentsSdk = PumpAgentOffline.load(mint);
      const agentInitializeIx = await agentPaymentsSdk.create({
        authority: creator,
        mint,
        agentAuthority: creator,
        buybackBps: buyBackBps,
      });
      instructions.push(agentInitializeIx);
    }

    return instructions;
  }

  private async buyInstruction({
    global,
    mint,
    creator,
    user,
    associatedUser,
    amount,
    solAmount,
    slippage,
    tokenProgram = TOKEN_PROGRAM_ID,
    mayhemMode = false,
  }: {
    global: Global;
    mint: PublicKey;
    creator: PublicKey;
    user: PublicKey;
    associatedUser: PublicKey;
    amount: BN;
    solAmount: BN;
    slippage: number;
    tokenProgram: PublicKey;
    mayhemMode: boolean;
  }) {
    return await this.getBuyInstructionInternal({
      user,
      associatedUser,
      mint,
      creator,
      feeRecipient: getFeeRecipient(global, mayhemMode),
      buybackFeeRecipient: getStaticRandomFeeRecipientForBuyback(),
      amount,
      solAmount: solAmount.add(
        solAmount.mul(new BN(Math.floor(slippage * 10))).div(new BN(1000)),
      ),
      tokenProgram,
    });
  }

  async sellInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    mint,
    user,
    amount,
    solAmount,
    slippage,
    tokenProgram = TOKEN_PROGRAM_ID,
    mayhemMode = false,
    cashback = false,
  }: {
    global: Global;
    bondingCurveAccountInfo: AccountInfo<Buffer>;
    bondingCurve: BondingCurve;
    mint: PublicKey;
    user: PublicKey;
    amount: BN;
    solAmount: BN;
    slippage: number;
    tokenProgram: PublicKey;
    mayhemMode: boolean;
    cashback?: boolean;
  }): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];

    instructions.push(
      await this.getSellInstructionInternal({
        user,
        mint,
        creator: bondingCurve.creator,
        feeRecipient: getFeeRecipient(global, mayhemMode),
        buybackFeeRecipient: getStaticRandomFeeRecipientForBuyback(),
        amount,
        solAmount: solAmount.sub(
          solAmount.mul(new BN(Math.floor(slippage * 10))).div(new BN(1000)),
        ),
        tokenProgram,
        cashback,
      }),
    );

    return instructions;
  }

  async extendAccountInstruction({
    account,
    user,
  }: {
    account: PublicKey;
    user: PublicKey;
  }): Promise<TransactionInstruction> {
    return this.offlinePumpProgram.methods
      .extendAccount()
      .accountsPartial({
        account,
        user,
      })
      .instruction();
  }

  async migrateInstruction({
    withdrawAuthority,
    mint,
    user,
    tokenProgram = TOKEN_PROGRAM_ID,
  }: {
    withdrawAuthority: PublicKey;
    mint: PublicKey;
    user: PublicKey;
    tokenProgram: PublicKey;
  }): Promise<TransactionInstruction> {
    const bondingCurve = bondingCurvePda(mint);
    const associatedBondingCurve = getAssociatedTokenAddressSync(
      mint,
      bondingCurve,
      true,
      tokenProgram,
    );

    const poolAuthority = pumpPoolAuthorityPda(mint);
    const poolAuthorityMintAccount = getAssociatedTokenAddressSync(
      mint,
      poolAuthority,
      true,
      tokenProgram,
    );

    const pool = canonicalPumpPoolPda(mint);
    const poolBaseTokenAccount = getAssociatedTokenAddressSync(
      mint,
      pool,
      true,
      tokenProgram,
    );
    return this.offlinePumpProgram.methods
      .migrate()
      .accountsPartial({
        mint,
        user,
        withdrawAuthority,
        associatedBondingCurve,
        poolAuthorityMintAccount,
        poolBaseTokenAccount,
      })
      .instruction();
  }

  async migrateV2Instruction({
    withdrawAuthority,
    mint,
    user,
    quoteMint = PublicKey.default,
    baseTokenProgram = TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram = TOKEN_PROGRAM_ID,
  }: {
    withdrawAuthority: PublicKey;
    mint: PublicKey;
    user: PublicKey;
    quoteMint: PublicKey;
    baseTokenProgram: PublicKey;
    quoteTokenProgram: PublicKey;
  }): Promise<TransactionInstruction> {
    const bondingCurve = bondingCurvePda(mint);

    const poolAuthority = pumpPoolAuthorityPda(mint);
    const poolAuthorityMintAccount = getAssociatedTokenAddressSync(
      mint,
      poolAuthority,
      true,
      baseTokenProgram,
    );

    const pool = canonicalPumpPoolPdaWithQuote(mint, quoteMint);
    const poolBaseTokenAccount = getAssociatedTokenAddressSync(
      mint,
      pool,
      true,
      baseTokenProgram,
    );

    const associatedBaseBondingCurve = getAssociatedTokenAddressSync(
      mint,
      bondingCurve,
      true,
      baseTokenProgram,
    );
    const associatedQuoteBondingCurve = quoteAta(
      bondingCurve,
      quoteMint,
      quoteTokenProgram,
    );
    const poolAuthorityQuoteAccount = quoteAta(
      poolAuthority,
      quoteMint,
      quoteTokenProgram,
    );
    const poolQuoteTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      pool,
      true,
      quoteTokenProgram,
    );
    return this.offlinePumpProgram.methods
      .migrateV2()
      .accountsPartial({
        baseMint: mint,
        quoteMint,
        user,
        withdrawAuthority,
        bondingCurve,
        poolAuthorityMintAccount,
        poolBaseTokenAccount,
        pool,
        poolAuthority,
        systemProgram: SystemProgram.programId,
        pumpAmm: PUMP_AMM_PROGRAM_ID,
        pumpAmmEventAuthority: getEventAuthorityPda(PUMP_AMM_PROGRAM_ID),
        eventAuthority: getEventAuthorityPda(PUMP_PROGRAM_ID),
        program: PUMP_PROGRAM_ID,
        associatedBaseBondingCurve,
        associatedQuoteBondingCurve,
        poolAuthorityQuoteAccount,
        poolQuoteTokenAccount,
        baseTokenProgram: baseTokenProgram,
        quoteTokenProgram: quoteTokenProgram,
      })
      .instruction();
  }

  async syncUserVolumeAccumulator(
    user: PublicKey,
  ): Promise<TransactionInstruction> {
    return await this.offlinePumpProgram.methods
      .syncUserVolumeAccumulator()
      .accountsPartial({ user })
      .instruction();
  }

  async setCreator({
    mint,
    setCreatorAuthority,
    creator,
  }: {
    mint: PublicKey;
    setCreatorAuthority: PublicKey;
    creator: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpProgram.methods
      .setCreator(creator)
      .accountsPartial({
        mint,
        setCreatorAuthority,
      })
      .instruction();
  }

  async initUserVolumeAccumulator({
    payer,
    user,
  }: {
    payer: PublicKey;
    user: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpProgram.methods
      .initUserVolumeAccumulator()
      .accountsPartial({ payer, user })
      .instruction();
  }

  async closeUserVolumeAccumulator(
    user: PublicKey,
  ): Promise<TransactionInstruction> {
    return await this.offlinePumpProgram.methods
      .closeUserVolumeAccumulator()
      .accountsPartial({ user })
      .instruction();
  }

  async getBuyInstructionRaw({
    user,
    mint,
    creator,
    amount,
    solAmount,
    feeRecipient = getStaticRandomFeeRecipient(),
    tokenProgram = TOKEN_PROGRAM_ID,
    buybackFeeRecipient = getStaticRandomFeeRecipientForBuyback(),
  }: {
    user: PublicKey;
    mint: PublicKey;
    creator: PublicKey;
    amount: BN;
    solAmount: BN;
    feeRecipient: PublicKey;
    tokenProgram?: PublicKey;
    buybackFeeRecipient: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.getBuyInstructionInternal({
      user,
      associatedUser: getAssociatedTokenAddressSync(
        mint,
        user,
        true,
        tokenProgram,
      ),
      mint,
      creator,
      feeRecipient,
      buybackFeeRecipient,
      amount,
      solAmount,
      tokenProgram,
    });
  }

  private async getBuyInstructionInternal({
    user,
    associatedUser,
    mint,
    creator,
    feeRecipient,
    buybackFeeRecipient,
    amount,
    solAmount,
    tokenProgram = TOKEN_PROGRAM_ID,
  }: {
    user: PublicKey;
    associatedUser: PublicKey;
    mint: PublicKey;
    creator: PublicKey;
    feeRecipient: PublicKey;
    buybackFeeRecipient: PublicKey;
    amount: BN;
    solAmount: BN;
    tokenProgram: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpProgram.methods
      .buy(amount, solAmount, { 0: true })
      .accountsPartial({
        feeRecipient,
        mint,
        associatedUser,
        user,
        creatorVault: creatorVaultPda(creator),
        tokenProgram,
      })
      .remainingAccounts([
        {
          pubkey: bondingCurveV2Pda(mint),
          isWritable: false,
          isSigner: false,
        },
        {
          pubkey: buybackFeeRecipient,
          isWritable: true,
          isSigner: false,
        },
      ])
      .instruction();
  }

  async getSellInstructionRaw({
    user,
    mint,
    creator,
    amount,
    solAmount,
    feeRecipient = getStaticRandomFeeRecipient(),
    buybackFeeRecipient = getStaticRandomFeeRecipientForBuyback(),
    tokenProgram = TOKEN_PROGRAM_ID,
    cashback = false,
  }: {
    user: PublicKey;
    mint: PublicKey;
    creator: PublicKey;
    amount: BN;
    solAmount: BN;
    feeRecipient: PublicKey;
    buybackFeeRecipient: PublicKey;
    tokenProgram: PublicKey;
    cashback?: boolean;
  }): Promise<TransactionInstruction> {
    return await this.getSellInstructionInternal({
      user,
      mint,
      creator,
      feeRecipient,
      buybackFeeRecipient,
      amount,
      solAmount,
      tokenProgram,
      cashback,
    });
  }

  private async getSellInstructionInternal({
    user,
    mint,
    creator,
    feeRecipient,
    buybackFeeRecipient,
    amount,
    solAmount,
    tokenProgram,
    cashback,
  }: {
    user: PublicKey;
    mint: PublicKey;
    creator: PublicKey;
    feeRecipient: PublicKey;
    buybackFeeRecipient: PublicKey;
    amount: BN;
    solAmount: BN;
    tokenProgram: PublicKey;
    cashback?: boolean;
  }): Promise<TransactionInstruction> {
    const userVolumeAccumulator = userVolumeAccumulatorPda(user);
    const fixedRemaininAccounts = [
      {
        pubkey: bondingCurveV2Pda(mint),
        isWritable: false,
        isSigner: false,
      },
      {
        pubkey: buybackFeeRecipient,
        isWritable: true,
        isSigner: false,
      },
    ];
    return await this.offlinePumpProgram.methods
      .sell(amount, solAmount)
      .accountsPartial({
        feeRecipient,
        mint,
        associatedUser: getAssociatedTokenAddressSync(
          mint,
          user,
          true,
          tokenProgram,
        ),
        user,
        creatorVault: creatorVaultPda(creator),
        tokenProgram,
      })
      .remainingAccounts(
        cashback
          ? [
              {
                pubkey: userVolumeAccumulator,
                isWritable: true,
                isSigner: false,
              },
              ...fixedRemaininAccounts,
            ]
          : fixedRemaininAccounts,
      )
      .instruction();
  }

  async buyV2Instructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    associatedUserAccountInfo,
    mint,
    user,
    amount,
    quoteAmount,
    slippage,
    tokenProgram = TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram = TOKEN_PROGRAM_ID,
  }: {
    global: Global;
    bondingCurveAccountInfo: AccountInfo<Buffer>;
    bondingCurve: BondingCurve;
    associatedUserAccountInfo: AccountInfo<Buffer> | null;
    mint: PublicKey;
    user: PublicKey;
    amount: BN;
    quoteAmount: BN;
    slippage: number;
    tokenProgram?: PublicKey;
    quoteTokenProgram?: PublicKey;
  }): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];

    const associatedUser = getAssociatedTokenAddressSync(
      mint,
      user,
      true,
      tokenProgram,
    );

    if (!associatedUserAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          user,
          associatedUser,
          user,
          mint,
          tokenProgram,
        ),
      );
    }

    const quoteMint = isLegacyQuoteMint(bondingCurve.quoteMint)
      ? NATIVE_MINT
      : bondingCurve.quoteMint;

    instructions.push(
      await this.buyV2Instruction({
        global,
        mint,
        creator: bondingCurve.creator,
        user,
        associatedUser,
        amount,
        quoteAmount,
        slippage,
        tokenProgram,
        quoteMint,
        quoteTokenProgram,
        mayhemMode: bondingCurve.isMayhemMode,
      }),
    );

    return instructions;
  }

  async createV2AndBuyV2Instructions({
    global,
    mint,
    name,
    symbol,
    uri,
    creator,
    user,
    amount,
    quoteAmount,
    mayhemMode,
    cashback = false,
    quoteMint,
    quoteTokenProgram = TOKEN_PROGRAM_ID,
  }: {
    global: Global;
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
    quoteTokenProgram?: PublicKey;
  }): Promise<TransactionInstruction[]> {
    const associatedUser = getAssociatedTokenAddressSync(
      mint,
      user,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const buyQuoteMint =
      quoteMint && !isLegacyQuoteMint(quoteMint) ? quoteMint : NATIVE_MINT;
    return [
      await this.createV2Instruction({
        mint,
        name,
        symbol,
        uri,
        creator,
        user,
        mayhemMode,
        cashback,
        quoteMint,
      }),
      createAssociatedTokenAccountIdempotentInstruction(
        user,
        associatedUser,
        user,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
      await this.buyV2Instruction({
        global,
        mint,
        creator,
        user,
        associatedUser,
        amount,
        quoteAmount,
        slippage: 1,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteMint: buyQuoteMint,
        quoteTokenProgram,
        mayhemMode,
      }),
    ];
  }

  private async buyV2Instruction({
    global,
    mint,
    creator,
    user,
    associatedUser,
    amount,
    quoteAmount,
    slippage,
    tokenProgram = TOKEN_2022_PROGRAM_ID,
    quoteMint,
    quoteTokenProgram = TOKEN_PROGRAM_ID,
    mayhemMode = false,
  }: {
    global: Global;
    mint: PublicKey;
    creator: PublicKey;
    user: PublicKey;
    associatedUser: PublicKey;
    amount: BN;
    quoteAmount: BN;
    slippage: number;
    tokenProgram: PublicKey;
    quoteMint: PublicKey;
    quoteTokenProgram: PublicKey;
    mayhemMode: boolean;
  }) {
    return await this.getBuyV2InstructionInternal({
      user,
      associatedUser,
      mint,
      creator,
      feeRecipient: getFeeRecipient(global, mayhemMode),
      buybackFeeRecipient: getStaticRandomFeeRecipientForBuyback(),
      amount,
      quoteAmount: quoteAmount.add(
        quoteAmount.mul(new BN(Math.floor(slippage * 10))).div(new BN(1000)),
      ),
      tokenProgram,
      quoteMint,
      quoteTokenProgram,
    });
  }

  async sellV2Instructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    mint,
    user,
    amount,
    quoteAmount,
    slippage,
    tokenProgram = TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram = TOKEN_PROGRAM_ID,
  }: {
    global: Global;
    bondingCurveAccountInfo: AccountInfo<Buffer>;
    bondingCurve: BondingCurve;
    mint: PublicKey;
    user: PublicKey;
    amount: BN;
    quoteAmount: BN;
    slippage: number;
    tokenProgram?: PublicKey;
    quoteTokenProgram?: PublicKey;
  }): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];

    const quoteMint = isLegacyQuoteMint(bondingCurve.quoteMint)
      ? NATIVE_MINT
      : bondingCurve.quoteMint;

    instructions.push(
      await this.getSellV2InstructionInternal({
        user,
        mint,
        creator: bondingCurve.creator,
        feeRecipient: getFeeRecipient(global, bondingCurve.isMayhemMode),
        buybackFeeRecipient: getStaticRandomFeeRecipientForBuyback(),
        amount,
        quoteAmount: quoteAmount.sub(
          quoteAmount.mul(new BN(Math.floor(slippage * 10))).div(new BN(1000)),
        ),
        tokenProgram,
        quoteMint,
        quoteTokenProgram,
      }),
    );

    return instructions;
  }

  async getBuyV2InstructionRaw({
    user,
    mint,
    creator,
    amount,
    quoteAmount,
    feeRecipient = getStaticRandomFeeRecipient(),
    buybackFeeRecipient = getStaticRandomFeeRecipientForBuyback(),
    tokenProgram = TOKEN_2022_PROGRAM_ID,
    quoteMint = NATIVE_MINT,
    quoteTokenProgram = TOKEN_PROGRAM_ID,
  }: {
    user: PublicKey;
    mint: PublicKey;
    creator: PublicKey;
    amount: BN;
    quoteAmount: BN;
    feeRecipient?: PublicKey;
    buybackFeeRecipient?: PublicKey;
    tokenProgram?: PublicKey;
    quoteMint?: PublicKey;
    quoteTokenProgram?: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.getBuyV2InstructionInternal({
      user,
      associatedUser: getAssociatedTokenAddressSync(
        mint,
        user,
        true,
        tokenProgram,
      ),
      mint,
      creator,
      feeRecipient,
      buybackFeeRecipient,
      amount,
      quoteAmount,
      tokenProgram,
      quoteMint,
      quoteTokenProgram,
    });
  }

  private async getBuyV2InstructionInternal({
    user,
    associatedUser,
    mint,
    creator,
    feeRecipient,
    buybackFeeRecipient,
    amount,
    quoteAmount,
    tokenProgram,
    quoteMint,
    quoteTokenProgram,
  }: {
    user: PublicKey;
    associatedUser: PublicKey;
    mint: PublicKey;
    creator: PublicKey;
    feeRecipient: PublicKey;
    buybackFeeRecipient: PublicKey;
    amount: BN;
    quoteAmount: BN;
    tokenProgram: PublicKey;
    quoteMint: PublicKey;
    quoteTokenProgram: PublicKey;
  }): Promise<TransactionInstruction> {
    const bondingCurve = bondingCurvePda(mint);
    const creatorVault = creatorVaultPda(creator);
    const userVolumeAccumulator = userVolumeAccumulatorPda(user);

    return await this.offlinePumpProgram.methods
      .buyV2(amount, quoteAmount)
      .accountsPartial({
        baseMint: mint,
        quoteMint,
        baseTokenProgram: tokenProgram,
        quoteTokenProgram,
        feeRecipient,
        associatedQuoteFeeRecipient: quoteAta(
          feeRecipient,
          quoteMint,
          quoteTokenProgram,
        ),
        buybackFeeRecipient,
        associatedQuoteBuybackFeeRecipient: quoteAta(
          buybackFeeRecipient,
          quoteMint,
          quoteTokenProgram,
        ),
        associatedBaseBondingCurve: getAssociatedTokenAddressSync(
          mint,
          bondingCurve,
          true,
          tokenProgram,
        ),
        associatedQuoteBondingCurve: quoteAta(
          bondingCurve,
          quoteMint,
          quoteTokenProgram,
        ),
        user,
        associatedBaseUser: associatedUser,
        associatedQuoteUser: quoteAta(user, quoteMint, quoteTokenProgram),
        creatorVault,
        associatedCreatorVault: quoteAta(
          creatorVault,
          quoteMint,
          quoteTokenProgram,
        ),
        associatedUserVolumeAccumulator: quoteAta(
          userVolumeAccumulator,
          quoteMint,
          quoteTokenProgram,
        ),
      })
      .instruction();
  }

  async getSellV2InstructionRaw({
    user,
    mint,
    creator,
    amount,
    quoteAmount,
    feeRecipient = getStaticRandomFeeRecipient(),
    buybackFeeRecipient = getStaticRandomFeeRecipientForBuyback(),
    tokenProgram = TOKEN_2022_PROGRAM_ID,
    quoteMint = NATIVE_MINT,
    quoteTokenProgram = TOKEN_PROGRAM_ID,
  }: {
    user: PublicKey;
    mint: PublicKey;
    creator: PublicKey;
    amount: BN;
    quoteAmount: BN;
    feeRecipient?: PublicKey;
    buybackFeeRecipient?: PublicKey;
    tokenProgram?: PublicKey;
    quoteMint?: PublicKey;
    quoteTokenProgram?: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.getSellV2InstructionInternal({
      user,
      mint,
      creator,
      feeRecipient,
      buybackFeeRecipient,
      amount,
      quoteAmount,
      tokenProgram,
      quoteMint,
      quoteTokenProgram,
    });
  }

  private async getSellV2InstructionInternal({
    user,
    mint,
    creator,
    feeRecipient,
    buybackFeeRecipient,
    amount,
    quoteAmount,
    tokenProgram,
    quoteMint,
    quoteTokenProgram,
  }: {
    user: PublicKey;
    mint: PublicKey;
    creator: PublicKey;
    feeRecipient: PublicKey;
    buybackFeeRecipient: PublicKey;
    amount: BN;
    quoteAmount: BN;
    tokenProgram: PublicKey;
    quoteMint: PublicKey;
    quoteTokenProgram: PublicKey;
  }): Promise<TransactionInstruction> {
    const bondingCurve = bondingCurvePda(mint);
    const creatorVault = creatorVaultPda(creator);
    const userVolumeAccumulator = userVolumeAccumulatorPda(user);

    return await this.offlinePumpProgram.methods
      .sellV2(amount, quoteAmount)
      .accountsPartial({
        baseMint: mint,
        quoteMint,
        baseTokenProgram: tokenProgram,
        quoteTokenProgram,
        feeRecipient,
        associatedQuoteFeeRecipient: quoteAta(
          feeRecipient,
          quoteMint,
          quoteTokenProgram,
        ),
        buybackFeeRecipient,
        associatedQuoteBuybackFeeRecipient: quoteAta(
          buybackFeeRecipient,
          quoteMint,
          quoteTokenProgram,
        ),
        associatedBaseBondingCurve: getAssociatedTokenAddressSync(
          mint,
          bondingCurve,
          true,
          tokenProgram,
        ),
        associatedQuoteBondingCurve: quoteAta(
          bondingCurve,
          quoteMint,
          quoteTokenProgram,
        ),
        user,
        associatedBaseUser: getAssociatedTokenAddressSync(
          mint,
          user,
          true,
          tokenProgram,
        ),
        associatedQuoteUser: quoteAta(user, quoteMint, quoteTokenProgram),
        creatorVault,
        associatedCreatorVault: quoteAta(
          creatorVault,
          quoteMint,
          quoteTokenProgram,
        ),
        associatedUserVolumeAccumulator: quoteAta(
          userVolumeAccumulator,
          quoteMint,
          quoteTokenProgram,
        ),
      })
      .instruction();
  }

  /**
   * Creates a fee sharing configuration for a token.
   *
   * @param params - Parameters for creating a fee sharing configuration
   * @param params.creator - The creator of the token
   * @param params.mint - The mint address of the token
   * @param params.pool - The pool address of the token (null for ungraduated coins)
   */
  async createFeeSharingConfig({
    creator,
    mint,
    pool,
  }: {
    creator: PublicKey;
    mint: PublicKey;
    pool: PublicKey | null;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpFeeProgram.methods
      .createFeeSharingConfig()
      .accountsPartial({
        payer: creator,
        mint,
        pool,
      })
      .instruction();
  }

  /**
   * Updates the fee shares for a token's creator fee distribution.
   *
   * @param params - Parameters for updating fee shares
   * @param params.authority - The current authority that can modify the fee sharing config
   * @param params.mint - The mint address of the token
   * @param params.currentShareholders - Array of current shareholders
   * @param params.newShareholders - Array of new shareholders and their share percentages
   * @requirements for newShareholders:
   * - Must contain at least 1 shareholder (cannot be empty)
   * - Maximum of 10 shareholders allowed
   * - Each shareholder must have a positive share (shareBps > 0)
   * - Total shares must equal exactly 10,000 basis points (100%)
   * - No duplicate addresses allowed
   * - shareBps is in basis points where 1 bps = 0.01% (e.g., 1500 = 15%)
   * @throws {NoShareholdersError} If shareholders array is empty
   * @throws {TooManyShareholdersError} If more than 10 shareholders
   * @throws {ZeroShareError} If any shareholder has zero or negative shares
   * @throws {InvalidShareTotalError} If total shares don't equal 10,000 basis points
   * @throws {DuplicateShareholderError} If duplicate addresses are found
   * @example
   * ```typescript
   * const instruction = await PUMP_SDK.updateFeeShares({
   *   authority: authorityPublicKey,
   *   mint: mintPublicKey,
   *   curShareholders: [wallet1, wallet2, wallet3],
   *   newShareholders: [
   *     { address: wallet1, shareBps: 5000 }, // 50%
   *     { address: wallet2, shareBps: 3000 }, // 30%
   *     { address: wallet3, shareBps: 2000 }, // 20%
   *   ]
   * });
   * ```
   */
  async updateFeeShares({
    authority,
    mint,
    currentShareholders,
    newShareholders,
  }: {
    authority: PublicKey;
    mint: PublicKey;
    currentShareholders: PublicKey[];
    newShareholders: Shareholder[];
  }): Promise<TransactionInstruction> {
    if (newShareholders.length === 0) {
      throw new NoShareholdersError();
    }

    if (newShareholders.length > MAX_SHAREHOLDERS) {
      throw new TooManyShareholdersError(
        newShareholders.length,
        MAX_SHAREHOLDERS,
      );
    }

    let totalShares = 0;
    const addresses = new Set<string>();

    for (const shareholder of newShareholders) {
      if (shareholder.shareBps <= 0) {
        throw new ZeroShareError(shareholder.address.toString());
      }

      totalShares += shareholder.shareBps;
      addresses.add(shareholder.address.toString());
    }

    if (totalShares !== 10_000) {
      throw new InvalidShareTotalError(totalShares);
    }

    if (addresses.size !== newShareholders.length) {
      throw new DuplicateShareholderError();
    }

    const sharingConfigPda = feeSharingConfigPda(mint);
    const coinCreatorVaultAuthority =
      coinCreatorVaultAuthorityPda(sharingConfigPda);

    return await this.offlinePumpFeeProgram.methods
      .updateFeeShares(
        newShareholders.map((sh) => ({
          address: sh.address,
          shareBps: sh.shareBps,
        })),
      )
      .accountsPartial({
        authority,
        mint,
        coinCreatorVaultAta: coinCreatorVaultAtaPda(
          coinCreatorVaultAuthority,
          NATIVE_MINT,
          TOKEN_PROGRAM_ID,
        ),
      })
      .remainingAccounts(
        currentShareholders.map((pubkey) => ({
          pubkey,
          isWritable: true,
          isSigner: false,
        })),
      )
      .instruction();
  }

  decodeDistributeCreatorFeesEvent(data: Buffer): DistributeCreatorFeesEvent {
    return this.offlinePumpProgram.coder.types.decode<DistributeCreatorFeesEvent>(
      "distributeCreatorFeesEvent",
      data,
    );
  }

  async distributeCreatorFees({
    mint,
    sharingConfig,
    sharingConfigAddress,
  }: {
    mint: PublicKey;
    sharingConfig: SharingConfig;
    sharingConfigAddress: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpProgram.methods
      .distributeCreatorFees()
      .accountsPartial({
        mint,
        creatorVault: creatorVaultPda(sharingConfigAddress),
      })
      .remainingAccounts(
        sharingConfig.shareholders.map((shareholder) => ({
          pubkey: shareholder.address,
          isWritable: true,
          isSigner: false,
        })),
      )
      .instruction();
  }

  decodeMinimumDistributableFee(data: Buffer): MinimumDistributableFeeEvent {
    return this.offlinePumpProgram.coder.types.decode<MinimumDistributableFeeEvent>(
      "minimumDistributableFeeEvent",
      data,
    );
  }

  async getMinimumDistributableFee({
    mint,
    sharingConfig,
    sharingConfigAddress,
  }: {
    mint: PublicKey;
    sharingConfig: SharingConfig;
    sharingConfigAddress: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpProgram.methods
      .getMinimumDistributableFee()
      .accountsPartial({
        mint,
        creatorVault: creatorVaultPda(sharingConfigAddress),
      })
      .remainingAccounts(
        sharingConfig.shareholders.map((shareholder) => ({
          pubkey: shareholder.address,
          isWritable: true,
          isSigner: false,
        })),
      )
      .instruction();
  }

  /**
   * Creates a `DonationFeePda` for a `(mint, configId)` pair under the
   * pump-fees program. This PDA is the on-chain fee destination used when
   * routing a slice of creator fees to a donate.gg config; once created, you
   * can pass `donationFeePda(mint)` as a shareholder address in a
   * subsequent `updateFeeShares` call.
   *
   * The instruction is idempotent.
   *
   * @param params - Parameters for creating the donation fee PDA
   * @param params.coinCreator - The coin creator wallet; signs and pays rent
   *   for the new PDA. This is either the bonding curve's `creator`
   *   or the canonical pump-amm pool's `coin_creator`
   *   or the sharing_config.admin.
   * @param params.mint - Base mint of the coin whose creator fees are routed.
   * @param params.configId - The donate.gg config id this PDA escrows for.
   */
  async createDonationFeePda({
    coinCreator,
    mint,
    configId,
  }: {
    coinCreator: PublicKey;
    mint: PublicKey;
    configId: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpFeeProgram.methods
      .createDonationFeePda()
      .accountsPartial({
        payer: coinCreator,
        configId,
        baseMint: mint,
        pool: canonicalPumpPoolPda(mint),
        donationFeePda: donationFeePda(mint, configId),
      })
      .instruction();
  }

  /**
   * Cranks a previously-created `DonationFeePda`, forwarding its full
   * `donationFeePdaAta` balance into the donation relay program's debouncer
   * for the relayer to settle later.
   *
   * The instruction is **permissionless** — anyone can call it, paying the
   * tx fee (and rent for the WSOL ATA on first crank). The pump-fees handler
   * also wraps any bare lamports sitting on the `DonationFeePda` into its
   * WSOL ATA before forwarding (native quote path), so the only state needed
   * to crank is the `(mint, configId)` pair (the `configId` is read back from
   * the PDA by the relay CPI, but the caller still needs it to derive the
   * relay-side epoch_tracker / debouncer PDAs).
   *
   * Quote mint defaults to wrapped SOL (`NATIVE_MINT`). If/when other quote
   * mints are supported, override `quoteMint` to match the value stored on
   * the on-chain `DonationFeePda.quote_mint` (the program enforces equality
   * and will error otherwise).
   *
   * @param params - Parameters for cranking the donation fee PDA
   * @param params.payer - Wallet that signs and pays for `init_if_needed` ATAs.
   * @param params.mint - Base mint of the coin (the one whose creator fees
   *   feed the PDA — matches `DonationFeePda.base_mint`).
   * @param params.configId - The 32-byte donate.gg config id bound to the
   *   PDA; used to derive the relay's epoch tracker and debouncer PDAs.
   * @param params.donationRelayProgramId - Program id of the Donation Relay
   *   program for the target cluster (e.g. `DONATION_RELAY_PROGRAM_ID_MAINNET`
   *   or `DONATION_RELAY_PROGRAM_ID_DEVNET`).
   * @param params.quoteMint - Quote mint that the relay debounces in. Defaults
   *   to `NATIVE_MINT` (WSOL). Must equal `DonationFeePda.quote_mint`.
   */
  async crankDonationFeePda({
    payer,
    mint,
    configId,
    donationRelayProgramId,
    quoteMint = NATIVE_MINT,
  }: {
    payer: PublicKey;
    mint: PublicKey;
    configId: PublicKey;
    donationRelayProgramId: PublicKey;
    quoteMint?: PublicKey;
  }): Promise<TransactionInstruction> {
    const donationFeePdaAddress = donationFeePda(mint, configId);
    const epochTracker = donationRelayEpochTrackerPda(
      configId,
      quoteMint,
      donationRelayProgramId,
    );
    const debouncer = donationRelayDebouncerPda(
      configId,
      quoteMint,
      donationRelayProgramId,
    );

    return await this.offlinePumpFeeProgram.methods
      .crankDonationFeePda()
      .accountsPartial({
        payer,
        donationFeePda: donationFeePdaAddress,
        quoteMint,
        donationFeePdaAta: getAssociatedTokenAddressSync(
          quoteMint,
          donationFeePdaAddress,
          true,
          TOKEN_PROGRAM_ID,
        ),
        donationRelayProgram: donationRelayProgramId,
        donationRelayEventAuthority: donationRelayEventAuthorityPda(
          donationRelayProgramId,
        ),
        mintWhitelist: donationRelayMintWhitelistPda(donationRelayProgramId),
        epochTracker,
        debouncer,
        debouncerAta: getAssociatedTokenAddressSync(
          quoteMint,
          debouncer,
          true,
          TOKEN_PROGRAM_ID,
        ),
      })
      .instruction();
  }

  /**
   * Creates a social fee PDA that can accumulate fees for a social media user.
   *
   * @param params - Parameters for creating the social fee PDA
   * @param params.payer - The account paying for the transaction
   * @param params.userId - The user ID string (max 20 characters, typically the numeric social media user ID)
   * @param params.platform - Platform identifier (0=pump, 1=X, etc.)
   */
  async createSocialFeePda({
    payer,
    userId,
    platform,
  }: {
    payer: PublicKey;
    userId: string;
    platform: number;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpFeeProgram.methods
      .createSocialFeePda(userId, platform)
      .accountsPartial({
        payer,
        socialFeePda: socialFeePda(userId, platform),
      })
      .instruction();
  }

  // Internal use only
  async claimSocialFeePda({
    recipient,
    socialClaimAuthority,
    userId,
    platform,
  }: {
    recipient: PublicKey;
    socialClaimAuthority: PublicKey;
    userId: string;
    platform: number;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpFeeProgram.methods
      .claimSocialFeePda(userId, platform)
      .accountsPartial({
        recipient,
        socialFeePda: socialFeePda(userId, platform),
        socialClaimAuthority,
      })
      .instruction();
  }

  async claimCashbackInstruction({
    user,
  }: {
    user: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.offlinePumpProgram.methods
      .claimCashback()
      .accountsPartial({
        user,
      })
      .instruction();
  }

  async claimCashbackV2Instruction({
    user,
    quoteMint = NATIVE_MINT,
    quoteTokenProgram = TOKEN_PROGRAM_ID,
  }: {
    user: PublicKey;
    quoteMint?: PublicKey;
    quoteTokenProgram?: PublicKey;
  }): Promise<TransactionInstruction> {
    const userVolumeAccumulator = userVolumeAccumulatorPda(user);

    return await this.offlinePumpProgram.methods
      .claimCashbackV2()
      .accountsPartial({
        user,
        quoteMint,
        quoteTokenProgram,
        associatedUserVolumeAccumulator: quoteAta(
          userVolumeAccumulator,
          quoteMint,
          quoteTokenProgram,
        ),
        associatedQuoteUser: quoteAta(user, quoteMint, quoteTokenProgram),
      })
      .instruction();
  }
}

export const PUMP_SDK = new PumpSdk();

/**
 * Checks if a creator has migrated to using a fee sharing configuration.
 *
 * When a creator sets up fee sharing, the creator address in the BondingCurve or Pool
 * is replaced with the fee sharing config PDA address. This function checks if that
 * migration has occurred.
 *
 * @param params - Parameters for checking migration status
 * @param params.mint - The mint address of the token
 * @param params.creator - The creator address to check
 *                         - For ungraduated coins: use BondingCurve.creator
 *                         - For graduated coins: use Pool.coinCreator (from AMM pool)
 * @returns true if the creator has migrated to fee sharing config, false otherwise
 * @example
 * ```typescript
 * import { hasCoinCreatorMigratedToSharingConfig } from "@pump-fun/sdk";
 *
 * // For an ungraduated coin
 * const bondingCurve = await program.account.bondingCurve.fetch(bondingCurvePda(mint));
 * const hasMigrated = hasCoinCreatorMigratedToSharingConfig({
 *   mint,
 *   creator: bondingCurve.creator
 * });
 *
 * // For a graduated coin
 * const pool = await ammProgram.account.pool.fetch(poolAddress);
 * const hasMigrated = hasCoinCreatorMigratedToSharingConfig({
 *   mint,
 *   creator: pool.coinCreator
 * });
 *
 * if (hasMigrated) {
 *   // Creator fees are distributed according to fee sharing config
 * } else {
 *   // Creator fees go directly to the creator address
 * }
 * ```
 */
export function hasCoinCreatorMigratedToSharingConfig({
  mint,
  creator,
}: {
  mint: PublicKey;
  creator: PublicKey;
}): boolean {
  return feeSharingConfigPda(mint).equals(creator);
}

/**
 * Checks whether a sharing config reward split is editable.
 *
 * Reward split is NOT editable when:
 * - sharing config version is 1
 * - sharing config version is 2 but the admin authority has been revoked
 *
 * @param params - Parameters for editability check
 * @param params.sharingConfig - Sharing config account state
 * @returns true if reward split can be edited, false otherwise
 */
export function isSharingConfigEditable({
  sharingConfig,
}: {
  sharingConfig: SharingConfig;
}): boolean {
  if (sharingConfig.version === 1) {
    return false;
  }

  if (sharingConfig.version === 2 && sharingConfig.adminRevoked) {
    return false;
  }

  return true;
}
