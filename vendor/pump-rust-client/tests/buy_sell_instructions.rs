//! End-to-end coverage for every flavour of buy/sell instruction the
//! SDK exposes, against the local validator booted from the
//! `clone_devnet_accounts` snapshot.
//!
//! Three independent flows live in this file:
//!   • `legacy_buy_sell` — deprecated v1 [`PumpSdk::create_instruction`]
//!     + [`PumpSdk::buy_instruction`] / [`PumpSdk::sell_instruction`]
//!     against a freshly minted v1 SPL Token coin.
//!   • `v2_buy_sell` — [`PumpSdk::buy_v2_instructions`] /
//!     [`PumpSdk::sell_v2_instructions`] against the cloned non-graduated
//!     devnet mint [`pump_rust_client::fixtures::NOT_GRADUATED_DEVNET_MINT`].
//!   • `amm_buy_sell` — [`PumpSdk::buy_amm_instructions`] /
//!     [`PumpSdk::sell_amm_instructions`] against the cloned graduated
//!     devnet mint [`pump_rust_client::fixtures::GRADUATED_DEVNET_MINT`]
//!     and its post-migration `pump_amm` pool.
//!
//! Pre-requisite (run in a separate shell, in this order):
//!   1. `cargo run --features local-validator --bin clone_devnet_accounts`
//!   2. `cargo run --features local-validator --bin local-validator`
//!
//! Then in this shell:
//!   `cargo test --features local-validator --test buy_sell_instructions \
//!        -- --ignored --nocapture`

#![cfg(feature = "local-validator")]
#![allow(deprecated)] // we deliberately call the deprecated v1 buy/sell here

mod common;

use anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::signature::{Keypair, Signer};

use pump_rust_client::accounts::pump_amm::{decode_global_config, decode_pool};
use pump_rust_client::{constants, pda, PumpSdk};

use common::fixtures::{GRADUATED_DEVNET_MINT, NOT_GRADUATED_DEVNET_MINT};
use common::{
    airdrop_blocking, build_wsol_setup_tx, fee_recipients, load_alt, make_client, make_rpc,
    send_v0_tx, token_balance, unwrap_sol_ix, user_wsol_ata, DEFAULT_USER_LAMPORTS,
};

// ---------------------------------------------------------------------
// Legacy (deprecated) v1 buy/sell.
//
// The deprecated [`PumpSdk::buy_instruction`] / [`sell_instruction`]
// pair targets v1 (classic SPL Token + Metaplex metadata) coins. The
// cloned snapshot doesn't ship a v1 fixture mint, so we mint one on
// the fly with [`PumpSdk::create_instruction`] before exercising the
// trade flow. v1 trades pay/receive SOL directly — no wSOL wrap.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn legacy_v1_buy_sell_full_flow() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();

    let (fee_recipient, buyback_fee_recipient) = fee_recipients(&client).await;
    let token_program = constants::SPL_TOKEN_PROGRAM_ID;

    let user = Keypair::new();
    let mint = Keypair::new();
    println!("[legacy] user = {} mint = {}", user.pubkey(), mint.pubkey());
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;

    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;

    // ---- Tx 1: v1 create + user ATA. The user-side associated token
    //            account is NOT lazy-init'd by v1 buy, so we have to
    //            build it ourselves before the first trade. ----
    let user_base_ata = pda::associated_token(&user.pubkey(), &token_program, &mint.pubkey()).0;
    let create_ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(400_000),
        sdk.create_instruction(
            mint.pubkey(),
            user.pubkey(),
            "Legacy",
            "LGCY",
            "https://example.com/legacy.json",
            user.pubkey(),
        ),
        create_associated_token_account_idempotent(
            &user.pubkey(),
            &user.pubkey(),
            &mint.pubkey(),
            &token_program,
        ),
    ];
    let create_sig = send_v0_tx(&rpc, &create_ixs, &user, &[&user, &mint], &alt).await;
    println!("[legacy] create sig: {create_sig}");

    // ---- Tx 2: v1 buy. ~0.5 SOL ceiling for ~1B base units. ----
    let buy_amount = 1_000_000_000u64;
    let max_sol_cost = LAMPORTS_PER_SOL / 2;
    let buy_ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(400_000),
        sdk.buy_instruction(
            mint.pubkey(),
            user.pubkey(),
            user.pubkey(), // creator == user for a freshly minted v1 coin
            fee_recipient,
            buyback_fee_recipient,
            buy_amount,
            max_sol_cost,
            token_program,
        ),
    ];
    let buy_sig = send_v0_tx(&rpc, &buy_ixs, &user, &[&user], &alt).await;
    println!("[legacy] buy sig: {buy_sig}");

    let bc_after_buy = client
        .fetch_bonding_curve(&mint.pubkey())
        .await
        .expect("decode bonding_curve after v1 buy");
    assert!(
        bc_after_buy.real_quote_reserves > 0,
        "v1 buy should have credited real_quote_reserves"
    );
    let user_balance_after_buy = token_balance(&rpc, &user_base_ata).await;
    assert!(
        user_balance_after_buy > 0,
        "v1 buy must have credited the user's base ATA"
    );

    // ---- Tx 3: v1 sell — return half of what we bought. ----
    let sell_amount = user_balance_after_buy / 2;
    let sell_ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(400_000),
        sdk.sell_instruction(
            mint.pubkey(),
            user.pubkey(),
            user.pubkey(),
            fee_recipient,
            buyback_fee_recipient,
            sell_amount,
            1, // floor: at least 1 lamport (no slippage assertion in this test)
            token_program,
            false,
        ),
    ];
    let sell_sig = send_v0_tx(&rpc, &sell_ixs, &user, &[&user], &alt).await;
    println!("[legacy] sell sig: {sell_sig}");

    let bc_after_sell = client
        .fetch_bonding_curve(&mint.pubkey())
        .await
        .expect("decode bonding_curve after v1 sell");
    assert!(
        bc_after_sell.real_quote_reserves < bc_after_buy.real_quote_reserves,
        "v1 sell should have drained some real_quote_reserves (buy={} sell={})",
        bc_after_buy.real_quote_reserves,
        bc_after_sell.real_quote_reserves,
    );
    let user_balance_after_sell = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(
        user_balance_after_sell,
        user_balance_after_buy - sell_amount,
        "v1 sell should have debited the sold amount exactly"
    );
}

