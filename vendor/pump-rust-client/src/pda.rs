//! PDA derivations for `pump` and `pump_amm`. Each returns `(Pubkey, bump)`.

use solana_program::pubkey::Pubkey;

use crate::constants;

/// SPL associated token account PDA.
pub fn associated_token(owner: &Pubkey, token_program: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &constants::SPL_ATA_PROGRAM_ID,
    )
}

pub mod pump {
    use super::*;
    use crate::constants::pump::*;

    pub fn global() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[GLOBAL_SEED], &PROGRAM_ID)
    }

    pub fn bonding_curve(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[BONDING_CURVE_SEED, mint.as_ref()], &PROGRAM_ID)
    }

    /// Remaining account on `buy` / `sell`.
    pub fn bonding_curve_v2(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[BONDING_CURVE_V2_SEED, mint.as_ref()], &PROGRAM_ID)
    }

    pub fn creator_vault(creator: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[CREATOR_VAULT_SEED, creator.as_ref()], &PROGRAM_ID)
    }

    pub fn event_authority() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[EVENT_AUTHORITY_SEED], &PROGRAM_ID)
    }

    pub fn mint_authority() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[MINT_AUTHORITY_SEED], &PROGRAM_ID)
    }

    pub fn pool_authority(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[POOL_AUTHORITY_SEED, mint.as_ref()], &PROGRAM_ID)
    }

    pub fn global_volume_accumulator() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[GLOBAL_VOLUME_ACCUMULATOR_SEED], &PROGRAM_ID)
    }

    pub fn user_volume_accumulator(user: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[USER_VOLUME_ACCUMULATOR_SEED, user.as_ref()], &PROGRAM_ID)
    }

    pub fn fee_config() -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[FEE_CONFIG_SEED, FEE_CONFIG_PROGRAM_SEED_KEY.as_ref()],
            &constants::FEE_PROGRAM_ID,
        )
    }

    pub fn metadata(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[
                METADATA_SEED,
                constants::MPL_TOKEN_METADATA_PROGRAM_ID.as_ref(),
                mint.as_ref(),
            ],
            &constants::MPL_TOKEN_METADATA_PROGRAM_ID,
        )
    }

    /// Per-mint fee-sharing config (`pump_fees`); may be uninitialized.
    pub fn sharing_config(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[SHARING_CONFIG_SEED, mint.as_ref()],
            &constants::FEE_PROGRAM_ID,
        )
    }
}

pub mod mayhem {
    //! Mayhem program PDAs referenced by `create_v2`.
    use super::*;

    pub const PROGRAM_ID: Pubkey = constants::MAYHEM_PROGRAM_ID;

    pub const GLOBAL_PARAMS_SEED: &[u8] = b"global-params";
    pub const SOL_VAULT_SEED: &[u8] = b"sol-vault";
    pub const MAYHEM_STATE_SEED: &[u8] = b"mayhem-state";

    pub fn global_params() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[GLOBAL_PARAMS_SEED], &PROGRAM_ID)
    }

    pub fn sol_vault() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[SOL_VAULT_SEED], &PROGRAM_ID)
    }

    pub fn mayhem_state(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[MAYHEM_STATE_SEED, mint.as_ref()], &PROGRAM_ID)
    }

    /// Token-2022 ATA for (`sol_vault`, mint).
    pub fn mayhem_token_vault(mint: &Pubkey) -> (Pubkey, u8) {
        let (sol_vault_pda, _) = sol_vault();
        super::associated_token(&sol_vault_pda, &constants::SPL_TOKEN_2022_PROGRAM_ID, mint)
    }
}

pub mod pump_amm {
    use super::*;
    use crate::constants::pump_amm::*;

    pub fn global_config() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[GLOBAL_CONFIG_SEED], &PROGRAM_ID)
    }

    pub fn pool(
        index: u16,
        creator: &Pubkey,
        base_mint: &Pubkey,
        quote_mint: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[
                POOL_SEED,
                &index.to_le_bytes(),
                creator.as_ref(),
                base_mint.as_ref(),
                quote_mint.as_ref(),
            ],
            &PROGRAM_ID,
        )
    }

    pub fn lp_mint(pool: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[POOL_LP_MINT_SEED, pool.as_ref()], &PROGRAM_ID)
    }

    pub fn coin_creator_vault_authority(coin_creator: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[CREATOR_VAULT_SEED, coin_creator.as_ref()], &PROGRAM_ID)
    }

    pub fn event_authority() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[EVENT_AUTHORITY_SEED], &PROGRAM_ID)
    }

    pub fn global_volume_accumulator() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[GLOBAL_VOLUME_ACCUMULATOR_SEED], &PROGRAM_ID)
    }

    pub fn user_volume_accumulator(user: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[USER_VOLUME_ACCUMULATOR_SEED, user.as_ref()], &PROGRAM_ID)
    }

    pub fn pool_v2(base_mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[POOL_V2_SEED, base_mint.as_ref()], &PROGRAM_ID)
    }

    pub fn fee_config() -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[FEE_CONFIG_SEED, FEE_CONFIG_PROGRAM_SEED_KEY.as_ref()],
            &constants::FEE_PROGRAM_ID,
        )
    }
}

pub mod pump_agent_payments {
    use super::*;
    use crate::constants::pump_agent_payments::*;

    pub fn global_config() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[GLOBAL_CONFIG_SEED], &PROGRAM_ID)
    }

    pub fn token_agent_payments(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[TOKEN_AGENT_PAYMENTS_SEED, mint.as_ref()], &PROGRAM_ID)
    }

    pub fn event_authority() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[EVENT_AUTHORITY_SEED], &PROGRAM_ID)
    }
}
