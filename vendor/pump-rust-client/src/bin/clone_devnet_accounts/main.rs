//! Fetches the admin-initialized PDAs the SDK needs (`Global`, `FeeConfig`,
//! mayhem `global-params`/`sol-vault`, the pump trade ALT, etc.) from a
//! Solana cluster and dumps them to `artifacts/accounts_to_load.zst` — the
//! file the local validator boots with via
//! `src/bin/local_validator/main.rs`.
//!
//! Network selection (which ALT / fixture layout to use):
//!   - `--network devnet|mainnet` (CLI), or `PUMP_NETWORK` — defaults to devnet.
//!
//! RPC endpoint precedence:
//!   1. `--rpc-url <URL>` or a single positional `<RPC_URL>` (same meaning)
//!   2. `PUMP_CLONE_RPC`
//!   3. Public Solana cluster RPC for the selected network
//!
//! Per-PDA mainnet override: entries in `fixed_pdas` carry a
//! `fetch_from_mainnet` bool. When set, that PDA is fetched from mainnet even
//! on a devnet run via a separate `RpcClient`. The mainnet endpoint comes from
//! `PUMP_CLONE_MAINNET_RPC` (if set) or the public mainnet-beta URL.
//!
//! A `.env` in the current directory is loaded when present (`dotenvy`), so
//! `PUMP_CLONE_RPC` / `PUMP_CLONE_MAINNET_RPC` / `PUMP_NETWORK` can live there.
//!
//! Run once before `cargo run --features local-validator --bin local-validator`:
//!   `cargo run --features local-validator --bin clone_devnet_accounts -- --help`

use std::collections::HashMap;
use std::fs;

use anchor_lang::AccountSerialize;
use anchor_spl::token::spl_token;
use solana_client::rpc_client::RpcClient;
use solana_program::program_pack::Pack;
use solana_sdk::account::Account;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_sdk::system_program;

use pump_rust_client::accounts::pump_amm::decode_pool;
use pump_rust_client::accounts::{decode_bonding_curve, decode_global};
use pump_rust_client::constants;
use pump_rust_client::pda;
use pump_rust_client::state::Global;

#[path = "../../../tests/common/fixtures.rs"]
mod fixtures;
use fixtures::{FixtureMint, FIXTURE_MINTS};

const OUT_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/artifacts/accounts_to_load.zst"
);

#[derive(Clone, Copy, Debug)]
enum Network {
    Devnet,
    Mainnet,
}

impl Network {
    fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "mainnet" | "mainnet-beta" => Ok(Network::Mainnet),
            "devnet" => Ok(Network::Devnet),
            other => Err(format!(
                "network must be devnet or mainnet (or mainnet-beta), got `{other}`"
            )),
        }
    }

    fn from_env() -> Self {
        let s = std::env::var("PUMP_NETWORK").unwrap_or_else(|_| "devnet".into());
        Self::parse(&s).unwrap_or_else(|e| panic!("{e}"))
    }

    fn default_rpc(self) -> &'static str {
        match self {
            // Public cluster RPCs (rate-limited). For dedicated providers, set `PUMP_CLONE_RPC`.
            Network::Devnet => "https://api.devnet.solana.com",
            Network::Mainnet => "https://api.mainnet-beta.solana.com",
        }
    }

    fn alt(self) -> Pubkey {
        match self {
            Network::Devnet => constants::DEVNET_ALT,
            Network::Mainnet => constants::MAINNET_ALT,
        }
    }

    fn alt_label(self) -> &'static str {
        match self {
            Network::Devnet => "alt:devnet",
            Network::Mainnet => "alt:mainnet",
        }
    }
}

struct Cli {
    network: Option<Network>,
    /// From `-r` / `--rpc-url` or a single positional argument.
    rpc_url: Option<String>,
}

fn print_usage() {
    println!(
        "\
clone_devnet_accounts — snapshot on-chain accounts for the local validator

Usage:
  clone_devnet_accounts [OPTIONS] [RPC_URL]

Options:
  -n, --network <NETWORK>   devnet | mainnet (sets which ALT / fixtures apply).
                              Overrides PUMP_NETWORK.
  -r, --rpc-url <URL>         RPC HTTP endpoint. Overrides PUMP_CLONE_RPC.
  -h, --help                  Print this help.

If RPC_URL is given as the first non-option argument, it is treated like --rpc-url.
Do not pass both --rpc-url and a positional RPC_URL.

RPC resolution: CLI (-r or positional) → PUMP_CLONE_RPC → public cluster RPC.

A .env file in the current directory is loaded when present.

Examples:
  clone_devnet_accounts --network devnet
  clone_devnet_accounts -r https://api.devnet.solana.com
  clone_devnet_accounts https://api.mainnet-beta.solana.com --network mainnet
"
    );
}

