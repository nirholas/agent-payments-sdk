//! End-to-end coverage for [`PumpSdk::trade_tx_instructions`] /
//! [`PumpSdk::trade_tx_instructions`] and [`PumpSdk::create_coin_instructions`],
//! plus parity
//! checks between the offline `*_quote_*` helpers and what the on-chain
//! programs actually do (verified by simulating the trade tx the SDK
//! built for that quote).
//!
//! Pre-requisite (run in a separate shell, in this order):
//!   1. `cargo run --features local-validator --bin clone_devnet_accounts`
//!   2. `cargo run --features local-validator --bin local-validator`
//!
//! Then in this shell:
//!   `cargo test --features local-validator --test trade_tx_and_quotes \
//!        -- --ignored --nocapture`

#![cfg(feature = "local-validator")]

mod common;

use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::Instruction;
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

use pump_rust_client::accounts::decode_fee_config;
use pump_rust_client::accounts::pump_amm::{decode_global_config, decode_pool};
use pump_rust_client::{
    constants, pda, AmmQuoteSource, CreateCoinParams, PumpPoolCtx, PumpSdk, TradeTxParams,
};

use common::fixtures::{GRADUATED_DEVNET_MINT, NOT_GRADUATED_DEVNET_MINT};
use common::{
    airdrop_blocking, build_wsol_setup_tx, fee_recipients, load_alt, make_client, make_rpc,
    send_v0_tx, token_balance, unwrap_sol_ix, user_wsol_ata, DEFAULT_USER_LAMPORTS,
};

const SLIPPAGE_BPS: u16 = 500; // 5% — generous, the test only needs simulation to pass

// ---------------------------------------------------------------------
// Bonding-curve trade-tx flow.
//
// `trade_tx_instructions` builds a single self-contained tx (4 ATAs +
// optional wrap + buy_v2/sell_v2 + close_account). It fits inside a v0
// tx with the cloned pump trade ALT.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn trade_tx_bonding_curve_buy_then_sell() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();

    let mint = NOT_GRADUATED_DEVNET_MINT;
    let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;

    let global = client.fetch_global().await.expect("fetch_global");
    let bc_pre = client
        .fetch_bonding_curve(&mint)
        .await
        .expect("fetch_bonding_curve for non-graduated fixture mint");
    assert!(!bc_pre.complete, "fixture must not be graduated");

    let user = Keypair::new();
    println!("[trade_tx/bc] user = {}", user.pubkey());
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;

    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;
    let user_base_ata = pda::associated_token(&user.pubkey(), &base_token_program, &mint).0;

    // ---- Buy 300M base units. `trade_tx_instructions` handles wSOL
    //      wrap inside the same tx; we only have to set the SOL ceiling. ----
    let buy_amount = 300_000_000u64;
    let max_sol_cost = LAMPORTS_PER_SOL;
    let mut buy_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    buy_ixs.extend(
        sdk.trade_tx_instructions(TradeTxParams {
            mint,
            base_token_program,
            quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
            user: user.pubkey(),
            is_buy: true,
            base_amount: buy_amount,
            sol_amount_threshold: max_sol_cost,
            pump_global: &global,
            bonding_curve: &bc_pre,
            pump_pool: None,
        })
        .expect("trade_tx buy ix"),
    );
    let buy_sig = send_v0_tx(&rpc, &buy_ixs, &user, &[&user], &alt).await;
    println!("[trade_tx/bc] buy sig: {buy_sig}");

    let user_balance_after_buy = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(user_balance_after_buy, buy_amount, "trade_tx BC buy amount");
    let bc_after_buy = client.fetch_bonding_curve(&mint).await.unwrap();
    assert!(
        bc_after_buy.real_quote_reserves > bc_pre.real_quote_reserves,
        "trade_tx BC buy must raise real_quote_reserves"
    );

    // ---- Sell the full balance. `trade_tx_instructions(is_buy=false)`
    //      skips the SOL wrap (sell doesn't need it) but still appends
    //      close_account so any residual wSOL is unwrapped. ----
    let sell_amount = user_balance_after_buy;
    let mut sell_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    sell_ixs.extend(
        sdk.trade_tx_instructions(TradeTxParams {
            mint,
            base_token_program,
            quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
            user: user.pubkey(),
            is_buy: false,
            base_amount: sell_amount,
            sol_amount_threshold: 1, // 1 lamport floor
            pump_global: &global,
            bonding_curve: &bc_after_buy,
            pump_pool: None,
        })
        .expect("trade_tx sell ix"),
    );
    let sell_sig = send_v0_tx(&rpc, &sell_ixs, &user, &[&user], &alt).await;
    println!("[trade_tx/bc] sell sig: {sell_sig}");

    let user_balance_after_sell = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(
        user_balance_after_sell,
        user_balance_after_buy - sell_amount,
        "trade_tx BC sell amount"
    );
    // close_account at the end of the trade tx unwraps any remaining wSOL.
    assert!(
        rpc.get_account(&user_wsol_ata(&user.pubkey()))
            .await
            .is_err(),
        "user's wSOL ATA should be closed after the sell trade tx"
    );
}

