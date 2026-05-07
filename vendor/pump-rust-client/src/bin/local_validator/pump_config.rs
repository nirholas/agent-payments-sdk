#![allow(dead_code)]

use std::collections::HashSet;

use solana_sdk::pubkey::Pubkey;

use pump_rust_client::constants::{
    pump::PROGRAM_ID as PUMP_PROGRAM_ID,
    pump_agent_payments::PROGRAM_ID as PUMP_AGENT_PAYMENTS_PROGRAM_ID,
    pump_amm::PROGRAM_ID as PUMP_AMM_PROGRAM_ID, DEVNET_ALT, FEE_PROGRAM_ID, MAINNET_ALT,
    MAYHEM_PROGRAM_ID, MPL_TOKEN_METADATA_PROGRAM_ID,
};

use crate::utils::ProgramsToAdd;

/// Programs loaded into the local validator. `name` is the filename of the
/// `.so` artifact in `artifacts/` *without* the `.so` extension —
/// `solana_test_validator::TestValidatorGenesis::add_program` appends it.
pub fn pump_programs_to_add() -> Vec<ProgramsToAdd> {
    vec![
        ProgramsToAdd {
            name: "pump".into(),
            program_id: PUMP_PROGRAM_ID,
        },
        ProgramsToAdd {
            name: "pump_amm".into(),
            program_id: PUMP_AMM_PROGRAM_ID,
        },
        ProgramsToAdd {
            name: "pump_fees".into(),
            program_id: FEE_PROGRAM_ID,
        },
        ProgramsToAdd {
            name: "mayhem_program".into(),
            program_id: MAYHEM_PROGRAM_ID,
        },
        ProgramsToAdd {
            name: "mpl_token_metadata".into(),
            program_id: MPL_TOKEN_METADATA_PROGRAM_ID,
        },
        ProgramsToAdd {
            name: "pump_agent_payments".into(),
            program_id: PUMP_AGENT_PAYMENTS_PROGRAM_ID,
        },
    ]
}

/// Wallets that should always be funded with SOL on the local validator.
/// Fill in dev/test wallets as needed.
pub fn known_wallets() -> Vec<Pubkey> {
    vec![]
}

/// Address-lookup-table accounts whose metadata must be rewritten to
/// "active from slot 0" before they're added to the local validator.
/// Anything in this set that shows up in the loaded accounts dump gets
/// passed through `LookupTableMeta::default()` re-serialization.
pub fn known_lookup_tables() -> HashSet<Pubkey> {
    HashSet::from([DEVNET_ALT, MAINNET_ALT])
}

/// Post-start bootstrap hook. Runs after the validator is up and reachable
/// at `http://127.0.0.1:8899`. Wire up pump-side initialization here
/// (set fee config, init global state, airdrop, …) using `PumpSdk`.
pub async fn setup_pump_config() -> pump_rust_client::Result<()> {
    Ok(())
}