fn parse_cli() -> Result<Cli, String> {
    let mut network = None;
    let mut rpc_flag = None;
    let mut positional = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print_usage();
                std::process::exit(0);
            }
            "-n" | "--network" => {
                let v = args
                    .next()
                    .ok_or_else(|| "--network requires a value (devnet or mainnet)".to_string())?;
                network = Some(Network::parse(&v)?);
            }
            "-r" | "--rpc-url" => {
                let v = args
                    .next()
                    .ok_or_else(|| "--rpc-url requires a URL".to_string())?;
                rpc_flag = Some(v);
            }
            s if s.starts_with('-') => {
                return Err(format!("unknown option `{s}` (try --help)"));
            }
            s => {
                if positional.is_some() {
                    return Err(format!("unexpected extra argument `{s}`"));
                }
                positional = Some(s.to_string());
            }
        }
    }

    if rpc_flag.is_some() && positional.is_some() {
        return Err("use either --rpc-url or one positional RPC URL, not both".into());
    }

    Ok(Cli {
        network,
        rpc_url: rpc_flag.or(positional),
    })
}

/// `(label, address, required, fetch_from_mainnet)`. Required entries panic
/// if absent on the chosen cluster; optional entries are skipped when not
/// initialized (e.g. signer-only PDAs or program-state that's lazily
/// created). When `fetch_from_mainnet` is `true` the entry is fetched from
/// mainnet regardless of `--network`; flip back to `false` to revert that
/// PDA to the selected-network fetch.
fn fixed_pdas(network: Network) -> Vec<(&'static str, Pubkey, bool, bool)> {
    vec![
        ("pump:global", pda::pump::global().0, true, false),
        (
            "pump:event_authority",
            pda::pump::event_authority().0,
            false,
            false,
        ),
        (
            "pump:mint_authority",
            pda::pump::mint_authority().0,
            false,
            false,
        ),
        (
            "pump:global_volume_accumulator",
            pda::pump::global_volume_accumulator().0,
            true,
            false,
        ),
        ("pump:fee_config", pda::pump::fee_config().0, true, false),
        (
            "pump_amm:global_config",
            pda::pump_amm::global_config().0,
            false,
            false,
        ),
        (
            "pump_amm:event_authority",
            pda::pump_amm::event_authority().0,
            false,
            false,
        ),
        (
            "pump_amm:global_volume_accumulator",
            pda::pump_amm::global_volume_accumulator().0,
            false,
            false,
        ),
        (
            "pump_amm:fee_config",
            pda::pump_amm::fee_config().0,
            true,
            false,
        ),
        (
            "pump_agent_payments:global_config",
            pda::pump_agent_payments::global_config().0,
            false,
            false,
        ),
        (
            "mayhem:global_params",
            pda::mayhem::global_params().0,
            true,
            false,
        ),
        ("mayhem:sol_vault", pda::mayhem::sol_vault().0, true, false),
        // ALT for the cluster — required so the test's full create_coin
        // versioned tx can compress shared accounts under the 1232-byte limit.
        (network.alt_label(), network.alt(), true, false),
    ]
}

fn print_account(label: &str, key: &Pubkey, acct: &Account) {
    println!(
        "  {:<40} {} lamports={} owner={} data={}B",
        label,
        key,
        acct.lamports,
        acct.owner,
        acct.data.len()
    );
}

/// Pull `key` and stash it under `label`. Required entries panic when
/// missing (the test depending on the fixture would fail more
/// confusingly downstream); optional entries log a skip line.
fn clone_one(
    rpc: &RpcClient,
    out: &mut HashMap<Pubkey, Account>,
    label: &str,
    key: Pubkey,
    required: bool,
) -> Result<Option<Account>, Box<dyn std::error::Error>> {
    if let Some(existing) = out.get(&key) {
        print_account(label, &key, existing);
        return Ok(Some(existing.clone()));
    }
    let acct = rpc
        .get_account_with_commitment(&key, rpc.commitment())?
        .value;
    match acct {
        Some(acct) => {
            print_account(label, &key, &acct);
            out.insert(key, acct.clone());
            Ok(Some(acct))
        }
        None if required => {
            panic!("required fixture account `{label}` missing on cluster at {key}")
        }
        None => {
            println!("  {:<40} {} (not on cluster — skipped)", label, key);
            Ok(None)
        }
    }
}