// ---------------------------------------------------------------------
// v2 buy/sell against the cloned non-graduated devnet mint.
//
// Token-2022 base, wSOL quote, sharing-config routed. Two transactions
// per direction: a legacy wSOL setup tx (4 ATAs + wrap_sol) followed by
// a v0 trade tx that the SDK's `*_v2_instructions` wrapper builds.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn v2_buy_sell_full_flow() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();

    let _fee_recipient = fee_recipients(&client).await;
    let mint = NOT_GRADUATED_DEVNET_MINT;
    let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
    let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;

    // Sanity-check the snapshot before we burn airdropped SOL on it.
    let global = client.fetch_global().await.expect("fetch_global");
    let bc_pre = client
        .fetch_bonding_curve(&mint)
        .await
        .expect("fetch_bonding_curve for non-graduated fixture mint");
    assert!(
        !bc_pre.complete,
        "fixture {NOT_GRADUATED_DEVNET_MINT} should not be graduated yet"
    );
    let user = Keypair::new();
    println!("[v2] user = {} mint = {mint}", user.pubkey());
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;

    let user_base_ata = pda::associated_token(&user.pubkey(), &base_token_program, &mint).0;
    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;

    // Buy ~1 SOL worth, with a generous slippage ceiling for the test.
    let buy_amount = 300_000_000u64; // 1M base units; tiny against any live curve
    let max_sol_cost = LAMPORTS_PER_SOL;

    let mut buy_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    buy_ixs.extend(
        sdk.buy_v2_instructions(
            &global,
            &bc_pre,
            mint,
            quote_token_program,
            user.pubkey(),
            buy_amount,
            max_sol_cost,
        )
        .expect("buy_v2_instructions"),
    );
    let buy_sig = send_v0_tx(&rpc, &buy_ixs, &user, &[&user], &alt).await;
    println!("[v2] buy sig: {buy_sig}");

    let bc_after_buy = client
        .fetch_bonding_curve(&mint)
        .await
        .expect("fetch bonding_curve after v2 buy");
    assert!(
        bc_after_buy.real_quote_reserves > bc_pre.real_quote_reserves,
        "buy_v2 must have raised real_quote_reserves (pre={} post={})",
        bc_pre.real_quote_reserves,
        bc_after_buy.real_quote_reserves,
    );
    let user_balance_after_buy = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(
        user_balance_after_buy, buy_amount,
        "buy_v2 should credit exactly the requested amount"
    );

    // ---- Tx 3: re-wrap a token amount of SOL (rent), then sell half
    //            of what we hold. Sell never wraps but the user's wSOL
    //            ATA needs to exist as a sink for proceeds; the
    //            `sell_v2_instructions` prefix does that idempotently. ----
    let sell_amount = user_balance_after_buy;
    let mut sell_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    sell_ixs.extend(
        sdk.sell_v2_instructions(
            &global,
            &bc_after_buy,
            mint,
            quote_token_program,
            user.pubkey(),
            sell_amount,
            1,
        )
        .expect("sell_v2_instructions"),
    );
    let sell_sig = send_v0_tx(&rpc, &sell_ixs, &user, &[&user], &alt).await;
    println!("[v2] sell sig: {sell_sig}");

    let bc_after_sell = client
        .fetch_bonding_curve(&mint)
        .await
        .expect("fetch bonding_curve after v2 sell");
    assert!(
        bc_after_sell.real_quote_reserves < bc_after_buy.real_quote_reserves,
        "sell_v2 must have lowered real_quote_reserves"
    );
    let user_balance_after_sell = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(
        user_balance_after_sell,
        user_balance_after_buy - sell_amount,
        "sell_v2 should debit exactly the requested amount"
    );
}

