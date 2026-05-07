#[path = "../tests/common/mod.rs"]
mod common;

use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::signature::{Keypair, Signer};

use pump_rust_client::{constants, PumpSdk};

use common::fixtures::NOT_GRADUATED_DEVNET_MINT;
use common::{airdrop_blocking, load_alt, make_client, make_rpc, send_v0_tx, DEFAULT_USER_LAMPORTS};

#[tokio::main]
async fn main() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();
    let user = Keypair::new();
    let mint = NOT_GRADUATED_DEVNET_MINT;
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;
    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;
    let global = client.fetch_global().await.expect("fetch_global");
    let bonding_curve = client
        .fetch_bonding_curve(&mint)
        .await
        .expect("fetch_bonding_curve");

    let mut ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    ixs.extend(
        sdk.buy_v2_instructions(
            &global,
            &bonding_curve,
            mint,
            constants::SPL_TOKEN_PROGRAM_ID,
            user.pubkey(),
            300_000_000,
            LAMPORTS_PER_SOL,
        )
        .expect("buy_v2_instructions"),
    );
    let sig = send_v0_tx(&rpc, &ixs, &user, &[&user], &alt).await;
    println!("buy_v2 sig: {sig}");
}