/// Snapshot every PDA the SDK touches for `fixture.mint`. For graduated
/// mints, also snapshots the post-migration `pump_amm` `Pool` and its
/// base/quote/lp/creator-vault accounts so AMM tests have a working pool
/// on the local validator without needing to run a migration.
///
/// Pool derivation matches canonical pump AMM `pool` PDA layout (see
/// `pump-swap-sdk` / `PumpSdk::buy_quote_amm_*` with live vault balances):
///   `pool_creator = pda::pump::pool_authority(mint)` and `index = 0` —
/// the pump migration always uses index 0 against the deterministic
/// pool-authority PDA.
fn clone_fixture_mint(
    rpc: &RpcClient,
    out: &mut HashMap<Pubkey, Account>,
    fixture: &FixtureMint,
) -> Result<(), Box<dyn std::error::Error>> {
    let mint = fixture.mint;
    println!("📥 Fixture {} ({}):", fixture.label, mint);

    // The mint account itself (Token-2022 program owner for v2 coins).
    clone_one(rpc, out, "  mint", mint, true)?;

    // Bonding curve always exists; everything else hangs off its `creator`.
    let bonding_curve_key = pda::pump::bonding_curve(&mint).0;
    let bc_account = clone_one(rpc, out, "  bonding_curve", bonding_curve_key, true)?
        .expect("bonding_curve required entry returned None");
    let bc = decode_bonding_curve(&bc_account.data)?;

    // Per-mint PDAs the program does NOT lazy-init.
    clone_one(
        rpc,
        out,
        "  creator_vault",
        pda::pump::creator_vault(&bc.creator).0,
        false,
    )?;
    clone_one(
        rpc,
        out,
        "  sharing_config",
        pda::pump::sharing_config(&mint).0,
        false,
    )?;
    clone_one(
        rpc,
        out,
        "  bonding_curve_v2",
        pda::pump::bonding_curve_v2(&mint).0,
        false,
    )?;
    // Bonding curve's base + quote ATAs (Token-2022 base, classic-SPL wSOL quote).
    clone_one(
        rpc,
        out,
        "  bonding_curve_base_ata",
        pda::associated_token(
            &bonding_curve_key,
            &constants::SPL_TOKEN_2022_PROGRAM_ID,
            &mint,
        )
        .0,
        false,
    )?;
    clone_one(
        rpc,
        out,
        "  bonding_curve_wsol_ata",
        pda::associated_token(
            &bonding_curve_key,
            &constants::SPL_TOKEN_PROGRAM_ID,
            &constants::NATIVE_MINT,
        )
        .0,
        false,
    )?;

    // Post-migration AMM pool, only when the curve has graduated. The
    // pool_authority + index=0 derivation matches what the program emits
    // on migration; if the snapshot pre-dates migration, the pool will
    // simply be missing and the AMM tests will be skipped at runtime.
    if bc.complete {
        let pool_creator = pda::pump::pool_authority(&mint).0;
        let pool_key = pda::pump_amm::pool(0, &pool_creator, &mint, &constants::NATIVE_MINT).0;
        let pool_account = clone_one(rpc, out, "  pool", pool_key, false)?;
        if let Some(pool_account) = pool_account {
            let pool = decode_pool(&pool_account.data)?;
            clone_one(rpc, out, "    lp_mint", pool.lp_mint, true)?;
            clone_one(
                rpc,
                out,
                "    pool_base_token_account",
                pool.pool_base_token_account,
                true,
            )?;
            clone_one(
                rpc,
                out,
                "    pool_quote_token_account",
                pool.pool_quote_token_account,
                true,
            )?;
            // Coin-creator vault authority + its quote ATA (where AMM
            // creator fees accrue). ATA may not exist yet if no fees have
            // ever been claimed against this pool.
            let cc_vault_authority =
                pda::pump_amm::coin_creator_vault_authority(&pool.coin_creator).0;
            clone_one(
                rpc,
                out,
                "    coin_creator_vault_authority",
                cc_vault_authority,
                false,
            )?;
            clone_one(
                rpc,
                out,
                "    coin_creator_vault_quote_ata",
                pda::associated_token(
                    &cc_vault_authority,
                    &constants::SPL_TOKEN_PROGRAM_ID,
                    &constants::NATIVE_MINT,
                )
                .0,
                false,
            )?;
        }
    }

    Ok(())
}