// ---------------------------------------------------------------------
// AMM trade-tx flow against the cloned graduated mint + pool.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn trade_tx_amm_buy_then_sell() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();

    let mint = GRADUATED_DEVNET_MINT;
    let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;

    let pool_creator = pda::pump::pool_authority(&mint).0;
    let pool_address = pda::pump_amm::pool(0, &pool_creator, &mint, &constants::NATIVE_MINT).0;
    let pool_account = rpc
        .get_account(&pool_address)
        .await
        .expect("pool missing — re-clone after a graduated fixture mint");
    let pool = decode_pool(&pool_account.data).expect("decode_pool");

    let global = client.fetch_global().await.expect("fetch_global");
    let global_config = decode_global_config(
        &rpc.get_account(&pda::pump_amm::global_config().0)
            .await
            .expect("pump_amm global_config")
            .data,
    )
    .expect("decode_global_config");
    let bonding_curve = client
        .fetch_bonding_curve(&mint)
        .await
        .expect("bonding_curve for graduated mint");
    assert!(
        bonding_curve.complete,
        "fixture mint must be migrated (complete bonding curve)"
    );

    let user = Keypair::new();
    println!(
        "[trade_tx/amm] user = {} pool = {pool_address}",
        user.pubkey()
    );
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;

    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;
    let user_base_ata = pda::associated_token(&user.pubkey(), &base_token_program, &mint).0;

    let buy_amount = 1_000_000u64;
    let max_sol_cost = LAMPORTS_PER_SOL;
    let mut buy_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    buy_ixs.extend(
        sdk.trade_tx_instructions(TradeTxParams {
            mint,
            base_token_program,
            quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
            user: user.pubkey(),
            is_buy: true,
            base_amount: buy_amount,
            sol_amount_threshold: max_sol_cost,
            pump_global: &global,
            bonding_curve: &bonding_curve,
            pump_pool: Some(PumpPoolCtx {
                pool: pool_address,
                amm_global: &global_config,
                pool_state: &pool,
            }),
        })
        .expect("trade_tx AMM buy ix"),
    );
    let buy_sig = send_v0_tx(&rpc, &buy_ixs, &user, &[&user], &alt).await;
    println!("[trade_tx/amm] buy sig: {buy_sig}");

    let user_balance_after_buy = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(
        user_balance_after_buy, buy_amount,
        "trade_tx AMM buy amount"
    );

    let sell_amount = user_balance_after_buy;
    let mut sell_ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    sell_ixs.extend(
        sdk.trade_tx_instructions(TradeTxParams {
            mint,
            base_token_program,
            quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
            user: user.pubkey(),
            is_buy: false,
            base_amount: sell_amount,
            sol_amount_threshold: 0,
            pump_global: &global,
            bonding_curve: &bonding_curve,
            pump_pool: Some(PumpPoolCtx {
                pool: pool_address,
                amm_global: &global_config,
                pool_state: &pool,
            }),
        })
        .expect("trade_tx AMM sell ix"),
    );
    let sell_sig = send_v0_tx(&rpc, &sell_ixs, &user, &[&user], &alt).await;
    println!("[trade_tx/amm] sell sig: {sell_sig}");

    let user_balance_after_sell = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(
        user_balance_after_sell,
        user_balance_after_buy - sell_amount,
        "trade_tx AMM sell amount"
    );
}

