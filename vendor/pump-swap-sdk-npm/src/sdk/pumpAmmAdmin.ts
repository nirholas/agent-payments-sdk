import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PumpAmm } from "../types/pump_amm";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { canonicalPumpPoolPda, GLOBAL_CONFIG_PDA, PUMP_MINT } from "./pda";
import { getPumpAmmProgram } from "./util";

export class PumpAmmAdminSdk {
  private readonly program: Program<PumpAmm>;

  constructor(connection: Connection) {
    this.program = getPumpAmmProgram(connection);
  }

  fetchGlobalConfigAccount() {
    return this.program.account.globalConfig.fetch(GLOBAL_CONFIG_PDA);
  }

  createConfig(
    lpFeeBasisPoints: BN,
    protocolFeeBasisPoints: BN,
    protocolFeeRecipients: PublicKey[],
    coinCreatorFeeBasisPoints: BN,
    admin: PublicKey,
    adminSetCoinCreatorAuthority: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .createConfig(
        lpFeeBasisPoints,
        protocolFeeBasisPoints,
        protocolFeeRecipients,
        coinCreatorFeeBasisPoints,
        adminSetCoinCreatorAuthority,
      )
      .accountsPartial({
        admin,
      })
      .instruction();
  }

  disable(
    disableCreatePool: boolean,
    disableDeposit: boolean,
    disableWithdraw: boolean,
    disableBuy: boolean,
    disableSell: boolean,
    admin: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .disable(
        disableCreatePool,
        disableDeposit,
        disableWithdraw,
        disableBuy,
        disableSell,
      )
      .accountsPartial({
        admin,
        globalConfig: GLOBAL_CONFIG_PDA,
      })
      .instruction();
  }

  updateAdmin(
    admin: PublicKey,
    newAdmin: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .updateAdmin()
      .accountsPartial({
        admin,
        newAdmin,
        globalConfig: GLOBAL_CONFIG_PDA,
      })
      .instruction();
  }

  updateFeeConfig(
    lpFeeBasisPoints: BN,
    protocolFeeBasisPoints: BN,
    protocolFeeRecipients: PublicKey[],
    coinCreatorFeeBasisPoints: BN,
    admin: PublicKey,
    adminSetCoinCreatorAuthority: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .updateFeeConfig(
        lpFeeBasisPoints,
        protocolFeeBasisPoints,
        protocolFeeRecipients,
        coinCreatorFeeBasisPoints,
        adminSetCoinCreatorAuthority,
      )
      .accountsPartial({
        admin,
        globalConfig: GLOBAL_CONFIG_PDA,
      })
      .instruction();
  }

  async adminSetCoinCreator(
    mint: PublicKey,
    newCoinCreator: PublicKey,
  ): Promise<TransactionInstruction> {
    const globalConfig = await this.fetchGlobalConfigAccount();
    return this.program.methods
      .adminSetCoinCreator(newCoinCreator)
      .accountsPartial({
        pool: canonicalPumpPoolPda(mint),
        adminSetCoinCreatorAuthority: globalConfig.adminSetCoinCreatorAuthority,
        globalConfig: GLOBAL_CONFIG_PDA,
      })
      .instruction();
  }

  async adminUpdateTokenIncentives(
    startTime: BN,
    endTime: BN,
    dayNumber: BN,
    tokenSupplyPerDay: BN,
    secondsInADay: BN = new BN(86400),
    mint: PublicKey = PUMP_MINT,
    tokenProgram: PublicKey = TOKEN_2022_PROGRAM_ID,
  ): Promise<TransactionInstruction> {
    const { admin } = await this.fetchGlobalConfigAccount();

    return this.program.methods
      .adminUpdateTokenIncentives(
        startTime,
        endTime,
        secondsInADay,
        dayNumber,
        tokenSupplyPerDay,
      )
      .accountsPartial({
        admin,
        mint,
        tokenProgram,
      })
      .instruction();
  }
}
