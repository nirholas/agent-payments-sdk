import { Program } from "@coral-xyz/anchor";
import { PumpAmm } from "../types/pump_amm";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  GLOBAL_CONFIG_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  poolPda,
  PUMP_AMM_FEE_CONFIG_PDA,
  userVolumeAccumulatorPda,
} from "./pda";
import {
  AccountLayout,
  getAccount,
  getAssociatedTokenAddressSync,
  MintLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  CollectCoinCreatorFeeSolanaState,
  CreatePoolSolanaState,
  FeeConfig,
  GlobalConfig,
  GlobalVolumeAccumulator,
  LiquiditySolanaState,
  Pool,
  SwapSolanaState,
  UserVolumeAccumulator,
} from "../types/sdk";
import { getPumpAmmProgram } from "./util";
import BN from "bn.js";
import { currentDayTokens, totalUnclaimedTokens } from "./tokenIncentives";
import { OFFLINE_PUMP_AMM_PROGRAM, PUMP_AMM_SDK } from "./offlinePumpAmm";

export class OnlinePumpAmmSdk {
  public readonly connection: Connection;
  private readonly program: Program<PumpAmm>;

  constructor(connection: Connection) {
    this.connection = connection;
    this.program = getPumpAmmProgram(connection);
  }

  fetchGlobalConfigAccount(): Promise<GlobalConfig> {
    return this.program.account.globalConfig.fetch(GLOBAL_CONFIG_PDA);
  }

  fetchFeeConfigAccount(): Promise<FeeConfig> {
    return this.program.account.feeConfig.fetch(PUMP_AMM_FEE_CONFIG_PDA);
  }

  fetchPool(pool: PublicKey): Promise<Pool> {
    return this.program.account.pool.fetch(pool);
  }

  fetchGlobalVolumeAccumulator(): Promise<GlobalVolumeAccumulator> {
    return this.program.account.globalVolumeAccumulator.fetch(
      GLOBAL_VOLUME_ACCUMULATOR_PDA,
    );
  }

  fetchUserVolumeAccumulator(
    user: PublicKey,
  ): Promise<UserVolumeAccumulator | null> {
    return this.program.account.userVolumeAccumulator.fetchNullable(
      userVolumeAccumulatorPda(user),
    );
  }

  async createPoolSolanaState(
    index: number,
    creator: PublicKey,
    baseMint: PublicKey,
    quoteMint: PublicKey,
    userBaseTokenAccount: PublicKey | undefined = undefined,
    userQuoteTokenAccount: PublicKey | undefined = undefined,
  ): Promise<CreatePoolSolanaState> {
    const [globalConfigAccountInfo, baseMintAccountInfo, quoteMintAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        GLOBAL_CONFIG_PDA,
        baseMint,
        quoteMint,
      ]);

    if (globalConfigAccountInfo === null) {
      throw new Error("Global config account not found");
    }

    if (baseMintAccountInfo === null) {
      throw new Error(`baseMint=${baseMint.toString()} not found`);
    }

    if (quoteMintAccountInfo === null) {
      throw new Error(`quoteMint=${quoteMint.toString()} not found`);
    }

    const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(
      globalConfigAccountInfo,
    );

    const [baseTokenProgram, quoteTokenProgram] = [
      baseMintAccountInfo.owner,
      quoteMintAccountInfo.owner,
    ];

    const poolKey = poolPda(index, creator, baseMint, quoteMint);

    const poolBaseTokenAccount = getAssociatedTokenAddressSync(
      baseMint,
      poolKey,
      true,
      baseTokenProgram,
    );