/// Whitelist [`fixtures::TEST_QUOTE_MINT`] inside the cloned `Global` so the
/// program's `is_quote_mint_supported` check accepts it during local-validator
/// `create_v2` / `buy_v2` / `sell_v2` flows. Idempotent: no-op if the mint is
/// already in the array. The re-serialized bytes must be the same length as
/// the original because `whitelisted_quote_mints` is fixed-size; the
/// `assert_eq!` is a tripwire if the IDL ever drifts.
fn whitelist_test_quote_mint_in_global(
    out: &mut HashMap<Pubkey, Account>,
    global: &Global,
) -> Result<(), Box<dyn std::error::Error>> {
    if global
        .whitelisted_quote_mints
        .contains(&fixtures::TEST_QUOTE_MINT)
    {
        println!(
            "🛠  Quote mint {} already whitelisted in Global — skipping",
            fixtures::TEST_QUOTE_MINT
        );
        return Ok(());
    }
    let mut patched = global.clone();
    patched.whitelisted_quote_mints[0] = fixtures::TEST_QUOTE_MINT;
    let mut new_data = Vec::new();
    patched.try_serialize(&mut new_data)?;
    let key = pda::pump::global().0;
    let entry = out
        .get_mut(&key)
        .expect("pump:global must be present in `out` before patching");
    assert_eq!(
        entry.data.len(),
        new_data.len(),
        "Global re-serialization changed data length ({} -> {}); IDL drift?",
        entry.data.len(),
        new_data.len()
    );
    entry.data = new_data;
    println!(
        "🛠  Whitelisted quote mint {} in Global",
        fixtures::TEST_QUOTE_MINT
    );
    Ok(())
}