// ---------------------------------------------------------------------
// `buy_exact_quote_in_v2` against the cloned non-graduated devnet mint.
//
// Same fixture and account layout as `v2_buy_sell_full_flow`; the
// difference is that we drive the buy with an exact quote amount and a
// floor on tokens out, instead of an exact base amount with a quote
// ceiling.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn v2_buy_exact_quote_in_full_flow() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();

    let _ = fee_recipients(&client).await;
    let mint = NOT_GRADUATED_DEVNET_MINT;
    let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
    let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;

    let global = client.fetch_global().await.expect("fetch_global");
    let bc_pre = client
        .fetch_bonding_curve(&mint)
        .await
        .expect("fetch_bonding_curve for non-graduated fixture mint");
    assert!(
        !bc_pre.complete,
        "fixture {NOT_GRADUATED_DEVNET_MINT} should not be graduated yet"
    );

    let user = Keypair::new();
    println!("[v2-exact-quote] user = {} mint = {mint}", user.pubkey());
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;

    let user_base_ata = pda::associated_token(&user.pubkey(), &base_token_program, &mint).0;
    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;

    // Spend exactly 0.5 SOL of quote, with no meaningful floor on tokens out.
    let spendable_quote_in = LAMPORTS_PER_SOL / 2;
    let min_tokens_out = 1u64;

    let mut buy_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    buy_ixs.extend(
        sdk.buy_exact_quote_in_v2_instructions(
            &global,
            &bc_pre,
            mint,
            quote_token_program,
            user.pubkey(),
            spendable_quote_in,
            min_tokens_out,
        )
        .expect("buy_exact_quote_in_v2_instructions"),
    );
    let buy_sig = send_v0_tx(&rpc, &buy_ixs, &user, &[&user], &alt).await;
    println!("[v2-exact-quote] buy sig: {buy_sig}");

    let bc_after_buy = client
        .fetch_bonding_curve(&mint)
        .await
        .expect("fetch bonding_curve after buy_exact_quote_in_v2");
    assert!(
        bc_after_buy.real_quote_reserves > bc_pre.real_quote_reserves,
        "buy_exact_quote_in_v2 must have raised real_quote_reserves (pre={} post={})",
        bc_pre.real_quote_reserves,
        bc_after_buy.real_quote_reserves,
    );
    let user_balance_after_buy = token_balance(&rpc, &user_base_ata).await;
    assert!(
        user_balance_after_buy >= min_tokens_out,
        "buy_exact_quote_in_v2 should credit at least min_tokens_out (got {user_balance_after_buy})"
    );
}

