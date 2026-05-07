use anchor_lang::{InstructionData, ToAccountMetas};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};

use crate::pump_amm::{
    client as amm_client, types::OptionBool as AmmOptionBool, ID as PUMP_AMM_PROGRAM_ID,
};
use crate::state::pump_amm::{GlobalConfig, Pool};
use crate::token::create_associated_token_account_idempotent;
use crate::{constants, pda};

use super::PumpSdk;

/// Pubkeys derived once and threaded into both `Buy` and `Sell` AMM
/// instructions (which share the same account set apart from buy's extra
/// volume-accumulator slots).
struct AmmTradeAccounts {
    coin_creator_vault_authority: Pubkey,
    user_volume_accumulator: Pubkey,
    user_base_token_account: Pubkey,
    user_quote_token_account: Pubkey,
    pool_base_token_account: Pubkey,
    pool_quote_token_account: Pubkey,
    protocol_fee_recipient_token_account: Pubkey,
    coin_creator_vault_ata: Pubkey,
}

impl AmmTradeAccounts {
    fn derive(
        pool: Pubkey,
        base_mint: Pubkey,
        quote_mint: Pubkey,
        base_token_program: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        coin_creator: Pubkey,
        protocol_fee_recipient: Pubkey,
    ) -> Self {
        let coin_creator_vault_authority =
            pda::pump_amm::coin_creator_vault_authority(&coin_creator).0;
        let user_volume_accumulator = pda::pump_amm::user_volume_accumulator(&user).0;
        let ata = |owner: &Pubkey, token_program: &Pubkey, mint: &Pubkey| {
            pda::associated_token(owner, token_program, mint).0
        };
        Self {
            coin_creator_vault_authority,
            user_volume_accumulator,
            user_base_token_account: ata(&user, &base_token_program, &base_mint),
            user_quote_token_account: ata(&user, &quote_token_program, &quote_mint),
            pool_base_token_account: ata(&pool, &base_token_program, &base_mint),
            pool_quote_token_account: ata(&pool, &quote_token_program, &quote_mint),
            protocol_fee_recipient_token_account: ata(
                &protocol_fee_recipient,
                &quote_token_program,
                &quote_mint,
            ),
            coin_creator_vault_ata: ata(
                &coin_creator_vault_authority,
                &quote_token_program,
                &quote_mint,
            ),
        }
    }
}

impl PumpSdk {
    /// `pump_amm` buy. Fees from [`GlobalConfig`], pool layout from [`Pool`]. Use default `coin_creator` to omit `pool_v2`.
    pub fn buy_amm_instruction(
        &self,
        pool: Pubkey,
        amm_global: &GlobalConfig,
        pool_state: &Pool,
        base_token_program: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        base_amount_out: u64,
        max_quote_amount_in: u64,
    ) -> Option<Instruction> {
        let (protocol_fee_recipient, buyback_fee_recipient) =
            Self::amm_fee_recipients_pair(amm_global)?;
        Some(self.buy_amm_instruction_with_recipients(
            pool,
            pool_state.base_mint,
            pool_state.quote_mint,
            base_token_program,
            quote_token_program,
            user,
            pool_state.coin_creator,
            protocol_fee_recipient,
            buyback_fee_recipient,
            pool_state.is_cashback_coin,
            base_amount_out,
            max_quote_amount_in,
        ))
    }

    pub(crate) fn buy_amm_instruction_with_recipients(
        &self,
        pool: Pubkey,
        base_mint: Pubkey,
        quote_mint: Pubkey,
        base_token_program: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        coin_creator: Pubkey,
        protocol_fee_recipient: Pubkey,
        buyback_fee_recipient: Pubkey,
        is_cashback_coin: bool,
        base_amount_out: u64,
        max_quote_amount_in: u64,
    ) -> Instruction {
        let a = AmmTradeAccounts::derive(
            pool,
            base_mint,
            quote_mint,
            base_token_program,
            quote_token_program,
            user,
            coin_creator,
            protocol_fee_recipient,
        );
        let accounts = amm_client::accounts::Buy {
            pool,
            user,
            global_config: pda::pump_amm::global_config().0,
            base_mint,
            quote_mint,
            user_base_token_account: a.user_base_token_account,
            user_quote_token_account: a.user_quote_token_account,
            pool_base_token_account: a.pool_base_token_account,
            pool_quote_token_account: a.pool_quote_token_account,
            protocol_fee_recipient,
            protocol_fee_recipient_token_account: a.protocol_fee_recipient_token_account,
            base_token_program,
            quote_token_program,
            system_program: system_program::ID,
            associated_token_program: constants::SPL_ATA_PROGRAM_ID,
            event_authority: pda::pump_amm::event_authority().0,
            program: PUMP_AMM_PROGRAM_ID,
            coin_creator_vault_ata: a.coin_creator_vault_ata,
            coin_creator_vault_authority: a.coin_creator_vault_authority,
            global_volume_accumulator: pda::pump_amm::global_volume_accumulator().0,
            user_volume_accumulator: a.user_volume_accumulator,
            fee_config: pda::pump_amm::fee_config().0,
            fee_program: constants::FEE_PROGRAM_ID,
        };
        let args = amm_client::args::Buy {
            base_amount_out,
            max_quote_amount_in,
            track_volume: AmmOptionBool(true),
        };
        let mut metas = accounts.to_account_metas(None);
        if is_cashback_coin {
            metas.push(AccountMeta::new(
                pda::associated_token(
                    &a.user_volume_accumulator,
                    &quote_token_program,
                    &constants::NATIVE_MINT,
                )
                .0,
                false,
            ));
        }
        if coin_creator != Pubkey::default() {
            metas.push(AccountMeta::new_readonly(
                pda::pump_amm::pool_v2(&base_mint).0,
                false,
            ));
        }
        metas.push(AccountMeta::new(buyback_fee_recipient, false));
        metas.push(AccountMeta::new(
            pda::associated_token(&buyback_fee_recipient, &quote_token_program, &quote_mint).0,
            false,
        ));
        Instruction {
            program_id: PUMP_AMM_PROGRAM_ID,
            accounts: metas,
            data: args.data(),
        }
    }

