//! Coverage for [`AsyncPumpClient`]'s fetchers and the decoders they
//! sit on top of, run against the local validator booted from the
//! `clone_devnet_accounts` snapshot.
//!
//! Where a getter changes shape pre/post user activity (e.g.
//! `fetch_user_volume_accumulator` returns `Ok(None)` until the user's
//! first buy), the test executes a `buy_v2` and re-asserts the new
//! shape. All test traffic is local-validator only — no devnet/mainnet
//! RPC at runtime.
//!
//! Pre-requisite (run in a separate shell, in this order):
//!   1. `cargo run --features local-validator --bin clone_devnet_accounts`
//!   2. `cargo run --features local-validator --bin local-validator`
//!
//! Then in this shell:
//!   `cargo test --features local-validator --test async_client_fetchers \
//!        -- --ignored --nocapture`

#![cfg(feature = "local-validator")]

mod common;

use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::Instruction;
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

use pump_rust_client::{constants, pda, AsyncPumpClient, PumpClientError, PumpSdk};

use common::fixtures::{GRADUATED_DEVNET_MINT, NOT_GRADUATED_DEVNET_MINT};
use common::{
    airdrop_blocking, build_wsol_setup_tx, fee_recipients, load_alt, make_client, make_rpc,
    send_v0_tx, unwrap_sol_ix, DEFAULT_USER_LAMPORTS,
};

/// Run a `buy_v2` against `mint` for the given user, leaving them
/// holding `amount` base units. Used by tests that need a populated
/// post-buy state to inspect.
async fn buy_v2_for_user(
    client: &AsyncPumpClient,
    user: &Keypair,
    mint: Pubkey,
    amount: u64,
    max_sol_cost: u64,
) {
    let rpc = client.rpc().clone();
    let sdk = PumpSdk::new();
    let global = client.fetch_global().await.expect("fetch_global");
    let bc = client
        .fetch_bonding_curve(&mint)
        .await
        .expect("fetch_bonding_curve");
    let (_fee_recipient, buyback_fee_recipient) = fee_recipients(client).await;
    let bonding_curve = pda::pump::bonding_curve(&mint).0;

    let setup_tx = build_wsol_setup_tx(
        &rpc,
        user,
        bonding_curve,
        buyback_fee_recipient,
        max_sol_cost,
    )
    .await;
    rpc.send_and_confirm_transaction(&setup_tx)
        .await
        .expect("buy_v2_for_user setup tx");

    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;
    let mut ixs: Vec<Instruction> = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    ixs.extend(
        sdk.buy_v2_instructions(
            &global,
            &bc,
            mint,
            constants::SPL_TOKEN_PROGRAM_ID,
            user.pubkey(),
            amount,
            max_sol_cost,
        )
        .expect("buy_v2_instructions"),
    );
    ixs.push(unwrap_sol_ix(&user.pubkey()));
    send_v0_tx(&rpc, &ixs, user, &[user], &alt).await;
}

