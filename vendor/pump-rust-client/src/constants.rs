//! Program IDs and seed constants for the `pump` and `pump_amm` programs.
//!
//! Standard SPL / Metaplex / wSOL pubkeys are re-bound from the upstream
//! crates via `anchor_spl` so we never duplicate the byte literals. The
//! pump-specific values that no upstream crate exports (the `pump_fees` and
//! `mayhem` program IDs, the reward-token mint, the lookup tables, and the
//! seed strings) are sourced directly from the IDLs in `idls/pump.json` and
//! `idls/pump_amm.json`.

use solana_program::{pubkey, pubkey::Pubkey};

pub const SPL_TOKEN_PROGRAM_ID: Pubkey = anchor_spl::token::ID;
pub const SPL_TOKEN_2022_PROGRAM_ID: Pubkey = anchor_spl::token_2022::ID;
pub const SPL_ATA_PROGRAM_ID: Pubkey = anchor_spl::associated_token::ID;
pub const MPL_TOKEN_METADATA_PROGRAM_ID: Pubkey = anchor_spl::metadata::ID;
/// Wrapped-SOL mint, used as the default quote mint.
pub const NATIVE_MINT: Pubkey = anchor_spl::token::spl_token::native_mint::ID;
/// Pump's reward-token mint.
pub const PUMP_TOKEN_MINT: Pubkey = pubkey!("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");

pub const FEE_PROGRAM_ID: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
pub const MAYHEM_PROGRAM_ID: Pubkey = pubkey!("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");

/// Address lookup table for pump trades.
pub const MAINNET_ALT: Pubkey = pubkey!("7mFD2mUtRS65XstiSAvCJuYmdesZoQwCwRJhq1p3eRMe");
pub const DEVNET_ALT: Pubkey = pubkey!("7y3623xaVQzsLxHRyp1wQD4Pmer5JjgbaagGFAEqCjua");

pub mod pump {
    use super::*;

    pub const PROGRAM_ID: Pubkey = crate::pump::ID;

    pub const GLOBAL_SEED: &[u8] = b"global";
    pub const BONDING_CURVE_SEED: &[u8] = b"bonding-curve";
    pub const BONDING_CURVE_V2_SEED: &[u8] = b"bonding-curve-v2";
    pub const CREATOR_VAULT_SEED: &[u8] = b"creator-vault";
    pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";
    pub const MINT_AUTHORITY_SEED: &[u8] = b"mint-authority";
    pub const POOL_AUTHORITY_SEED: &[u8] = b"pool-authority";
    pub const GLOBAL_VOLUME_ACCUMULATOR_SEED: &[u8] = b"global_volume_accumulator";
    pub const USER_VOLUME_ACCUMULATOR_SEED: &[u8] = b"user_volume_accumulator";
    pub const METADATA_SEED: &[u8] = b"metadata";
    pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";
    pub const SHARING_CONFIG_SEED: &[u8] = b"sharing-config";
    pub const FEE_CONFIG_PROGRAM_SEED_KEY: Pubkey = PROGRAM_ID;
}

pub mod pump_amm {
    use super::*;

    pub const PROGRAM_ID: Pubkey = crate::pump_amm::ID;

    pub const GLOBAL_CONFIG_SEED: &[u8] = b"global_config";
    pub const POOL_SEED: &[u8] = b"pool";
    pub const POOL_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
    // Underscore variant — distinct from the hyphen variant in the bonding-curve program.
    pub const CREATOR_VAULT_SEED: &[u8] = b"creator_vault";
    pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";
    pub const GLOBAL_VOLUME_ACCUMULATOR_SEED: &[u8] = b"global_volume_accumulator";
    pub const USER_VOLUME_ACCUMULATOR_SEED: &[u8] = b"user_volume_accumulator";
    pub const POOL_V2_SEED: &[u8] = b"pool-v2";
    pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";
    pub const FEE_CONFIG_PROGRAM_SEED_KEY: Pubkey = PROGRAM_ID;
}

pub mod pump_agent_payments {
    use super::*;

    pub const PROGRAM_ID: Pubkey = crate::pump_agent_payments::ID;

    pub const GLOBAL_CONFIG_SEED: &[u8] = b"global-config";
    pub const TOKEN_AGENT_PAYMENTS_SEED: &[u8] = b"token-agent-payments";
    pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";
}
