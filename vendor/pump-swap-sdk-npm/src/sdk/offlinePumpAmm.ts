import { Program } from "@coral-xyz/anchor";
// Offline AMM SDK for building swap instructions
import { PumpAmm } from "../types/pump_amm";
import {
  AccountInfo,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  GLOBAL_CONFIG_PDA,
  poolV2Pda,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PUMP_AMM_PROGRAM_ID,
  userVolumeAccumulatorPda,
} from "./pda";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { depositLpToken, depositToken0 } from "./deposit";
import { withdraw } from "./withdraw";
import { buyBaseInput, buyQuoteInput } from "./buy";
import { sellBaseInput, sellQuoteInput } from "./sell";
import { getBuybackFeeRecipient, getFeeRecipient } from "./fees";
import {
  CollectCoinCreatorFeeSolanaState,
  CommonSolanaState,
  CreatePoolSolanaState,
  DepositBaseAndLpTokenFromQuoteResult,
  DepositBaseResult,
  DepositQuoteAndLpTokenFromBaseResult,
  DepositQuoteResult,
  FeeConfig,
  GlobalConfig,
  GlobalVolumeAccumulator,
  LiquidityAccounts,
  LiquiditySolanaState,
  Pool,
  SwapAccounts,
  SwapSolanaState,
  UserVolumeAccumulator,
  WithdrawAutocompleteResult,
  WithdrawResult,
} from "../types/sdk";
import { getPumpAmmProgram } from "./util";
import BN from "bn.js";

export const POOL_ACCOUNT_NEW_SIZE = 300;

export const OFFLINE_PUMP_AMM_PROGRAM = getPumpAmmProgram(
  null as any as Connection,
);

export class PumpAmmSdk {
  private readonly offlineProgram: Program<PumpAmm>;

  constructor() {
    this.offlineProgram = OFFLINE_PUMP_AMM_PROGRAM;
  }

  decodeGlobalConfig(
    globalConfigAccountInfo: AccountInfo<Buffer>,
  ): GlobalConfig {
    return this.offlineProgram.coder.accounts.decode<GlobalConfig>(
      "globalConfig",
      globalConfigAccountInfo.data,
    );
  }

  decodeFeeConfig(feeConfigAccountInfo: AccountInfo<Buffer>): FeeConfig {
    return this.offlineProgram.coder.accounts.decode<FeeConfig>(
      "feeConfig",
      feeConfigAccountInfo.data,
    );
  }

  decodePool(poolAccountInfo: AccountInfo<Buffer>) {
    return this.offlineProgram.coder.accounts.decode<Pool>(
      "pool",
      poolAccountInfo.data,
    );
  }

  decodePoolNullable(poolAccountInfo: AccountInfo<Buffer>) {
    try {
      return this.decodePool(poolAccountInfo);
    } catch (e) {
      console.warn("Failed to decode pool account", e);
      return null;
    }
  }

  decodeGlobalVolumeAccumulator(
    globalVolumeAccumulatorAccountInfo: AccountInfo<Buffer>,
  ): GlobalVolumeAccumulator {
    return this.offlineProgram.coder.accounts.decode<GlobalVolumeAccumulator>(
      "globalVolumeAccumulator",
      globalVolumeAccumulatorAccountInfo.data,
    );
  }

  decodeUserVolumeAccumulator(
    userVolumeAccumulatorAccountInfo: AccountInfo<Buffer>,
  ): UserVolumeAccumulator {
    return this.offlineProgram.coder.accounts.decode<UserVolumeAccumulator>(
      "userVolumeAccumulator",
      userVolumeAccumulatorAccountInfo.data,
    );
  }

  decodeUserVolumeAccumulatorNullable(
    userVolumeAccumulatorAccountInfo: AccountInfo<Buffer>,
  ): UserVolumeAccumulator | null {
    try {
      return this.decodeUserVolumeAccumulator(userVolumeAccumulatorAccountInfo);
    } catch (e) {
      console.warn("Failed to decode user volume accumulator", e);
      return null;
    }
  }