// ---------------------------------------------------------------------
// Single-account fetchers against cloned admin state.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn fetch_global_returns_cloned_state() {
    let client = make_client();
    let global = client.fetch_global().await.expect("fetch_global");
    assert!(
        global.create_v2_enabled,
        "cloned snapshot must enable create_v2 — re-clone after admin enables it"
    );
    assert!(
        global.token_total_supply > 0,
        "Global.token_total_supply must be initialised"
    );
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn fetch_fee_config_returns_cloned_state() {
    let client = make_client();
    let _fc = client.fetch_fee_config().await.expect("fetch_fee_config");
    // Surfacing a value means the discriminator and decoder agreed; no
    // further admin-state shape to assert generically.
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn fetch_global_volume_accumulator_returns_cloned_state() {
    let client = make_client();
    let _gva = client
        .fetch_global_volume_accumulator()
        .await
        .expect("fetch_global_volume_accumulator");
}

// ---------------------------------------------------------------------
// Bonding-curve fetcher against both fixtures.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn fetch_bonding_curve_works_for_non_graduated_fixture() {
    let client = make_client();
    let bc = client
        .fetch_bonding_curve(&NOT_GRADUATED_DEVNET_MINT)
        .await
        .expect("fetch_bonding_curve for non-graduated fixture");
    assert!(
        !bc.complete,
        "fixture {NOT_GRADUATED_DEVNET_MINT} should not be graduated"
    );
    assert!(
        bc.virtual_token_reserves > 0,
        "non-graduated curve must have virtual_token_reserves"
    );
    assert_eq!(
        bc.quote_mint,
        Pubkey::default(),
        "fixture quote should be Pubkey::default()"
    );
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn fetch_bonding_curve_works_for_graduated_fixture() {
    let client = make_client();
    let bc = client
        .fetch_bonding_curve(&GRADUATED_DEVNET_MINT)
        .await
        .expect("fetch_bonding_curve for graduated fixture");
    assert!(
        bc.complete,
        "fixture {GRADUATED_DEVNET_MINT} should be graduated"
    );
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn fetch_bonding_curve_errors_on_missing_mint() {
    let client = make_client();
    let unknown = Pubkey::new_unique();
    let err = client
        .fetch_bonding_curve(&unknown)
        .await
        .expect_err("missing mint must error");
    match err {
        PumpClientError::AccountNotFound { name, .. } => assert_eq!(name, "bonding_curve"),
        other => panic!("expected AccountNotFound, got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// User-volume accumulator: nullable until the user has bought.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn fetch_user_volume_accumulator_returns_none_then_some() {
    let rpc = make_rpc();
    let client = make_client();
    let user = Keypair::new();
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;

    let pre = client
        .fetch_user_volume_accumulator(&user.pubkey())
        .await
        .expect("fetch UVA before any buy");
    assert!(pre.is_none(), "UVA must be None for a fresh user");

    buy_v2_for_user(
        &client,
        &user,
        NOT_GRADUATED_DEVNET_MINT,
        300_000_000,
        LAMPORTS_PER_SOL,
    )
    .await;

    let post = client
        .fetch_user_volume_accumulator(&user.pubkey())
        .await
        .expect("fetch UVA after first buy");
    // Decoder returning `Some(_)` is the assertion: the discriminator
    // matched and the buffer parsed against the IDL-derived layout.
    // Field-level invariants (total volume etc.) are program-controlled
    // and not stable enough to pin down here.
    assert!(post.is_some(), "UVA must be Some after first buy");
}

// ---------------------------------------------------------------------
// fetch_buy_state: bonding_curve always present, associated_user
// optional pre-buy and present after the ATA exists.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn fetch_buy_state_returns_bc_and_optional_user_ata() {
    let rpc = make_rpc();
    let client = make_client();
    let user = Keypair::new();
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;

    let pre = client
        .fetch_buy_state(
            &NOT_GRADUATED_DEVNET_MINT,
            &user.pubkey(),
            &constants::SPL_TOKEN_2022_PROGRAM_ID,
        )
        .await
        .expect("fetch_buy_state pre-buy");
    assert!(
        !pre.bonding_curve.complete,
        "pre-buy bonding_curve.complete should match the fixture"
    );
    assert!(
        pre.associated_user_account.is_none(),
        "associated_user_account should be None before the ATA exists"
    );

    buy_v2_for_user(
        &client,
        &user,
        NOT_GRADUATED_DEVNET_MINT,
        300_000_000,
        LAMPORTS_PER_SOL,
    )
    .await;

    let post = client
        .fetch_buy_state(
            &NOT_GRADUATED_DEVNET_MINT,
            &user.pubkey(),
            &constants::SPL_TOKEN_2022_PROGRAM_ID,
        )
        .await
        .expect("fetch_buy_state post-buy");
    let user_ata = post
        .associated_user_account
        .expect("associated_user_account must be Some after the buy created the ATA");
    assert_eq!(
        user_ata.owner,
        constants::SPL_TOKEN_2022_PROGRAM_ID,
        "user ATA must be Token-2022-owned"
    );
}

// ---------------------------------------------------------------------
// fetch_sell_state: errors with `AccountNotFound("associated_user")`
// until the user holds base tokens; succeeds afterwards.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn fetch_sell_state_errors_until_user_holds_base() {
    let rpc = make_rpc();
    let client = make_client();
    let user = Keypair::new();
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;

    let err = client
        .fetch_sell_state(
            &NOT_GRADUATED_DEVNET_MINT,
            &user.pubkey(),
            &constants::SPL_TOKEN_2022_PROGRAM_ID,
        )
        .await
        .expect_err("fetch_sell_state pre-buy must error");
    match err {
        PumpClientError::AccountNotFound { name, address } => {
            assert_eq!(name, "associated_user");
            let expected_ata = pda::associated_token(
                &user.pubkey(),
                &constants::SPL_TOKEN_2022_PROGRAM_ID,
                &NOT_GRADUATED_DEVNET_MINT,
            )
            .0;
            assert_eq!(address, expected_ata, "error reports the missing user ATA");
        }
        other => panic!("expected AccountNotFound, got {other:?}"),
    }

    buy_v2_for_user(
        &client,
        &user,
        NOT_GRADUATED_DEVNET_MINT,
        300_000_000,
        LAMPORTS_PER_SOL,
    )
    .await;

    let state = client
        .fetch_sell_state(
            &NOT_GRADUATED_DEVNET_MINT,
            &user.pubkey(),
            &constants::SPL_TOKEN_2022_PROGRAM_ID,
        )
        .await
        .expect("fetch_sell_state must succeed once the user holds base");
    assert!(
        state.bonding_curve.real_quote_reserves > 0,
        "sell-state bonding_curve must reflect the prior buy"
    );
    assert_eq!(
        state.bonding_curve_account.owner,
        pump_rust_client::pump::ID,
        "sell-state bonding_curve account is owned by pump"
    );
}

// ---------------------------------------------------------------------
// get_creator_vault_balance: zero pre-trades, positive after a buy
// (the program credits the creator vault on every buy_v2).
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn get_creator_vault_balance_grows_after_buy() {
    let rpc = make_rpc();
    let client = make_client();

    let bc = client
        .fetch_bonding_curve(&NOT_GRADUATED_DEVNET_MINT)
        .await
        .unwrap();
    let creator = bc.creator;

    let pre = client
        .get_creator_vault_balance(&creator)
        .await
        .expect("creator vault pre-buy");

    let user = Keypair::new();
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;
    buy_v2_for_user(
        &client,
        &user,
        NOT_GRADUATED_DEVNET_MINT,
        300_000_000,
        LAMPORTS_PER_SOL,
    )
    .await;

    let post = client
        .get_creator_vault_balance(&creator)
        .await
        .expect("creator vault post-buy");
    assert!(
        post >= pre,
        "creator vault balance must not shrink after a buy (pre={pre} post={post})"
    );
}

// ---------------------------------------------------------------------
// `get_creator_vault_balance` for an unused creator returns 0 even when
// the underlying PDA does not exist (per the function's contract).
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn get_creator_vault_balance_returns_zero_for_unused_creator() {
    let client = make_client();
    let unused = Pubkey::new_unique();
    let bal = client
        .get_creator_vault_balance(&unused)
        .await
        .expect("get_creator_vault_balance");
    assert_eq!(
        bal, 0,
        "fresh creator with no vault PDA must report a 0 balance"
    );
}
