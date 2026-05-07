#[path = "../tests/common/mod.rs"]
mod common;

use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::signature::{Keypair, Signer};

use pump_rust_client::accounts::pump_amm::{decode_global_config, decode_pool};
use pump_rust_client::{constants, pda, PumpSdk};

use common::fixtures::GRADUATED_DEVNET_MINT;
use common::{
    airdrop_blocking, build_wsol_setup_tx, fee_recipients, load_alt, make_client, make_rpc,
    send_v0_tx, unwrap_sol_ix, DEFAULT_USER_LAMPORTS,
};

#[tokio::main]
async fn main() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();
    let (_fee_recipient, buyback_fee_recipient) = fee_recipients(&client).await;
    let user = Keypair::new();
    let mint = GRADUATED_DEVNET_MINT;
    let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
    let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
    let quote_mint = constants::NATIVE_MINT;
    let max_sol_cost = LAMPORTS_PER_SOL;
    let base_amount_out = 1_000_000u64;

    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;
    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;

    let pool_creator = pda::pump::pool_authority(&mint).0;
    let pool_address = pda::pump_amm::pool(0, &pool_creator, &mint, &quote_mint).0;
    let pool = decode_pool(
        &rpc.get_account(&pool_address)
            .await
            .expect("pool account")
            .data,
    )
    .expect("decode_pool");
    let global_config = decode_global_config(
        &rpc.get_account(&pda::pump_amm::global_config().0)
            .await
            .expect("global_config")
            .data,
    )
    .expect("decode_global_config");

    let setup_tx = build_wsol_setup_tx(
        &rpc,
        &user,
        pda::pump::bonding_curve(&mint).0,
        buyback_fee_recipient,
        max_sol_cost,
    )
    .await;
    rpc.send_and_confirm_transaction(&setup_tx)
        .await
        .expect("wSOL setup tx");

    let mut ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    ixs.extend(
        sdk.buy_amm_instructions(
            pool_address,
            &global_config,
            &pool,
            base_token_program,
            quote_token_program,
            user.pubkey(),
            base_amount_out,
            max_sol_cost,
        )
        .expect("buy_amm_instructions"),
    );
    ixs.push(unwrap_sol_ix(&user.pubkey()));
    let sig = send_v0_tx(&rpc, &ixs, &user, &[&user], &alt).await;
    println!("buy_amm sig: {sig}");
}