/// Insert a synthetic legacy SPL Token mint at [`fixtures::TEST_QUOTE_MINT`]
/// owned by [`fixtures::TEST_QUOTE_MINT_AUTHORITY`] so tests can
/// `mint_to` arbitrary balances on the local validator. Always overwrites:
/// re-running the clone script regenerates a fresh mint with supply=0.
fn synthesize_test_quote_mint(out: &mut HashMap<Pubkey, Account>) {
    let mint = spl_token::state::Mint {
        mint_authority: solana_program::program_option::COption::Some(
            fixtures::TEST_QUOTE_MINT_AUTHORITY,
        ),
        supply: 0,
        decimals: 6,
        is_initialized: true,
        freeze_authority: solana_program::program_option::COption::None,
    };
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint::pack(mint, &mut data).expect("pack test quote Mint");
    let acct = Account {
        lamports: Rent::default().minimum_balance(spl_token::state::Mint::LEN),
        data,
        owner: spl_token::ID,
        executable: false,
        rent_epoch: 0,
    };
    out.insert(fixtures::TEST_QUOTE_MINT, acct);
    println!(
        "🛠  Synthesized test quote mint at {} (authority {})",
        fixtures::TEST_QUOTE_MINT,
        fixtures::TEST_QUOTE_MINT_AUTHORITY
    );
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();
    let cli =
        parse_cli().map_err(|msg| std::io::Error::new(std::io::ErrorKind::InvalidInput, msg))?;

    let network = cli.network.unwrap_or_else(Network::from_env);
    let rpc_url = cli
        .rpc_url
        .or_else(|| std::env::var("PUMP_CLONE_RPC").ok())
        .unwrap_or_else(|| network.default_rpc().to_string());
    let rpc = RpcClient::new(rpc_url.clone());
    println!("🌐 Cloning {network:?} from: {rpc_url}");

    // ---- Phase 1: fetch the fixed program-state PDAs. ----
    let labeled = fixed_pdas(network);

    // Some entries opt into fetching from mainnet regardless of `--network`
    // via the per-tuple `fetch_from_mainnet` flag. Build a separate mainnet
    // RPC client only when we have at least one such entry and the selected
    // cluster isn't already mainnet.
    let needs_mainnet = labeled.iter().any(|(_, _, _, from_mainnet)| *from_mainnet);
    let mainnet_rpc: Option<RpcClient> = if needs_mainnet && !matches!(network, Network::Mainnet) {
        let mainnet_url = std::env::var("PUMP_CLONE_MAINNET_RPC")
            .unwrap_or_else(|_| Network::Mainnet.default_rpc().to_string());
        println!("🌐 Mainnet override RPC: {mainnet_url}");
        Some(RpcClient::new(mainnet_url))
    } else {
        None
    };

    let default_keys: Vec<Pubkey> = labeled
        .iter()
        .filter(|(_, _, _, from_mainnet)| !*from_mainnet)
        .map(|(_, k, _, _)| *k)
        .collect();
    let mainnet_keys: Vec<Pubkey> = labeled
        .iter()
        .filter(|(_, _, _, from_mainnet)| *from_mainnet)
        .map(|(_, k, _, _)| *k)
        .collect();

    let mut by_key: HashMap<Pubkey, Option<Account>> = HashMap::new();
    if !default_keys.is_empty() {
        println!(
            "📡 Fetching {} key(s) from {network:?} ({rpc_url})",
            default_keys.len()
        );
        for (k, a) in default_keys
            .iter()
            .copied()
            .zip(rpc.get_multiple_accounts(&default_keys)?.into_iter())
        {
            by_key.insert(k, a);
        }
    }
    if !mainnet_keys.is_empty() {
        let client = mainnet_rpc.as_ref().unwrap_or(&rpc);
        println!(
            "📡 Fetching {} key(s) from mainnet override",
            mainnet_keys.len()
        );
        for (k, a) in mainnet_keys
            .iter()
            .copied()
            .zip(client.get_multiple_accounts(&mainnet_keys)?.into_iter())
        {
            by_key.insert(k, a);
        }
    }

    let mut out: HashMap<Pubkey, Account> = HashMap::new();
    let mut global_account: Option<Account> = None;
    println!("📥 Fixed PDAs:");
    for (label, key, required, from_mainnet) in labeled.iter() {
        let suffix = if *from_mainnet { " (mainnet)" } else { "" };
        match by_key.remove(key).flatten() {
            Some(acct) => {
                print_account(&format!("{label}{suffix}"), key, &acct);
                if *label == "pump:global" {
                    global_account = Some(acct.clone());
                }
                out.insert(*key, acct);
            }
            None if *required => {
                let source = if *from_mainnet {
                    "mainnet".to_string()
                } else {
                    format!("{network:?}")
                };
                panic!("required account `{label}` missing on {source} at {key}");
            }
            None => {
                println!(
                    "  {:<40} {} (not on cluster — skipped)",
                    format!("{label}{suffix}"),
                    key
                );
            }
        }
    }

    // ---- Phase 2: extract recipient pubkeys from the cloned Global, then
    //               patch the cloned Global to whitelist the test quote mint
    //               so custom-quote v2 flows are accepted by the program. ----
    let global = decode_global(&global_account.expect("pump:global must be set above").data)?;
    whitelist_test_quote_mint_in_global(&mut out, &global)?;
    let mut recipients: Vec<Pubkey> = Vec::new();
    recipients.push(global.fee_recipient);
    recipients.extend(global.fee_recipients.iter().copied());
    recipients.push(global.reserved_fee_recipient);
    recipients.extend(global.reserved_fee_recipients.iter().copied());
    recipients.extend(global.buyback_fee_recipients.iter().copied());
    recipients.retain(|p| *p != Pubkey::default());
    recipients.sort();
    recipients.dedup();
    println!(
        "🔎 Global yielded {} distinct fee/buyback recipient(s)",
        recipients.len()
    );

    // ---- Phase 3: fetch each recipient. Preserve owner/data when present
    //              (some recipients may be PDAs of pump_fees or similar);
    //              fabricate an empty system account otherwise. ----
    if !recipients.is_empty() {
        let recipient_accounts = rpc.get_multiple_accounts(&recipients)?;
        println!("📥 Recipients:");
        for (key, maybe_acct) in recipients.iter().zip(recipient_accounts.into_iter()) {
            let acct = maybe_acct.unwrap_or_else(|| Account {
                lamports: 0,
                data: vec![],
                owner: system_program::ID,
                executable: false,
                rent_epoch: 0,
            });
            print_account("recipient", key, &acct);
            // Skip if already present (e.g. recipient happens to equal a fixed PDA).
            out.entry(*key).or_insert(acct);
        }
    }

    // ---- Phase 4: per-mint fixtures. For each entry in `FIXTURE_MINTS`,
    //               clone the mint and every PDA the SDK touches that the
    //               program does NOT lazy-initialize on first use. ----
    for fixture in FIXTURE_MINTS {
        clone_fixture_mint(&rpc, &mut out, fixture)?;
    }

    // ---- Phase 4b: seed the synthetic test quote mint so tests can mint it. ----
    synthesize_test_quote_mint(&mut out);

    // ---- Phase 5: serialize + zstd-compress, write to artifacts/. ----
    let bytes = bincode::serialize(&out)?;
    let compressed = zstd::stream::encode_all(&bytes[..], 3)?;
    if let Some(parent) = std::path::Path::new(OUT_PATH).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(OUT_PATH, &compressed)?;
    println!(
        "✅ Wrote {} accounts to {} ({} bytes raw, {} bytes zstd)",
        out.len(),
        OUT_PATH,
        bytes.len(),
        compressed.len()
    );
    Ok(())
}