    const poolQuoteTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      poolKey,
      true,
      quoteTokenProgram,
    );

    const [poolBaseAccountInfo, poolQuoteAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        poolBaseTokenAccount,
        poolQuoteTokenAccount,
      ]);

    if (userBaseTokenAccount === undefined) {
      userBaseTokenAccount = getAssociatedTokenAddressSync(
        baseMint,
        creator,
        true,
        baseTokenProgram,
      );
    }

    if (userQuoteTokenAccount === undefined) {
      userQuoteTokenAccount = getAssociatedTokenAddressSync(
        quoteMint,
        creator,
        true,
        quoteTokenProgram,
      );
    }

    const [userBaseAccountInfo, userQuoteAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        userBaseTokenAccount,
        userQuoteTokenAccount,
      ]);

    return {
      index,
      creator,
      baseMint,
      quoteMint,
      globalConfig,
      poolKey,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
      baseTokenProgram,
      quoteTokenProgram,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      userBaseAccountInfo,
      userQuoteAccountInfo,
      poolBaseAccountInfo,
      poolQuoteAccountInfo,
    };
  }

  async swapSolanaState(
    poolKey: PublicKey,
    user: PublicKey,
    userBaseTokenAccount: PublicKey | undefined = undefined,
    userQuoteTokenAccount: PublicKey | undefined = undefined,
  ): Promise<SwapSolanaState> {
    const [globalConfigAccountInfo, feeConfigAccountInfo, poolAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        GLOBAL_CONFIG_PDA,
        PUMP_AMM_FEE_CONFIG_PDA,
        poolKey,
      ]);

    if (globalConfigAccountInfo === null) {
      throw new Error("Global config account not found");
    }

    if (poolAccountInfo === null) {
      throw new Error("Pool account not found");
    }

    const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(
      globalConfigAccountInfo,
    );
    const feeConfig = feeConfigAccountInfo
      ? PUMP_AMM_SDK.decodeFeeConfig(feeConfigAccountInfo)
      : null;
    const pool = PUMP_AMM_SDK.decodePool(poolAccountInfo);

    const { baseMint, quoteMint, poolBaseTokenAccount, poolQuoteTokenAccount } =
      pool;

    const [
      baseMintAccountInfo,
      quoteMintAccountInfo,
      poolBaseAccountInfo,
      poolQuoteAccountInfo,
    ] = await this.connection.getMultipleAccountsInfo([
      baseMint,
      quoteMint,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
    ]);

    if (baseMintAccountInfo === null) {
      throw new Error(`baseMint=${baseMint.toString()} not found`);
    }

    const decodedBaseMintAccount = MintLayout.decode(baseMintAccountInfo.data);

    if (quoteMintAccountInfo === null) {
      throw new Error(`quoteMint=${quoteMint.toString()} not found`);
    }

    if (poolBaseAccountInfo === null) {
      throw new Error(
        `Pool base token account ${poolBaseTokenAccount.toString()} not found`,
      );
    }

    if (poolQuoteAccountInfo === null) {
      throw new Error(
        `Pool quote token account ${poolQuoteTokenAccount.toString()} not found`,
      );
    }

    const [baseTokenProgram, quoteTokenProgram] = [
      baseMintAccountInfo.owner,
      quoteMintAccountInfo.owner,
    ];

    const decodedPoolBaseTokenAccount = AccountLayout.decode(
      poolBaseAccountInfo.data,
    );
    const decodedPoolQuoteTokenAccount = AccountLayout.decode(
      poolQuoteAccountInfo.data,
    );

    if (userBaseTokenAccount === undefined) {
      userBaseTokenAccount = getAssociatedTokenAddressSync(
        baseMint,
        user,
        true,
        baseTokenProgram,
      );
    }

    if (userQuoteTokenAccount === undefined) {
      userQuoteTokenAccount = getAssociatedTokenAddressSync(
        quoteMint,
        user,
        true,
        quoteTokenProgram,
      );
    }

    const [userBaseAccountInfo, userQuoteAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        userBaseTokenAccount,
        userQuoteTokenAccount,
      ]);

    return {
      globalConfig,
      feeConfig,
      poolKey,
      poolAccountInfo,
      pool,
      poolBaseAmount: new BN(decodedPoolBaseTokenAccount.amount.toString()),
      poolQuoteAmount: new BN(decodedPoolQuoteTokenAccount.amount.toString()),
      baseTokenProgram,
      quoteTokenProgram,
      baseMint,
      baseMintAccount: decodedBaseMintAccount,
      user,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      userBaseAccountInfo,
      userQuoteAccountInfo,
    };
  }

  async swapSolanaStateNoPool(
    poolKey: PublicKey,
    user: PublicKey,
    userBaseTokenAccount: PublicKey | undefined = undefined,
    userQuoteTokenAccount: PublicKey | undefined = undefined,
  ): Promise<SwapSolanaState> {
    const [globalConfigAccountInfo, feeConfigAccountInfo, poolAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        GLOBAL_CONFIG_PDA,
        PUMP_AMM_FEE_CONFIG_PDA,
        poolKey,
      ]);

    if (globalConfigAccountInfo === null) {
      throw new Error("Global config account not found");
    }

    if (poolAccountInfo === null) {
      throw new Error("Pool account not found");
    }

    const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(
      globalConfigAccountInfo,
    );
    const feeConfig = feeConfigAccountInfo
      ? PUMP_AMM_SDK.decodeFeeConfig(feeConfigAccountInfo)
      : null;
    const pool = PUMP_AMM_SDK.decodePool(poolAccountInfo);

    const { baseMint, quoteMint, poolBaseTokenAccount, poolQuoteTokenAccount } =
      pool;

    const [
      baseMintAccountInfo,
      quoteMintAccountInfo,
      poolBaseAccountInfo,
      poolQuoteAccountInfo,
    ] = await this.connection.getMultipleAccountsInfo([
      baseMint,
      quoteMint,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
    ]);

    if (baseMintAccountInfo === null) {
      throw new Error(`baseMint=${baseMint.toString()} not found`);
    }

    const decodedBaseMintAccount = MintLayout.decode(baseMintAccountInfo.data);

    if (quoteMintAccountInfo === null) {
      throw new Error(`quoteMint=${quoteMint.toString()} not found`);
    }

    if (poolBaseAccountInfo === null) {
      throw new Error(
        `Pool base token account ${poolBaseTokenAccount.toString()} not found`,
      );
    }

    if (poolQuoteAccountInfo === null) {
      throw new Error(
        `Pool quote token account ${poolQuoteTokenAccount.toString()} not found`,
      );
    }

    const [baseTokenProgram, quoteTokenProgram] = [
      baseMintAccountInfo.owner,
      quoteMintAccountInfo.owner,
    ];

    const decodedPoolBaseTokenAccount = AccountLayout.decode(
      poolBaseAccountInfo.data,
    );
    const decodedPoolQuoteTokenAccount = AccountLayout.decode(
      poolQuoteAccountInfo.data,
    );

    if (userBaseTokenAccount === undefined) {
      userBaseTokenAccount = getAssociatedTokenAddressSync(
        baseMint,
        user,
        true,
        baseTokenProgram,
      );
    }

    if (userQuoteTokenAccount === undefined) {
      userQuoteTokenAccount = getAssociatedTokenAddressSync(
        quoteMint,
        user,
        true,
        quoteTokenProgram,
      );
    }

    const [userBaseAccountInfo, userQuoteAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        userBaseTokenAccount,
        userQuoteTokenAccount,
      ]);

    return {
      globalConfig,
      feeConfig,
      poolKey,
      poolAccountInfo,
      pool,
      poolBaseAmount: new BN(decodedPoolBaseTokenAccount.amount.toString()),
      poolQuoteAmount: new BN(decodedPoolQuoteTokenAccount.amount.toString()),
      baseTokenProgram,
      quoteTokenProgram,
      baseMint,
      baseMintAccount: decodedBaseMintAccount,
      user,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      userBaseAccountInfo,
      userQuoteAccountInfo,
    };
  }

  async liquiditySolanaState(
    poolKey: PublicKey,
    user: PublicKey,
    userBaseTokenAccount: PublicKey | undefined = undefined,
    userQuoteTokenAccount: PublicKey | undefined = undefined,
    userPoolTokenAccount: PublicKey | undefined = undefined,
  ): Promise<LiquiditySolanaState> {
    const [globalConfigAccountInfo, poolAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        GLOBAL_CONFIG_PDA,
        poolKey,
      ]);

    if (globalConfigAccountInfo === null) {
      throw new Error("Global config account not found");
    }

    if (poolAccountInfo === null) {
      throw new Error("Pool account not found");
    }

    const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(
      globalConfigAccountInfo,
    );
    const pool = PUMP_AMM_SDK.decodePool(poolAccountInfo);

    const {
      baseMint,
      quoteMint,
      lpMint,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
    } = pool;

    const [
      baseMintAccountInfo,
      quoteMintAccountInfo,
      poolBaseAccountInfo,
      poolQuoteAccountInfo,
    ] = await this.connection.getMultipleAccountsInfo([
      baseMint,
      quoteMint,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
    ]);

    if (baseMintAccountInfo === null) {
      throw new Error(`baseMint=${baseMint.toString()} not found`);
    }

    if (quoteMintAccountInfo === null) {
      throw new Error(`quoteMint=${quoteMint.toString()} not found`);
    }

    if (poolBaseAccountInfo === null) {
      throw new Error(
        `Pool base token account ${poolBaseTokenAccount.toString()} not found`,
      );
    }

    if (poolQuoteAccountInfo === null) {
      throw new Error(
        `Pool quote token account ${poolQuoteTokenAccount.toString()} not found`,
      );
    }

    const [baseTokenProgram, quoteTokenProgram] = [
      baseMintAccountInfo.owner,
      quoteMintAccountInfo.owner,
    ];

    const decodedPoolBaseTokenAccount = AccountLayout.decode(
      poolBaseAccountInfo.data,
    );
    const decodedPoolQuoteTokenAccount = AccountLayout.decode(
      poolQuoteAccountInfo.data,
    );

    if (userBaseTokenAccount === undefined) {
      userBaseTokenAccount = getAssociatedTokenAddressSync(
        baseMint,
        user,
        true,
        baseTokenProgram,
      );
    }

    if (userQuoteTokenAccount === undefined) {
      userQuoteTokenAccount = getAssociatedTokenAddressSync(
        quoteMint,
        user,
        true,
        quoteTokenProgram,
      );
    }

    if (userPoolTokenAccount === undefined) {
      userPoolTokenAccount = getAssociatedTokenAddressSync(
        lpMint,
        user,
        true,
        TOKEN_2022_PROGRAM_ID,
      );
    }

    const [userBaseAccountInfo, userQuoteAccountInfo, userPoolAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        userBaseTokenAccount,
        userQuoteTokenAccount,
        userPoolTokenAccount,
      ]);

    return {
      globalConfig,
      poolKey,
      poolAccountInfo,
      pool,
      poolBaseTokenAccount: decodedPoolBaseTokenAccount,
      poolQuoteTokenAccount: decodedPoolQuoteTokenAccount,
      baseTokenProgram,
      quoteTokenProgram,
      user,
      userBaseTokenAccount,
      userQuoteTokenAccount,
      userPoolTokenAccount,
      userBaseAccountInfo,
      userQuoteAccountInfo,
      userPoolAccountInfo,
    };
  }

  async collectCoinCreatorFeeSolanaState(
    coinCreator: PublicKey,
    coinCreatorTokenAccount: PublicKey | undefined = undefined,
  ): Promise<CollectCoinCreatorFeeSolanaState> {
    const quoteMint = NATIVE_MINT;
    const quoteTokenProgram = TOKEN_PROGRAM_ID;

    let coinCreatorVaultAuthority = coinCreatorVaultAuthorityPda(coinCreator);

    let coinCreatorVaultAta = coinCreatorVaultAtaPda(
      coinCreatorVaultAuthority,
      quoteMint,
      quoteTokenProgram,
    );

    if (coinCreatorTokenAccount === undefined) {
      coinCreatorTokenAccount = getAssociatedTokenAddressSync(
        quoteMint,
        coinCreator,
        true,
        quoteTokenProgram,
      );
    }

    const [coinCreatorVaultAtaAccountInfo, coinCreatorTokenAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        coinCreatorVaultAta,
        coinCreatorTokenAccount,
      ]);

    return {
      coinCreator,
      quoteMint,
      quoteTokenProgram,
      coinCreatorVaultAuthority,
      coinCreatorVaultAta,
      coinCreatorTokenAccount,
      coinCreatorVaultAtaAccountInfo,
      coinCreatorTokenAccountInfo,
    };
  }

  async getCoinCreatorVaultBalance(coinCreator: PublicKey): Promise<BN> {
    const quoteMint = NATIVE_MINT;
    const quoteTokenProgram = TOKEN_PROGRAM_ID;

    const coinCreatorVaultAuthority = coinCreatorVaultAuthorityPda(coinCreator);

    const coinCreatorVaultAta = coinCreatorVaultAtaPda(
      coinCreatorVaultAuthority,
      quoteMint,
      quoteTokenProgram,
    );

    try {
      const tokenAccount = await getAccount(
        this.connection,
        coinCreatorVaultAta,
        undefined,
        quoteTokenProgram,
      );
      return new BN(tokenAccount.amount.toString());
    } catch (e) {
      console.warn(`Error fetching token account ${coinCreatorVaultAta}:`, e);
      return new BN(0);
    }
  }

  async claimTokenIncentives(
    user: PublicKey,
    payer: PublicKey,
  ): Promise<TransactionInstruction[]> {
    const { mint } = await this.fetchGlobalVolumeAccumulator();

    if (mint.equals(PublicKey.default)) {
      return [];
    }

    const [mintAccountInfo, userAccumulatorAccountInfo] =
      await this.connection.getMultipleAccountsInfo([
        mint,
        userVolumeAccumulatorPda(user),
      ]);

    if (!mintAccountInfo) {
      return [];
    }

    if (!userAccumulatorAccountInfo) {
      return [];
    }

    return [
      await OFFLINE_PUMP_AMM_PROGRAM.methods
        .claimTokenIncentives()
        .accountsPartial({
          user,
          payer,
          mint,
          tokenProgram: mintAccountInfo.owner,
        })
        .instruction(),
    ];
  }

  async getTotalUnclaimedTokens(user: PublicKey): Promise<BN> {
    const [
      globalVolumeAccumulatorAccountInfo,
      userVolumeAccumulatorAccountInfo,
    ] = await this.connection.getMultipleAccountsInfo([
      GLOBAL_VOLUME_ACCUMULATOR_PDA,
      userVolumeAccumulatorPda(user),
    ]);

    if (
      !globalVolumeAccumulatorAccountInfo ||
      !userVolumeAccumulatorAccountInfo
    ) {
      return new BN(0);
    }

    const globalVolumeAccumulator = PUMP_AMM_SDK.decodeGlobalVolumeAccumulator(
      globalVolumeAccumulatorAccountInfo,
    );
    const userVolumeAccumulator = PUMP_AMM_SDK.decodeUserVolumeAccumulator(
      userVolumeAccumulatorAccountInfo,
    );

    return totalUnclaimedTokens(globalVolumeAccumulator, userVolumeAccumulator);
  }

  async getCurrentDayTokens(user: PublicKey): Promise<BN> {
    const [
      globalVolumeAccumulatorAccountInfo,
      userVolumeAccumulatorAccountInfo,
    ] = await this.connection.getMultipleAccountsInfo([
      GLOBAL_VOLUME_ACCUMULATOR_PDA,
      userVolumeAccumulatorPda(user),
    ]);

    if (
      !globalVolumeAccumulatorAccountInfo ||
      !userVolumeAccumulatorAccountInfo
    ) {
      return new BN(0);
    }

    const globalVolumeAccumulator = PUMP_AMM_SDK.decodeGlobalVolumeAccumulator(
      globalVolumeAccumulatorAccountInfo,
    );
    const userVolumeAccumulator = PUMP_AMM_SDK.decodeUserVolumeAccumulator(
      userVolumeAccumulatorAccountInfo,
    );

    return currentDayTokens(globalVolumeAccumulator, userVolumeAccumulator);
  }
}
