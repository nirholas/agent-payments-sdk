#![allow(clippy::all)]

mod pump_config;
mod utils;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use solana_rpc::rpc::JsonRpcConfig;
use solana_sdk::account::{Account, AccountSharedData};
use solana_sdk::address_lookup_table::state::{AddressLookupTable, LookupTableMeta};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{read_keypair_file, Keypair};
use solana_sdk::signer::Signer;
use solana_streamer::socket::SocketAddrSpace;
use solana_test_validator::TestValidatorGenesis;
use tokio::time::Instant;

use pump_config::{known_lookup_tables, known_wallets, pump_programs_to_add, setup_pump_config};
use utils::{
    create_wallet_associated_token_account, remove_directory_contents, start_faucet,
    AccountConfigInfo,
};

/// Default lamport balance seeded onto known wallets and other system accounts (~10,000 SOL).
const DEFAULT_ACCOUNT_LAMPORTS: u64 = 10_000_000_000_000;
const LEDGER_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/test-ledger");
const PROGRAMS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/artifacts");
/// Optional bincode+zstd dump of `HashMap<Pubkey, Account>` produced by the
/// user's RPC-cloning script. If absent, the validator boots without it.
const ACCOUNTS_TO_LOAD_FILE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/artifacts/accounts_to_load.zst"
);
const MAX_GENESIS_ARCHIVE_UNPACKED_SIZE: u64 = 1024 * 1024 * 1024;

/// Rewrites every known address-lookup-table entry in `accounts` so its
/// metadata is `LookupTableMeta::default()` — i.e. active from slot 0.
/// Without this, the test validator boots the ALT in a "deactivating /
/// not-yet-active" window and any tx referencing it fails to compile.
fn rewrite_lookup_tables_active_from_slot_zero(accounts: &mut HashMap<Pubkey, Account>) {
    let known = known_lookup_tables();
    for (key, account) in accounts.clone() {
        if !known.contains(&key) {
            continue;
        }
        match AddressLookupTable::deserialize(&account.data) {
            Ok(mut deserialized) => {
                deserialized.meta = LookupTableMeta::default();
                match AddressLookupTable::serialize_for_tests(deserialized) {
                    Ok(serialized) => {
                        accounts.insert(
                            key,
                            Account {
                                data: serialized,
                                ..account
                            },
                        );
                    }
                    Err(err) => {
                        eprintln!("⚠️  Failed to re-serialize ALT {key}: {err}");
                    }
                }
            }
            Err(err) => {
                eprintln!("⚠️  Failed to deserialize address lookup table account {key}: {err}");
            }
        }
    }
}

async fn setup_validator() -> Result<TestValidatorGenesis, Box<dyn std::error::Error>> {
    let mut g = TestValidatorGenesis::default();
    remove_directory_contents(LEDGER_PATH);

    let mut rpc_config = JsonRpcConfig::default_for_test();
    rpc_config.enable_rpc_transaction_history = true;
    g.rpc_config(rpc_config);
    g.rpc_port(8899);
    g.ledger_path(LEDGER_PATH);
    g.max_genesis_archive_unpacked_size = Some(MAX_GENESIS_ARCHIVE_UNPACKED_SIZE);
    // Bind RPC to all interfaces so external explorers can connect.
    g.bind_ip_addr(IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0)));
    // Default 5000 conflicts with macOS ControlCenter.
    g.gossip_port(5050);

    let faucet_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 9000);
    let faucet_pubkey = start_faucet(faucet_addr, LEDGER_PATH);
    g.faucet_addr(Some(faucet_addr));

    let mut accounts_to_load: Vec<(AccountConfigInfo, Option<u64>)> =
        vec![(AccountConfigInfo::system(faucet_pubkey), None)];
    for wallet in known_wallets() {
        accounts_to_load.push((AccountConfigInfo::system(wallet), None));
    }

    // ---- USER PLUG-IN POINT #1: load cloned accounts from RPC dump (optional). ----
    if std::path::Path::new(ACCOUNTS_TO_LOAD_FILE).exists() {
        println!("📦 Loading cloned accounts from {ACCOUNTS_TO_LOAD_FILE}");
        let bytes = std::fs::read(ACCOUNTS_TO_LOAD_FILE)?;
        let decompressed = zstd::stream::decode_all(&bytes[..])?;
        let mut accounts: HashMap<Pubkey, Account> = bincode::deserialize(&decompressed)?;
        rewrite_lookup_tables_active_from_slot_zero(&mut accounts);
        for (key, account) in accounts {
            accounts_to_load.push((AccountConfigInfo::from_account(key, &account), None));
        }
    }

    // ---- USER PLUG-IN POINT #2: seed ATAs for known wallets/mints. ----
    // Example:
    //   let mints: Vec<Pubkey> = vec![/* mint pubkeys present in accounts_to_load */];
    //   create_wallet_associated_token_account(&mut accounts_to_load, &mints, &known_wallets());
    let _ = create_wallet_associated_token_account; // silence unused warning until wired up

    println!("🔥 Adding {} accounts to validator", accounts_to_load.len());
    for (account_to_load, lamports) in accounts_to_load {
        let lamports = lamports.unwrap_or_else(|| {
            if account_to_load.address == faucet_pubkey {
                DEFAULT_ACCOUNT_LAMPORTS * 1000
            } else {
                DEFAULT_ACCOUNT_LAMPORTS
            }
        });
        let account = Account {
            lamports,
            data: account_to_load.data,
            owner: account_to_load.owner,
            ..Default::default()
        };
        g.add_account(account_to_load.address, AccountSharedData::from(account));
    }

    let programs = pump_programs_to_add();
    println!("🔥 Adding {} programs to validator", programs.len());
    for p in programs {
        g.add_program(&format!("{}/{}", PROGRAMS_PATH, p.name), p.program_id);
    }
    Ok(g)
}

#[tokio::main]
async fn setup_validator_tokio() -> TestValidatorGenesis {
    setup_validator().await.expect("setup_validator failed")
}

#[tokio::main]
async fn run_post_start() {
    setup_pump_config()
        .await
        .expect("post-start setup_pump_config failed");
}

fn load_payer() -> Keypair {
    match std::env::var("PUMP_LOCALNET_KEYPAIR") {
        Ok(path) => read_keypair_file(&path).expect("read PUMP_LOCALNET_KEYPAIR file"),
        Err(_) => Keypair::new(),
    }
}

fn main() {
    let payer = load_payer();
    let g = setup_validator_tokio();

    println!("Waiting on solana library to start");
    let start_time = Instant::now();
    let test_validator = g
        .start_with_mint_address(payer.pubkey(), SocketAddrSpace::new(true))
        .expect("start_with_mint_address");
    println!(
        "Solana ledger started in {:?} seconds",
        start_time.elapsed().as_secs()
    );
    println!("RPC: {}", test_validator.get_rpc_client().url());
    println!("Mint authority pubkey: {}", payer.pubkey());

    run_post_start();
    println!("✅ Pump localnet ready");
    test_validator.join();
}