// ---------------------------------------------------------------------
// AMM buy/sell against the cloned graduated devnet mint.
//
// The cloned snapshot ships the post-migration `pump_amm` pool plus
// every token account the buy/sell ixs reference. The test pulls
// `coin_creator` and `is_cashback_coin` straight off the cloned `Pool`
// because both control the AMM ix's remaining-account layout.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn amm_buy_sell_full_flow() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();

    let (_fee_recipient, buyback_fee_recipient) = fee_recipients(&client).await;
    let mint = GRADUATED_DEVNET_MINT;
    let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
    let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
    let quote_mint = constants::NATIVE_MINT;

    // Decode the cloned pool to learn coin_creator + cashback flag.
    let pool_creator = pda::pump::pool_authority(&mint).0;
    let pool_address = pda::pump_amm::pool(0, &pool_creator, &mint, &quote_mint).0;
    let pool_account = rpc.get_account(&pool_address).await.expect(
        "pool account missing on local validator — re-run clone_devnet_accounts after a graduated mint",
    );
    let pool = decode_pool(&pool_account.data).expect("decode_pool on cloned snapshot");
    let global_config = decode_global_config(
        &rpc.get_account(&pda::pump_amm::global_config().0)
            .await
            .expect("pump_amm global_config")
            .data,
    )
    .expect("decode_global_config");
    println!(
        "[amm] pool = {pool_address} coin_creator={} cashback={} base_acct={} quote_acct={}",
        pool.coin_creator,
        pool.is_cashback_coin,
        pool.pool_base_token_account,
        pool.pool_quote_token_account,
    );

    let user = Keypair::new();
    println!("[amm] user = {} mint = {mint}", user.pubkey());
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;

    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;
    let user_base_ata = pda::associated_token(&user.pubkey(), &base_token_program, &mint).0;
    let max_sol_cost = LAMPORTS_PER_SOL;
    let base_amount_out = 1_000_000u64; // tiny: exact value depends on cloned pool reserves

    // ---- Tx 1: AMM buy needs the user's base ATA, the user's wSOL ATA
    //            (sink for rent + source for quote-in), and the buyback
    //            recipient's wSOL ATA. Reuse `build_wsol_setup_tx` to
    //            create the wSOL ATAs and wrap the SOL; the user's
    //            base ATA gets created by `buy_amm_instructions`. ----
    let setup_tx = build_wsol_setup_tx(
        &rpc,
        &user,
        // bonding_curve isn't on the AMM hot path, but creating its
        // wSOL ATA is cheap + idempotent, and reusing the helper keeps
        // the test focused on the AMM ixs.
        pda::pump::bonding_curve(&mint).0,
        buyback_fee_recipient,
        max_sol_cost,
    )
    .await;
    rpc.send_and_confirm_transaction(&setup_tx)
        .await
        .expect("amm wSOL setup tx");

    let pool_base_balance_before = token_balance(&rpc, &pool.pool_base_token_account).await;

    // ---- Tx 2: buy_amm_instructions (1 ATA prefix + buy_amm) +
    //            unwrap_sol. ----
    let mut buy_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    buy_ixs.extend(
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
    buy_ixs.push(unwrap_sol_ix(&user.pubkey()));
    let buy_sig = send_v0_tx(&rpc, &buy_ixs, &user, &[&user], &alt).await;
    println!("[amm] buy sig: {buy_sig}");

    let user_balance_after_buy = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(
        user_balance_after_buy, base_amount_out,
        "buy_amm should credit exactly base_amount_out"
    );
    let pool_base_balance_after_buy = token_balance(&rpc, &pool.pool_base_token_account).await;
    assert_eq!(
        pool_base_balance_after_buy,
        pool_base_balance_before - base_amount_out,
        "pool's base reserve should decrease by base_amount_out"
    );

    // ---- Tx 3: sell_amm_instructions (1 ATA prefix + sell_amm) +
    //            unwrap_sol. Sell half of what we bought. ----
    let sell_amount = user_balance_after_buy;
    let mut sell_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    sell_ixs.extend(
        sdk.sell_amm_instructions(
            pool_address,
            &global_config,
            &pool,
            base_token_program,
            quote_token_program,
            user.pubkey(),
            sell_amount,
            0,
        )
        .expect("sell_amm_instructions"),
    );
    sell_ixs.push(unwrap_sol_ix(&user.pubkey()));
    let sell_sig = send_v0_tx(&rpc, &sell_ixs, &user, &[&user], &alt).await;
    println!("[amm] sell sig: {sell_sig}");

    let user_balance_after_sell = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(
        user_balance_after_sell,
        user_balance_after_buy - sell_amount,
        "sell_amm should debit exactly sell_amount"
    );
    let pool_base_balance_after_sell = token_balance(&rpc, &pool.pool_base_token_account).await;
    assert!(
        pool_base_balance_after_sell > pool_base_balance_after_buy,
        "pool's base reserve should grow on sell (post_buy={} post_sell={})",
        pool_base_balance_after_buy,
        pool_base_balance_after_sell,
    );

    // The user's wSOL ATA should have been closed by `unwrap_sol_ix`.
    let user_wsol = user_wsol_ata(&user.pubkey());
    assert!(
        rpc.get_account(&user_wsol).await.is_err(),
        "user's wSOL ATA should be closed after the sell tx"
    );
}
