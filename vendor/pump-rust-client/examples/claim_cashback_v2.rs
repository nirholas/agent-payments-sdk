#[path = "../tests/common/mod.rs"]
mod common;

use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

use pump_rust_client::{constants, PumpSdk};

use common::{airdrop_blocking, load_alt, make_client, make_rpc, send_v0_tx, DEFAULT_USER_LAMPORTS};

#[tokio::main]
async fn main() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();
    let user = Keypair::new();
    let mint = Keypair::new();
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;
    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;
    let global = client.fetch_global().await.expect("fetch_global");

    let mut create_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    create_ixs.extend(
        sdk.create_v2_and_buy_instruction(
            mint.pubkey(),
            user.pubkey(),
            "Cashback Example",
            "CBEX",
            "https://example.com/cbex.json",
            user.pubkey(),
            Pubkey::default(),
            false,
            true,
            None,
            &global,
            1_000_000_000,
            LAMPORTS_PER_SOL,
        )
        .expect("create_v2_and_buy_instruction"),
    );
    send_v0_tx(&rpc, &create_ixs, &user, &[&user, &mint], &alt).await;

    let claim_ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(200_000),
        sdk.claim_cashback_v2_instruction(
            user.pubkey(),
            Pubkey::default(),
            constants::SPL_TOKEN_PROGRAM_ID,
        ),
    ];
    let sig = send_v0_tx(&rpc, &claim_ixs, &user, &[&user], &alt).await;
    println!("claim_cashback_v2 sig: {sig}");
}