  async createPoolInstructions(
    createPoolSolanaState: CreatePoolSolanaState,
    baseIn: BN,
    quoteIn: BN,
  ): Promise<TransactionInstruction[]> {
    const {
      index,
      creator,
      baseMint,
      quoteMint,
      poolKey,
      baseTokenProgram,
      quoteTokenProgram,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
      userBaseAccountInfo,
      userQuoteAccountInfo,
      poolBaseAccountInfo,
      poolQuoteAccountInfo,
    } = createPoolSolanaState;

    return await this.withWsolAccounts(
      creator,
      baseMint,
      userBaseTokenAccount,
      this.accountExists(userBaseAccountInfo, baseTokenProgram),
      baseIn,
      quoteMint,
      userQuoteTokenAccount,
      this.accountExists(userQuoteAccountInfo, quoteTokenProgram),
      quoteIn,
      async () => {
        const instructions: TransactionInstruction[] = [];

        if (!this.accountExists(poolBaseAccountInfo, baseTokenProgram)) {
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              creator,
              poolBaseTokenAccount,
              poolKey,
              baseMint,
              baseTokenProgram,
            ),
          );
        }

        if (!this.accountExists(poolQuoteAccountInfo, quoteTokenProgram)) {
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              creator,
              poolQuoteTokenAccount,
              poolKey,
              quoteMint,
              quoteTokenProgram,
            ),
          );
        }

        instructions.push(
          await this.offlineProgram.methods
            .createPool(
              index,
              baseIn,
              quoteIn,
              SystemProgram.programId,
              false,
              { 0: false },
            )
            .accountsPartial({
              globalConfig: GLOBAL_CONFIG_PDA,
              baseMint,
              quoteMint,
              creator,
              userBaseTokenAccount,
              userQuoteTokenAccount,
              baseTokenProgram,
              quoteTokenProgram,
            })
            .instruction(),
        );

        return instructions;
      },
    );
  }

  async depositInstructionsInternal(
    liquiditySolanaState: LiquiditySolanaState,
    lpToken: BN,
    maxBase: BN,
    maxQuote: BN,
  ): Promise<TransactionInstruction[]> {
    const {
      pool,
      user,
      userPoolAccountInfo,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      userPoolTokenAccount,
      userBaseAccountInfo,
      userQuoteAccountInfo,
      baseTokenProgram,
      quoteTokenProgram,
    } = liquiditySolanaState;

    const { baseMint, quoteMint, lpMint } = pool;

    const liquidityAccounts = this.liquidityAccounts(liquiditySolanaState);

    return await this.withFixPoolInstructions(
      liquiditySolanaState,
      async () => {
        return await this.withWsolAccounts(
          user,
          baseMint,
          userBaseTokenAccount,
          this.accountExists(userBaseAccountInfo, baseTokenProgram),
          maxBase,
          quoteMint,
          userQuoteTokenAccount,
          this.accountExists(userQuoteAccountInfo, quoteTokenProgram),
          maxQuote,
          async () => {
            const instructions: TransactionInstruction[] = [];

            if (
              !this.accountExists(userPoolAccountInfo, TOKEN_2022_PROGRAM_ID)
            ) {
              instructions.push(
                createAssociatedTokenAccountIdempotentInstruction(
                  user,
                  userPoolTokenAccount,
                  user,
                  lpMint,
                  TOKEN_2022_PROGRAM_ID,
                ),
              );
            }

            instructions.push(
              await this.offlineProgram.methods
                .deposit(lpToken, maxBase, maxQuote)
                .accounts(liquidityAccounts)
                .instruction(),
            );

            return instructions;
          },
        );
      },
    );
  }

  private async withWsolAccounts(
    user: PublicKey,
    baseMint: PublicKey,
    userBaseAta: PublicKey,
    userBaseAtaExists: boolean,
    baseAmount: BN,
    quoteMint: PublicKey,
    userQuoteAta: PublicKey,
    userQuoteAtaExists: boolean,
    quoteAmount: BN,
    block: () => Promise<TransactionInstruction[]>,
  ) {
    return await this.withWsolAccount(
      user,
      user,
      baseMint,
      userBaseAta,
      userBaseAtaExists,
      baseAmount,
      async () =>
        this.withWsolAccount(
          user,
          user,
          quoteMint,
          userQuoteAta,
          userQuoteAtaExists,
          quoteAmount,
          block,
        ),
    );
  }

  private async withWsolAccount(
    payer: PublicKey,
    user: PublicKey,
    mint: PublicKey,
    ata: PublicKey,
    ataExists: boolean,
    amount: BN,
    block: () => Promise<TransactionInstruction[]>,
    closeWsolAccount: boolean = true,
  ): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];

    if (mint.equals(NATIVE_MINT)) {
      if (!ataExists) {
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            payer,
            ata,
            user,
            NATIVE_MINT,
          ),
        );
      }

      if (amount.gtn(0)) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: ata,
            lamports: BigInt(amount.toString()),
          }),
          createSyncNativeInstruction(ata),
        );
      }
    }

    const blockInstructions = await block();
    instructions.push(...blockInstructions);

    if (mint.equals(NATIVE_MINT) && closeWsolAccount) {
      instructions.push(
        createCloseAccountInstruction(
          ata,
          user,
          user,
          undefined,
          TOKEN_PROGRAM_ID,
        ),
      );
    }

    return instructions;
  }

  private accountExists(
    accountInfo: AccountInfo<Buffer> | null,
    owner: PublicKey,
  ): boolean {
    return accountInfo !== null && accountInfo.owner.equals(owner);
  }

  depositBaseInput(
    liquiditySolanaState: LiquiditySolanaState,
    base: BN,
    slippage: number,
  ): DepositBaseResult {
    const { pool, poolBaseTokenAccount, poolQuoteTokenAccount } =
      liquiditySolanaState;

    const { token1, lpToken, maxToken0, maxToken1 } = depositToken0(
      base,
      slippage,
      new BN(poolBaseTokenAccount.amount.toString()),
      new BN(poolQuoteTokenAccount.amount.toString()),
      pool.lpSupply,
    );

    return {
      quote: token1,
      lpToken,
      maxBase: maxToken0,
      maxQuote: maxToken1,
    };
  }

  depositQuoteInput(
    liquiditySolanaState: LiquiditySolanaState,
    quote: BN,
    slippage: number,
  ): DepositQuoteResult {
    const { pool, poolBaseTokenAccount, poolQuoteTokenAccount } =
      liquiditySolanaState;

    const { token1, lpToken, maxToken0, maxToken1 } = depositToken0(
      quote,
      slippage,
      new BN(poolQuoteTokenAccount.amount.toString()),
      new BN(poolBaseTokenAccount.amount.toString()),
      pool.lpSupply,
    );

    return {
      base: token1,
      lpToken,
      maxBase: maxToken1,
      maxQuote: maxToken0,
    };
  }

  async withdrawInstructionsInternal(
    liquiditySolanaState: LiquiditySolanaState,
    lpTokenAmountIn: BN,
    minBaseAmountOut: BN,
    minQuoteAmountOut: BN,
  ): Promise<TransactionInstruction[]> {
    const {
      pool,
      baseTokenProgram,
      quoteTokenProgram,
      user,
      userBaseAccountInfo,
      userQuoteAccountInfo,
      userBaseTokenAccount,
      userQuoteTokenAccount,
    } = liquiditySolanaState;

    const { baseMint, quoteMint } = pool;

    const liquidityAccounts = this.liquidityAccounts(liquiditySolanaState);

    return await this.withFixPoolInstructions(
      liquiditySolanaState,
      async () => {
        const instructions: TransactionInstruction[] = [];

        let baseWsolAtaCreated = false;

        if (!this.accountExists(userBaseAccountInfo, baseTokenProgram)) {
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              user,
              userBaseTokenAccount,
              user,
              baseMint,
              baseTokenProgram,
            ),
          );

          if (baseMint.equals(NATIVE_MINT)) {
            baseWsolAtaCreated = true;
          }
        }

        let quoteWsolAtaCreated = false;

        if (!this.accountExists(userQuoteAccountInfo, quoteTokenProgram)) {
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              user,
              userQuoteTokenAccount,
              user,
              quoteMint,
              quoteTokenProgram,
            ),
          );

          if (quoteMint.equals(NATIVE_MINT)) {
            quoteWsolAtaCreated = true;
          }
        }

        instructions.push(
          await this.offlineProgram.methods
            .withdraw(lpTokenAmountIn, minBaseAmountOut, minQuoteAmountOut)
            .accounts(liquidityAccounts)
            .instruction(),
        );

        if (baseWsolAtaCreated) {
          instructions.push(
            createCloseAccountInstruction(
              userBaseTokenAccount,
              user,
              user,
              undefined,
              TOKEN_PROGRAM_ID,
            ),
          );
        }

        if (quoteWsolAtaCreated) {
          instructions.push(
            createCloseAccountInstruction(
              userQuoteTokenAccount,
              user,
              user,
              undefined,
              TOKEN_PROGRAM_ID,
            ),
          );
        }

        return instructions;
      },
    );
  }

  withdrawInputs(
    liquiditySolanaState: LiquiditySolanaState,
    lpAmount: BN,
    slippage: number,
  ): WithdrawResult {
    const { pool, poolBaseTokenAccount, poolQuoteTokenAccount } =
      liquiditySolanaState;

    return withdraw(
      lpAmount,
      slippage,
      new BN(poolBaseTokenAccount.amount.toString()),
      new BN(poolQuoteTokenAccount.amount.toString()),
      pool.lpSupply,
    );
  }

  private liquidityAccounts(
    liquiditySolanaState: LiquiditySolanaState,
  ): LiquidityAccounts {
    const {
      poolKey,
      pool,
      user,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      userPoolTokenAccount,
    } = liquiditySolanaState;

    const {
      baseMint,
      quoteMint,
      lpMint,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
    } = pool;

    return {
      pool: poolKey,
      globalConfig: GLOBAL_CONFIG_PDA,
      user,
      baseMint,
      quoteMint,
      lpMint,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      userPoolTokenAccount,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      program: PUMP_AMM_PROGRAM_ID,
    };
  }

  async buyInstructions(
    swapSolanaState: SwapSolanaState,
    baseOut: BN,
    maxQuoteIn: BN,
  ): Promise<TransactionInstruction[]> {
    return await this.withFixPoolInstructions(swapSolanaState, async () => {
      return await this.buyInstructionsNoPool(
        swapSolanaState,
        baseOut,
        maxQuoteIn,
      );
    });
  }

  async buyInstructionsNoPool(
    swapSolanaState: SwapSolanaState,
    baseOut: BN,
    maxQuoteIn: BN,
  ): Promise<TransactionInstruction[]> {
    const { userBaseAccountInfo, userQuoteAccountInfo, pool } = swapSolanaState;

    const swapAccounts = this.swapAccounts(swapSolanaState);

    const {
      user,
      baseMint,
      quoteMint,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      baseTokenProgram,
      quoteTokenProgram,
      buybackFeeRecipient,
      buybackFeeRecipientTokenAccount,
    } = swapAccounts;
    const poolV2PdaKey = poolV2Pda(pool.baseMint);
    return this.withWsolAccount(
      user,
      user,
      quoteMint,
      userQuoteTokenAccount,
      this.accountExists(userQuoteAccountInfo, quoteTokenProgram),
      maxQuoteIn,
      async () => {
        const instructions = [];

        if (!this.accountExists(userBaseAccountInfo, baseTokenProgram)) {
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              user,
              userBaseTokenAccount,
              user,
              baseMint,
              baseTokenProgram,
            ),
          );
        }
        const remainingAccounts = [];
        if (pool.isCashbackCoin) {
          remainingAccounts.push({
            pubkey: getAssociatedTokenAddressSync(
              NATIVE_MINT,
              userVolumeAccumulatorPda(user),
              true,
              quoteTokenProgram,
            ),
            isWritable: true,
            isSigner: false,
          });
        }
        if (!pool.coinCreator.equals(PublicKey.default)) {
          remainingAccounts.push({
            pubkey: poolV2PdaKey,
            isWritable: false,
            isSigner: false,
          });
        }

        remainingAccounts.push(
          {
            pubkey: buybackFeeRecipient,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey: buybackFeeRecipientTokenAccount,
            isWritable: true,
            isSigner: false,
          },
        );

        const instruction = await this.offlineProgram.methods
          .buy(baseOut, maxQuoteIn, { 0: true })
          .accounts(swapAccounts)
          .remainingAccounts([...remainingAccounts])
          .instruction();

        instructions.push(instruction);

        if (baseMint.equals(NATIVE_MINT)) {
          instructions.push(
            createCloseAccountInstruction(
              userBaseTokenAccount,
              user,
              user,
              undefined,
              TOKEN_PROGRAM_ID,
            ),
          );
        }

        return instructions;
      },
    );
  }

  async buyBaseInput(
    swapSolanaState: SwapSolanaState,
    base: BN,
    slippage: number,
  ): Promise<TransactionInstruction[]> {
    const {
      baseMint,
      baseMintAccount,
      feeConfig,
      globalConfig,
      pool,
      poolBaseAmount,
      poolQuoteAmount,
    } = swapSolanaState;
    const { coinCreator, creator } = pool;

    const { maxQuote } = buyBaseInput({
      base,
      slippage,
      baseReserve: poolBaseAmount,
      quoteReserve: poolQuoteAmount,
      baseMintAccount,
      baseMint,
      coinCreator,
      creator,
      feeConfig,
      globalConfig,
    });

    return this.buyInstructions(swapSolanaState, base, maxQuote);
  }

  async buyQuoteInput(
    swapSolanaState: SwapSolanaState,
    quote: BN,
    slippage: number,
  ): Promise<TransactionInstruction[]> {
    const {
      baseMint,
      baseMintAccount,
      feeConfig,
      globalConfig,
      pool,
      poolBaseAmount,
      poolQuoteAmount,
    } = swapSolanaState;
    const { coinCreator, creator } = pool;

    const { base, maxQuote } = buyQuoteInput({
      quote,
      slippage,
      baseReserve: poolBaseAmount,
      quoteReserve: poolQuoteAmount,
      baseMintAccount,
      baseMint,
      coinCreator,
      creator,
      feeConfig,
      globalConfig,
    });

    return this.buyInstructions(swapSolanaState, base, maxQuote);
  }

  async sellInstructions(
    swapSolanaState: SwapSolanaState,
    baseAmountIn: BN,
    minQuoteAmountOut: BN,
  ): Promise<TransactionInstruction[]> {
    return await this.withFixPoolInstructions(swapSolanaState, async () => {
      return await this.sellInstructionsNoPool(
        swapSolanaState,
        baseAmountIn,
        minQuoteAmountOut,
      );
    });
  }

  private async withFixPoolInstructions(
    commonSolanaState: CommonSolanaState,
    block: () => Promise<TransactionInstruction[]>,
  ): Promise<TransactionInstruction[]> {
    const { poolAccountInfo, poolKey, user } = commonSolanaState;

    const instructions: TransactionInstruction[] = [];

    if (
      poolAccountInfo === null ||
      poolAccountInfo.data.length < POOL_ACCOUNT_NEW_SIZE
    ) {
      instructions.push(
        await this.offlineProgram.methods
          .extendAccount()
          .accountsPartial({
            account: poolKey,
            user,
          })
          .instruction(),
      );
    }

    return [...instructions, ...(await block())];
  }

  async sellInstructionsNoPool(
    swapSolanaState: SwapSolanaState,
    baseAmountIn: BN,
    minQuoteAmountOut: BN,
  ): Promise<TransactionInstruction[]> {
    const { userBaseAccountInfo, userQuoteAccountInfo, pool } = swapSolanaState;

    const swapAccounts = this.swapAccounts(swapSolanaState);
    const poolV2PdaKey = poolV2Pda(pool.baseMint);
    const {
      user,
      baseMint,
      quoteMint,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      baseTokenProgram,
      quoteTokenProgram,
      buybackFeeRecipient,
      buybackFeeRecipientTokenAccount,
    } = swapAccounts;

    return this.withWsolAccount(
      user,
      user,
      baseMint,
      userBaseTokenAccount,
      this.accountExists(userBaseAccountInfo, baseTokenProgram),
      baseAmountIn,
      async () => {
        const instructions = [];

        if (!this.accountExists(userQuoteAccountInfo, quoteTokenProgram)) {
          instructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              user,
              userQuoteTokenAccount,
              user,
              quoteMint,
              quoteTokenProgram,
            ),
          );
        }
        const remainingAccounts = [];
        if (pool.isCashbackCoin) {
          remainingAccounts.push(
            {
              pubkey: getAssociatedTokenAddressSync(
                quoteMint,
                userVolumeAccumulatorPda(user),
                true,
                quoteTokenProgram,
              ),
              isWritable: true,
              isSigner: false,
            },
            {
              pubkey: userVolumeAccumulatorPda(user),
              isWritable: true,
              isSigner: false,
            },
          );
        }
        if (!pool.coinCreator.equals(PublicKey.default)) {
          remainingAccounts.push({
            pubkey: poolV2PdaKey,
            isWritable: false,
            isSigner: false,
          });
        }

        remainingAccounts.push(
          {
            pubkey: buybackFeeRecipient,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey: buybackFeeRecipientTokenAccount,
            isWritable: true,
            isSigner: false,
          },
        );

        instructions.push(
          await this.offlineProgram.methods
            .sell(baseAmountIn, minQuoteAmountOut)
            .accounts(swapAccounts)
            .remainingAccounts([...remainingAccounts])
            .instruction(),
        );
        if (quoteMint.equals(NATIVE_MINT)) {
          instructions.push(
            createCloseAccountInstruction(
              userQuoteTokenAccount,
              user,
              user,
              undefined,
              TOKEN_PROGRAM_ID,
            ),
          );
        }

        return instructions;
      },
    );
  }

  async sellBaseInput(
    swapSolanaState: SwapSolanaState,
    base: BN,
    slippage: number,
  ): Promise<TransactionInstruction[]> {
    const {
      baseMint,
      baseMintAccount,
      feeConfig,
      globalConfig,
      pool,
      poolBaseAmount,
      poolQuoteAmount,
    } = swapSolanaState;
    const { coinCreator, creator } = pool;

    const { minQuote } = sellBaseInput({
      base,
      slippage,
      baseReserve: poolBaseAmount,
      quoteReserve: poolQuoteAmount,
      baseMintAccount,
      baseMint,
      coinCreator,
      creator,
      feeConfig,
      globalConfig,
    });

    return this.sellInstructions(swapSolanaState, base, minQuote);
  }

  async sellQuoteInput(
    swapSolanaState: SwapSolanaState,
    quote: BN,
    slippage: number,
  ): Promise<TransactionInstruction[]> {
    const {
      baseMint,
      baseMintAccount,
      feeConfig,
      globalConfig,
      pool,
      poolBaseAmount,
      poolQuoteAmount,
    } = swapSolanaState;
    const { coinCreator, creator } = pool;

    const { base, minQuote } = sellQuoteInput({
      quote,
      slippage,
      baseReserve: poolBaseAmount,
      quoteReserve: poolQuoteAmount,
      baseMintAccount,
      baseMint,
      coinCreator,
      creator,
      feeConfig,
      globalConfig,
    });

    return this.sellInstructions(swapSolanaState, base, minQuote);
  }

  async extendAccount(
    account: PublicKey,
    user: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.offlineProgram.methods
      .extendAccount()
      .accountsPartial({
        account,
        user,
      })
      .instruction();
  }

  async collectCoinCreatorFee(
    collectCoinCreatorFeeSolanaState: CollectCoinCreatorFeeSolanaState,
    payer: PublicKey | undefined = undefined,
  ): Promise<TransactionInstruction[]> {
    const {
      coinCreator,
      quoteMint,
      quoteTokenProgram,
      coinCreatorVaultAuthority,
      coinCreatorVaultAta,
      coinCreatorTokenAccount,
      coinCreatorVaultAtaAccountInfo,
      coinCreatorTokenAccountInfo,
    } = collectCoinCreatorFeeSolanaState;

    const actualPayer = payer ?? coinCreator;
    const shouldCloseCoinCreatorATA = coinCreator.equals(actualPayer);

    return await this.withWsolAccount(
      actualPayer,
      coinCreatorVaultAuthority,
      quoteMint,
      coinCreatorVaultAta,
      this.accountExists(coinCreatorVaultAtaAccountInfo, quoteTokenProgram),
      new BN(0),
      async () => {
        return await this.withWsolAccount(
          actualPayer,
          coinCreator,
          quoteMint,
          coinCreatorTokenAccount,
          this.accountExists(coinCreatorTokenAccountInfo, quoteTokenProgram),
          new BN(0),
          async () => {
            return [
              await this.offlineProgram.methods
                .collectCoinCreatorFee()
                .accountsPartial({
                  coinCreator,
                  coinCreatorTokenAccount,
                  quoteMint,
                  quoteTokenProgram,
                })
                .instruction(),
            ];
          },
          shouldCloseCoinCreatorATA,
        );
      },
      false,
    );
  }

  async setCoinCreator(pool: PublicKey): Promise<TransactionInstruction> {
    return this.offlineProgram.methods
      .setCoinCreator()
      .accountsPartial({
        pool,
      })
      .instruction();
  }

  private swapAccounts(swapSolanaState: SwapSolanaState): SwapAccounts {
    const {
      globalConfig,
      poolKey,
      pool,
      baseTokenProgram,
      quoteTokenProgram,
      user,
      userBaseTokenAccount,
      userQuoteTokenAccount,
    } = swapSolanaState;

    const protocolFeeRecipient = getFeeRecipient(
      globalConfig,
      pool.isMayhemMode,
    );

    const buybackFeeRecipient = getBuybackFeeRecipient(globalConfig);

    const {
      baseMint,
      quoteMint,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
      coinCreator,
    } = pool;

    const coinCreatorVaultAuthority = coinCreatorVaultAuthorityPda(coinCreator);

    return {
      pool: poolKey,
      globalConfig: GLOBAL_CONFIG_PDA,
      user,
      baseMint,
      quoteMint,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
      protocolFeeRecipient,
      protocolFeeRecipientTokenAccount: getAssociatedTokenAddressSync(
        quoteMint,
        protocolFeeRecipient,
        true,
        quoteTokenProgram,
      ),
      buybackFeeRecipient,
      buybackFeeRecipientTokenAccount: getAssociatedTokenAddressSync(
        quoteMint,
        buybackFeeRecipient,
        true,
        quoteTokenProgram,
      ),
      baseTokenProgram,
      quoteTokenProgram,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      program: PUMP_AMM_PROGRAM_ID,
      coinCreatorVaultAta: coinCreatorVaultAtaPda(
        coinCreatorVaultAuthority,
        quoteMint,
        quoteTokenProgram,
      ),
      coinCreatorVaultAuthority,
    };
  }

  async syncUserVolumeAccumulator(
    user: PublicKey,
  ): Promise<TransactionInstruction> {
    return await this.offlineProgram.methods
      .syncUserVolumeAccumulator()
      .accountsPartial({ user })
      .instruction();
  }

  async initUserVolumeAccumulator({
    payer,
    user,
  }: {
    payer: PublicKey;
    user: PublicKey;
  }): Promise<TransactionInstruction> {
    return await this.offlineProgram.methods
      .initUserVolumeAccumulator()
      .accountsPartial({ payer, user })
      .instruction();
  }

  async closeUserVolumeAccumulator(
    user: PublicKey,
  ): Promise<TransactionInstruction> {
    return await this.offlineProgram.methods
      .closeUserVolumeAccumulator()
      .accountsPartial({ user })
      .instruction();
  }

  // from pumpAmm
  async createAutocompleteInitialPoolPrice(
    initialBase: BN,
    initialQuote: BN,
  ): Promise<BN> {
    return initialQuote.div(initialBase);
  }

  async depositInstructions(
    liquiditySolanaState: LiquiditySolanaState,
    lpToken: BN,
    slippage: number,
  ): Promise<TransactionInstruction[]> {
    const { pool, poolBaseTokenAccount, poolQuoteTokenAccount } =
      liquiditySolanaState;

    const { maxBase, maxQuote } = depositLpToken(
      lpToken,
      slippage,
      new BN(poolBaseTokenAccount.amount.toString()),
      new BN(poolQuoteTokenAccount.amount.toString()),
      pool.lpSupply,
    );

    return this.depositInstructionsInternal(
      liquiditySolanaState,
      lpToken,
      maxBase,
      maxQuote,
    );
  }

  depositAutocompleteQuoteAndLpTokenFromBase(
    liquiditySolanaState: LiquiditySolanaState,
    base: BN,
    slippage: number,
  ): DepositQuoteAndLpTokenFromBaseResult {
    const { quote, lpToken } = this.depositBaseInput(
      liquiditySolanaState,
      base,
      slippage,
    );

    return {
      quote,
      lpToken,
    };
  }

  depositAutocompleteBaseAndLpTokenFromQuote(
    liquiditySolanaState: LiquiditySolanaState,
    quote: BN,
    slippage: number,
  ): DepositBaseAndLpTokenFromQuoteResult {
    const { base, lpToken } = this.depositQuoteInput(
      liquiditySolanaState,
      quote,
      slippage,
    );

    return {
      base,
      lpToken,
    };
  }

  async withdrawInstructions(
    liquiditySolanaState: LiquiditySolanaState,
    lpToken: BN,
    slippage: number,
  ): Promise<TransactionInstruction[]> {
    const { minBase, minQuote } = this.withdrawInputs(
      liquiditySolanaState,
      lpToken,
      slippage,
    );

    return this.withdrawInstructionsInternal(
      liquiditySolanaState,
      lpToken,
      minBase,
      minQuote,
    );
  }

  withdrawAutoCompleteBaseAndQuoteFromLpToken(
    liquiditySolanaState: LiquiditySolanaState,
    lpAmount: BN,
    slippage: number,
  ): WithdrawAutocompleteResult {
    const { base, quote } = this.withdrawInputs(
      liquiditySolanaState,
      lpAmount,
      slippage,
    );

    return {
      base,
      quote,
    };
  }
}

export const PUMP_AMM_SDK = new PumpAmmSdk();