// ---------------------------------------------------------------------
// Quote-vs-simulation parity.
//
// `*_quote_*` helpers are pure math; they should agree with the
// on-chain program. We feed the quote's `min_out` / `max_input` straight
// back into the SDK's instruction builders and ask the validator to
// simulate the resulting tx — the program's slippage check is exactly
// what we want to verify against.
// ---------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn quote_bc_token_out_simulation_matches() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();

    let (_fee_recipient, buyback_fee_recipient) = fee_recipients(&client).await;
    let mint = NOT_GRADUATED_DEVNET_MINT;

    let global = client.fetch_global().await.unwrap();
    let fee_config = client.fetch_fee_config().await.ok();
    let bc = client.fetch_bonding_curve(&mint).await.unwrap();

    // Quote: I want exactly 300M base units; what's the slippage-adjusted
    // ceiling on SOL spent?
    let target_amount = 300_000_000u64;
    let quote = sdk
        .buy_quote_bonding_curve_token_out(
            &global,
            fee_config.as_ref(),
            &bc,
            global.token_total_supply,
            target_amount,
            SLIPPAGE_BPS,
        )
        .expect("buy_quote_bonding_curve_token_out");
    println!(
        "[quote/bc] target={target_amount} sol_cost={} max_input={}",
        quote.amount, quote.max_input,
    );

    // Build the buy tx the quote implies and simulate it. Funded user
    // is needed even for simulation so that `wrap_sol`'s
    // `system_instruction::transfer` doesn't trip on insufficient lamports.
    let user = Keypair::new();
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;
    let bonding_curve = pda::pump::bonding_curve(&mint).0;
    let setup_tx = build_wsol_setup_tx(
        &rpc,
        &user,
        bonding_curve,
        buyback_fee_recipient,
        quote.max_input,
    )
    .await;
    rpc.send_and_confirm_transaction(&setup_tx)
        .await
        .expect("setup tx for quote-parity simulation");

    let mut ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    ixs.extend(
        sdk.buy_v2_instructions(
            &global,
            &bc,
            mint,
            constants::SPL_TOKEN_PROGRAM_ID,
            user.pubkey(),
            target_amount,
            quote.max_input,
        )
        .expect("buy_v2_instructions"),
    );
    ixs.push(unwrap_sol_ix(&user.pubkey()));

    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;
    let blockhash = rpc.get_latest_blockhash().await.unwrap();
    let msg = solana_sdk::message::v0::Message::try_compile(
        &user.pubkey(),
        &ixs,
        std::slice::from_ref(&alt),
        blockhash,
    )
    .unwrap();
    let signers: Vec<&dyn solana_sdk::signer::Signer> = vec![&user];
    let tx = solana_sdk::transaction::VersionedTransaction::try_new(
        solana_sdk::message::VersionedMessage::V0(msg),
        &signers,
    )
    .unwrap();
    let result = client
        .simulate_transaction(&tx)
        .await
        .expect("simulate transaction");
    assert!(
        result.err.is_none(),
        "buy_v2 simulation failed at quote.max_input ({}): err={:?} logs={:?}",
        quote.max_input,
        result.err,
        result.logs,
    );
    println!(
        "[quote/bc] simulation OK, units_consumed={:?}",
        result.units_consumed
    );
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn quote_amm_token_out_simulation_matches() {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();

    let (_fee_recipient, buyback_fee_recipient) = fee_recipients(&client).await;
    let mint = GRADUATED_DEVNET_MINT;
    let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;

    let pool_creator = pda::pump::pool_authority(&mint).0;
    let pool_address = pda::pump_amm::pool(0, &pool_creator, &mint, &constants::NATIVE_MINT).0;
    let pool = decode_pool(
        &rpc.get_account(&pool_address)
            .await
            .expect("pool account")
            .data,
    )
    .expect("decode_pool");

    // GlobalConfig + FeeConfig come from the cloned snapshot via raw
    // RPC fetch (AsyncPumpClient doesn't expose pump_amm fetchers).
    let global_config = decode_global_config(
        &rpc.get_account(&pda::pump_amm::global_config().0)
            .await
            .expect("pump_amm global_config")
            .data,
    )
    .expect("decode_global_config");
    let fee_config_account = rpc.get_account(&pda::pump_amm::fee_config().0).await.ok();
    let amm_fee_config = fee_config_account
        .as_ref()
        .and_then(|acct| decode_fee_config(&acct.data).ok());

    // Live reserves come straight from the pool's token accounts.
    let base_reserve = token_balance(&rpc, &pool.pool_base_token_account).await;
    let quote_reserve = token_balance(&rpc, &pool.pool_quote_token_account).await;
    let base_supply = match rpc.get_token_supply(&mint).await {
        Ok(s) => s.amount.parse::<u64>().expect("supply is u64"),
        Err(_) => 0,
    };

    let target_amount = 1_000_000u64;
    let quote = sdk
        .buy_quote_amm_token_out(
            &global_config,
            amm_fee_config.as_ref(),
            AmmQuoteSource::Pool {
                pool: &pool,
                base_reserve,
                quote_reserve,
                base_mint_supply: base_supply,
            },
            target_amount,
            SLIPPAGE_BPS,
        )
        .expect("buy_quote_amm_token_out");
    println!(
        "[quote/amm] target={target_amount} cost={} max_input={}",
        quote.amount, quote.max_input,
    );

    // Build + simulate.
    let user = Keypair::new();
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;
    let setup_tx = build_wsol_setup_tx(
        &rpc,
        &user,
        pda::pump::bonding_curve(&mint).0,
        buyback_fee_recipient,
        quote.max_input,
    )
    .await;
    rpc.send_and_confirm_transaction(&setup_tx)
        .await
        .expect("setup tx for AMM quote-parity simulation");

    let mut ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    ixs.extend(
        sdk.buy_amm_instructions(
            pool_address,
            &global_config,
            &pool,
            base_token_program,
            constants::SPL_TOKEN_PROGRAM_ID,
            user.pubkey(),
            target_amount,
            quote.max_input,
        )
        .expect("buy_amm_instructions"),
    );
    ixs.push(unwrap_sol_ix(&user.pubkey()));

    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;
    let blockhash = rpc.get_latest_blockhash().await.unwrap();
    let msg = solana_sdk::message::v0::Message::try_compile(
        &user.pubkey(),
        &ixs,
        std::slice::from_ref(&alt),
        blockhash,
    )
    .unwrap();
    let signers: Vec<&dyn solana_sdk::signer::Signer> = vec![&user];
    let tx = solana_sdk::transaction::VersionedTransaction::try_new(
        solana_sdk::message::VersionedMessage::V0(msg),
        &signers,
    )
    .unwrap();
    let result = client
        .simulate_transaction(&tx)
        .await
        .expect("simulate transaction");
    assert!(
        result.err.is_none(),
        "buy_amm simulation failed at quote.max_input ({}): err={:?} logs={:?}",
        quote.max_input,
        result.err,
        result.logs,
    );
    println!(
        "[quote/amm] simulation OK, units_consumed={:?}",
        result.units_consumed
    );
}