    /// [`Self::buy_amm_instruction`] plus idempotent user base ATA create.
    pub fn buy_amm_instructions(
        &self,
        pool: Pubkey,
        amm_global: &GlobalConfig,
        pool_state: &Pool,
        base_token_program: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        base_amount_out: u64,
        max_quote_amount_in: u64,
    ) -> Option<Vec<Instruction>> {
        let buy = self.buy_amm_instruction(
            pool,
            amm_global,
            pool_state,
            base_token_program,
            quote_token_program,
            user,
            base_amount_out,
            max_quote_amount_in,
        )?;
        Some(vec![
            create_associated_token_account_idempotent(
                &user,
                &user,
                &pool_state.base_mint,
                &base_token_program,
            ),
            buy,
        ])
    }

    /// `pump_amm` sell (remaining accounts differ from buy for cashback / buyback).
    pub fn sell_amm_instruction(
        &self,
        pool: Pubkey,
        amm_global: &GlobalConfig,
        pool_state: &Pool,
        base_token_program: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        base_amount_in: u64,
        min_quote_amount_out: u64,
    ) -> Option<Instruction> {
        let (protocol_fee_recipient, buyback_fee_recipient) =
            Self::amm_fee_recipients_pair(amm_global)?;
        Some(self.sell_amm_instruction_with_recipients(
            pool,
            pool_state.base_mint,
            pool_state.quote_mint,
            base_token_program,
            quote_token_program,
            user,
            pool_state.coin_creator,
            protocol_fee_recipient,
            buyback_fee_recipient,
            pool_state.is_cashback_coin,
            base_amount_in,
            min_quote_amount_out,
        ))
    }

    pub(crate) fn sell_amm_instruction_with_recipients(
        &self,
        pool: Pubkey,
        base_mint: Pubkey,
        quote_mint: Pubkey,
        base_token_program: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        coin_creator: Pubkey,
        protocol_fee_recipient: Pubkey,
        buyback_fee_recipient: Pubkey,
        is_cashback_coin: bool,
        base_amount_in: u64,
        min_quote_amount_out: u64,
    ) -> Instruction {
        let a = AmmTradeAccounts::derive(
            pool,
            base_mint,
            quote_mint,
            base_token_program,
            quote_token_program,
            user,
            coin_creator,
            protocol_fee_recipient,
        );
        let accounts = amm_client::accounts::Sell {
            pool,
            user,
            global_config: pda::pump_amm::global_config().0,
            base_mint,
            quote_mint,
            user_base_token_account: a.user_base_token_account,
            user_quote_token_account: a.user_quote_token_account,
            pool_base_token_account: a.pool_base_token_account,
            pool_quote_token_account: a.pool_quote_token_account,
            protocol_fee_recipient,
            protocol_fee_recipient_token_account: a.protocol_fee_recipient_token_account,
            base_token_program,
            quote_token_program,
            system_program: system_program::ID,
            associated_token_program: constants::SPL_ATA_PROGRAM_ID,
            event_authority: pda::pump_amm::event_authority().0,
            program: PUMP_AMM_PROGRAM_ID,
            coin_creator_vault_ata: a.coin_creator_vault_ata,
            coin_creator_vault_authority: a.coin_creator_vault_authority,
            fee_config: pda::pump_amm::fee_config().0,
            fee_program: constants::FEE_PROGRAM_ID,
        };
        let args = amm_client::args::Sell {
            base_amount_in,
            min_quote_amount_out,
        };
        let mut metas = accounts.to_account_metas(None);
        if is_cashback_coin {
            metas.push(AccountMeta::new(
                pda::associated_token(
                    &a.user_volume_accumulator,
                    &quote_token_program,
                    &quote_mint,
                )
                .0,
                false,
            ));
            metas.push(AccountMeta::new(a.user_volume_accumulator, false));
        }
        if coin_creator != Pubkey::default() {
            metas.push(AccountMeta::new_readonly(
                pda::pump_amm::pool_v2(&base_mint).0,
                false,
            ));
        }
        metas.push(AccountMeta::new_readonly(buyback_fee_recipient, false));
        metas.push(AccountMeta::new(
            pda::associated_token(&buyback_fee_recipient, &quote_token_program, &quote_mint).0,
            false,
        ));
        Instruction {
            program_id: PUMP_AMM_PROGRAM_ID,
            accounts: metas,
            data: args.data(),
        }
    }

    /// [`Self::sell_amm_instruction`] plus idempotent user quote ATA create.
    pub fn sell_amm_instructions(
        &self,
        pool: Pubkey,
        amm_global: &GlobalConfig,
        pool_state: &Pool,
        base_token_program: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        base_amount_in: u64,
        min_quote_amount_out: u64,
    ) -> Option<Vec<Instruction>> {
        let sell = self.sell_amm_instruction(
            pool,
            amm_global,
            pool_state,
            base_token_program,
            quote_token_program,
            user,
            base_amount_in,
            min_quote_amount_out,
        )?;
        Some(vec![
            create_associated_token_account_idempotent(
                &user,
                &user,
                &pool_state.quote_mint,
                &quote_token_program,
            ),
            sell,
        ])
    }
}
