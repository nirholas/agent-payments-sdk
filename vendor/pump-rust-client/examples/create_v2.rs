#[path = "../tests/common/mod.rs"]
mod common;

use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

use pump_rust_client::{constants, PumpSdk};

use common::{airdrop_blocking, load_alt, make_rpc, send_v0_tx, DEFAULT_USER_LAMPORTS};

#[tokio::main]
async fn main() {
    let rpc = make_rpc();
    let sdk = PumpSdk::new();
    let user = Keypair::new();
    let mint = Keypair::new();
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;
    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;

    let ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(400_000),
        sdk.create_v2_instruction(
            mint.pubkey(),
            user.pubkey(),
            "Example",
            "EX",
            "https://example.com/ex.json",
            user.pubkey(),
            Pubkey::default(),
            false,
            false,
        ),
    ];
    let sig = send_v0_tx(&rpc, &ixs, &user, &[&user, &mint], &alt).await;
    println!("create_v2 sig: {sig}");
}