// ---------------------------------------------------------------------
// `create_coin_instructions` end-to-end + a follow-up `trade_tx` sell.
//
// Mirrors `TradeTxService.createCoin` minus the optional tokenized-agent
// step. The create-coin flow already includes the wSOL wrap; the
// follow-up sell uses `trade_tx_instructions` against the same mint.
// ---------------------------------------------------------------------

async fn run_create_coin_then_trade_tx_sell(
    mayhem_mode: bool,
    cashback: bool,
    tokenized_agent_buyback_bps: Option<u16>,
) {
    let rpc = make_rpc();
    let client = make_client();
    let sdk = PumpSdk::new();

    let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;

    let user = Keypair::new();
    let mint = Keypair::new();
    println!(
        "[create_coin mayhem={mayhem_mode} cashback={cashback} agent_bps={tokenized_agent_buyback_bps:?}] user = {} mint = {}",
        user.pubkey(),
        mint.pubkey()
    );
    airdrop_blocking(&rpc, &user.pubkey(), DEFAULT_USER_LAMPORTS).await;

    let token_amount = 1_000_000_000u64;
    let max_sol_cost = LAMPORTS_PER_SOL;
    let alt = load_alt(&rpc, constants::DEVNET_ALT).await;
    let global = client.fetch_global().await.expect("fetch_global");

    // ---- Tx 1: create_coin_instructions returns create_v2 + ATAs +
    //            buy_v2 (+ optional agent_initialize); the program handles
    //            SOL → wSOL internally so no client-side wrap/unwrap is
    //            needed. ----
    let create_ixs = sdk
        .create_coin_instructions(CreateCoinParams {
            mint: mint.pubkey(),
            user: user.pubkey(),
            creator: user.pubkey(),
            name: "TradeTx Test".into(),
            symbol: "TXT".into(),
            uri: "https://example.com/txt.json".into(),
            mayhem_mode,
            cashback,
            quote_mint: Pubkey::default(),
            global: &global,
            token_amount,
            max_quote_tokens: max_sol_cost,
            tokenized_agent_buyback_bps,
        })
        .expect("create_coin_instructions");
    let create_sig = send_v0_tx(&rpc, &create_ixs, &user, &[&user, &mint], &alt).await;
    println!("[create_coin] create+buy sig: {create_sig}");

    if tokenized_agent_buyback_bps.is_some() {
        let token_agent_payments_pda = pda::pump_agent_payments::token_agent_payments(&mint.pubkey()).0;
        let acct = rpc
            .get_account(&token_agent_payments_pda)
            .await
            .expect("token_agent_payments account exists post-create");
        assert_eq!(
            acct.owner,
            pump_rust_client::constants::pump_agent_payments::PROGRAM_ID,
            "token_agent_payments owned by pump_agent_payments program",
        );
    }

    let user_base_ata =
        pda::associated_token(&user.pubkey(), &base_token_program, &mint.pubkey()).0;
    let balance_after_create = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(balance_after_create, token_amount, "initial buy amount");

    let bc_after_create = client
        .fetch_bonding_curve(&mint.pubkey())
        .await
        .expect("bonding_curve post-create");
    assert_eq!(bc_after_create.creator, user.pubkey(), "creator preserved");
    assert_eq!(
        bc_after_create.is_mayhem_mode, mayhem_mode,
        "mayhem_mode flag persisted"
    );
    assert_eq!(
        bc_after_create.is_cashback_coin, cashback,
        "cashback flag persisted"
    );

    // ---- Tx 2: sell the full balance via trade_tx_instructions. ----
    let sell_amount = balance_after_create;
    let mut sell_ixs: Vec<Instruction> =
        vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
    sell_ixs.extend(
        sdk.trade_tx_instructions(TradeTxParams {
            mint: mint.pubkey(),
            base_token_program,
            quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
            user: user.pubkey(),
            is_buy: false,
            base_amount: sell_amount,
            sol_amount_threshold: 1,
            pump_global: &global,
            bonding_curve: &bc_after_create,
            pump_pool: None,
        })
        .expect("trade_tx sell ix"),
    );
    let sell_sig = send_v0_tx(&rpc, &sell_ixs, &user, &[&user], &alt).await;
    println!("[create_coin] sell sig: {sell_sig}");

    let balance_after_sell = token_balance(&rpc, &user_base_ata).await;
    assert_eq!(
        balance_after_sell,
        balance_after_create - sell_amount,
        "post-sell balance"
    );
    let bc = client.fetch_bonding_curve(&mint.pubkey()).await.unwrap();
    assert!(!bc.complete, "fresh mint should not graduate from one buy");
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn create_coin_then_trade_tx_sell() {
    run_create_coin_then_trade_tx_sell(false, false, None).await;
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn create_coin_mayhem_then_trade_tx_sell() {
    run_create_coin_then_trade_tx_sell(true, false, None).await;
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn create_coin_cashback_then_trade_tx_sell() {
    run_create_coin_then_trade_tx_sell(false, true, None).await;
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn create_coin_mayhem_and_cashback_then_trade_tx_sell() {
    run_create_coin_then_trade_tx_sell(true, true, None).await;
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn create_coin_with_tokenized_agent_then_trade_tx_sell() {
    run_create_coin_then_trade_tx_sell(false, false, Some(5000)).await;
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn create_coin_cashback_with_tokenized_agent_then_trade_tx_sell() {
    run_create_coin_then_trade_tx_sell(false, true, Some(2500)).await;
}

#[tokio::test]
#[ignore = "requires `cargo run --features local-validator --bin local-validator` running"]
async fn create_coin_mayhem_with_tokenized_agent_then_trade_tx_sell() {
    run_create_coin_then_trade_tx_sell(true, false, Some(10000)).await;
}
