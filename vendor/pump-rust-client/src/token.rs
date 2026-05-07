//! SPL Token / Token-2022 instruction helpers used by the SDK.
//!
//! [`wrap_sol_instructions`] and [`unwrap_sol_instruction`] cover the
//! wSOL roundtrip every wSOL-quoted buy needs.
//! [`create_associated_token_account_idempotent`] is re-exported from
//! `spl-associated-token-account` so all token-instruction imports live
//! in one place.

use anchor_spl::token::spl_token::instruction::{close_account, sync_native};
use solana_program::{instruction::Instruction, pubkey::Pubkey, system_instruction};

pub use anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent;

use crate::{constants, pda};

fn user_wsol_ata(user: &Pubkey) -> Pubkey {
    pda::associated_token(
        user,
        &constants::SPL_TOKEN_PROGRAM_ID,
        &constants::NATIVE_MINT,
    )
    .0
}

/// `system_transfer(user → user_wsol_ata, lamports)` followed by
/// `sync_native(user_wsol_ata)`. Used before any wSOL-quoted buy.
pub fn wrap_sol_instructions(user: &Pubkey, lamports: u64) -> [Instruction; 2] {
    let ata = user_wsol_ata(user);
    [
        system_instruction::transfer(user, &ata, lamports),
        sync_native(&constants::SPL_TOKEN_PROGRAM_ID, &ata)
            .expect("sync_native: token program id is constant"),
    ]
}

/// `close_account(user_wsol_ata)` with destination and owner both `user`.
/// Unwraps the wSOL balance back to lamports on the user's main account.
pub fn unwrap_sol_instruction(user: &Pubkey) -> Instruction {
    let ata = user_wsol_ata(user);
    close_account(&constants::SPL_TOKEN_PROGRAM_ID, &ata, user, user, &[])
        .expect("close_account: token program id is constant")
}
