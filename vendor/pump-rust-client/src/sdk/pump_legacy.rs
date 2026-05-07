use anchor_lang::{InstructionData, ToAccountMetas};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program, sysvar,
};

use crate::{constants, pda, pump::client, pump::types::OptionBool};

use super::PumpSdk;

#[allow(deprecated)]
impl PumpSdk {
    /// Legacy create (SPL Token + Metaplex); prefer [`Self::create_v2_instruction`].
    #[deprecated(note = "Use create_v2_instruction instead")]
    pub fn create_instruction(
        &self,
        mint: Pubkey,
        user: Pubkey,
        name: impl Into<String>,
        symbol: impl Into<String>,
        uri: impl Into<String>,
        creator: Pubkey,
    ) -> Instruction {
        let token_program = constants::SPL_TOKEN_PROGRAM_ID;
        let bonding_curve = pda::pump::bonding_curve(&mint).0;
        let accounts = client::accounts::Create {
            mint,
            mint_authority: pda::pump::mint_authority().0,
            bonding_curve,
            associated_bonding_curve: pda::associated_token(&bonding_curve, &token_program, &mint)
                .0,
            global: pda::pump::global().0,
            mpl_token_metadata: constants::MPL_TOKEN_METADATA_PROGRAM_ID,
            metadata: pda::pump::metadata(&mint).0,
            user,
            system_program: system_program::ID,
            token_program,
            associated_token_program: constants::SPL_ATA_PROGRAM_ID,
            rent: sysvar::rent::ID,
            event_authority: pda::pump::event_authority().0,
            program: crate::pump::ID,
        };
        let args = client::args::Create {
            name: name.into(),
            symbol: symbol.into(),
            uri: uri.into(),
            creator,
        };
        Instruction {
            program_id: crate::pump::ID,
            accounts: accounts.to_account_metas(None),
            data: args.data(),
        }
    }

    /// Legacy bonding-curve buy; prefer [`Self::buy_v2_instruction`]. Appends `bonding_curve_v2`, `buyback_fee_recipient`.
    #[deprecated(note = "Use buy_v2_instruction instead")]
    pub fn buy_instruction(
        &self,
        mint: Pubkey,
        user: Pubkey,
        creator: Pubkey,
        fee_recipient: Pubkey,
        buyback_fee_recipient: Pubkey,
        amount: u64,
        max_sol_cost: u64,
        token_program: Pubkey,
    ) -> Instruction {
        let bonding_curve = pda::pump::bonding_curve(&mint).0;
        let accounts = client::accounts::Buy {
            global: pda::pump::global().0,
            fee_recipient,
            mint,
            bonding_curve,
            associated_bonding_curve: pda::associated_token(&bonding_curve, &token_program, &mint)
                .0,
            associated_user: pda::associated_token(&user, &token_program, &mint).0,
            user,
            system_program: system_program::ID,
            token_program,
            creator_vault: pda::pump::creator_vault(&creator).0,
            event_authority: pda::pump::event_authority().0,
            program: crate::pump::ID,
            global_volume_accumulator: pda::pump::global_volume_accumulator().0,
            user_volume_accumulator: pda::pump::user_volume_accumulator(&user).0,
            fee_config: pda::pump::fee_config().0,
            fee_program: constants::FEE_PROGRAM_ID,
        };
        let args = client::args::Buy {
            amount,
            max_sol_cost,
            track_volume: OptionBool(true),
        };
        let mut metas = accounts.to_account_metas(None);
        metas.push(AccountMeta::new_readonly(
            pda::pump::bonding_curve_v2(&mint).0,
            false,
        ));
        metas.push(AccountMeta::new(buyback_fee_recipient, false));
        Instruction {
            program_id: crate::pump::ID,
            accounts: metas,
            data: args.data(),
        }
    }

    /// Legacy sell; prefer [`Self::sell_v2_instruction`]. Appends UVA, `bonding_curve_v2`.
    #[deprecated(note = "Use sell_v2_instruction instead")]
    pub fn sell_instruction(
        &self,
        mint: Pubkey,
        user: Pubkey,
        creator: Pubkey,
        fee_recipient: Pubkey,
        buyback_fee_recipient: Pubkey,
        amount: u64,
        min_sol_output: u64,
        token_program: Pubkey,
        is_cashback_coin: bool,
    ) -> Instruction {
        let bonding_curve = pda::pump::bonding_curve(&mint).0;
        let accounts = client::accounts::Sell {
            global: pda::pump::global().0,
            fee_recipient,
            mint,
            bonding_curve,
            associated_bonding_curve: pda::associated_token(&bonding_curve, &token_program, &mint)
                .0,
            associated_user: pda::associated_token(&user, &token_program, &mint).0,
            user,
            system_program: system_program::ID,
            creator_vault: pda::pump::creator_vault(&creator).0,
            token_program,
            event_authority: pda::pump::event_authority().0,
            program: crate::pump::ID,
            fee_config: pda::pump::fee_config().0,
            fee_program: constants::FEE_PROGRAM_ID,
        };
        let args = client::args::Sell {
            amount,
            min_sol_output,
        };
        let mut metas = accounts.to_account_metas(None);
        if is_cashback_coin {
            metas.push(AccountMeta::new(
                pda::pump::user_volume_accumulator(&user).0,
                false,
            ));
        }
        metas.push(AccountMeta::new_readonly(
            pda::pump::bonding_curve_v2(&mint).0,
            false,
        ));
        metas.push(AccountMeta::new(buyback_fee_recipient, false));
        Instruction {
            program_id: crate::pump::ID,
            accounts: metas,
            data: args.data(),
        }
    }
}
