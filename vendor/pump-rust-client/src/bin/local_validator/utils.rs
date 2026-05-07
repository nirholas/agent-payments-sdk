#![allow(dead_code)]

use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;

use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::spl_token;
use crossbeam_channel::unbounded;
use solana_faucet::faucet::run_local_faucet_with_port;
use solana_sdk::account::Account;
use solana_sdk::program_pack::Pack;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{read_keypair_file, write_keypair_file, Keypair};
use solana_sdk::signer::Signer;
use solana_sdk::system_program;
use spl_token::state::Account as SplAccount;
use spl_token_2022::extension::{
    BaseStateWithExtensions, BaseStateWithExtensionsMut, ExtensionType, PodStateWithExtensions,
    PodStateWithExtensionsMut,
};
use spl_token_2022::pod::{PodAccount, PodCOption, PodMint};

use pump_rust_client::constants::{NATIVE_MINT, SPL_TOKEN_2022_PROGRAM_ID};

#[derive(Debug, Clone)]
pub struct AccountConfigInfo {
    pub address: Pubkey,
    pub data: Vec<u8>,
    pub owner: Pubkey,
}

impl AccountConfigInfo {
    pub fn system(address: Pubkey) -> Self {
        Self {
            address,
            data: vec![],
            owner: system_program::ID,
        }
    }

    pub fn from_account(address: Pubkey, account: &Account) -> Self {
        Self {
            address,
            data: account.data.clone(),
            owner: account.owner,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProgramsToAdd {
    /// Filename of the `.so` artifact (relative to the programs directory).
    pub name: String,
    pub program_id: Pubkey,
}

pub fn remove_directory_contents(ledger_path: &str) {
    let dir = match fs::read_dir(ledger_path) {
        Ok(d) => d,
        Err(_) => return,
    };
    for entry in dir.flatten() {
        let path = entry.path();
        if entry.metadata().map(|m| m.is_dir()).unwrap_or(false) {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
}

pub fn start_faucet(faucet_addr: SocketAddr, ledger_path: &str) -> Pubkey {
    let ledger: PathBuf = ledger_path.into();
    fs::create_dir_all(&ledger).expect("create ledger dir");
    let faucet_keypair_file = ledger.join("faucet-keypair.json");
    if !faucet_keypair_file.exists() {
        write_keypair_file(&Keypair::new(), faucet_keypair_file.to_str().unwrap())
            .unwrap_or_else(|err| panic!("write {}: {}", faucet_keypair_file.display(), err));
    }
    let faucet_keypair = read_keypair_file(faucet_keypair_file.to_str().unwrap())
        .unwrap_or_else(|err| panic!("read {}: {}", faucet_keypair_file.display(), err));
    let faucet_pubkey = faucet_keypair.pubkey();

    let (sender, receiver) = unbounded();
    run_local_faucet_with_port(faucet_keypair, sender, None, None, None, faucet_addr.port());
    receiver
        .recv()
        .expect("run faucet")
        .unwrap_or_else(|err| panic!("start faucet: {err}"));

    faucet_pubkey
}

const DEFAULT_TOKEN_AMOUNT: u64 = 100_000_000_000;

/// Seeds an ATA for every (wallet, mint) pair, supporting both spl-token and
/// spl-token-2022 mints. The mint must already be present in `accounts` so we
/// can determine its program owner and (for token-2022) any required account
/// extensions.
pub fn create_wallet_associated_token_account(
    accounts_to_load: &mut Vec<(AccountConfigInfo, Option<u64>)>,
    mints: &[Pubkey],
    wallets: &[Pubkey],
) {
    for wallet in wallets {
        for mint in mints {
            let Some((mint_account_info, _)) = accounts_to_load
                .iter()
                .find(|(a, _)| a.address == *mint)
                .cloned()
            else {
                continue;
            };

            let ata = get_associated_token_address_with_program_id(
                wallet,
                mint,
                &mint_account_info.owner,
            );

            let (data, owner) = if mint_account_info.owner == SPL_TOKEN_2022_PROGRAM_ID {
                build_token_2022_ata(&mint_account_info, *mint, *wallet)
            } else {
                build_spl_token_ata(*mint, *wallet)
            };

            accounts_to_load.push((
                AccountConfigInfo {
                    address: ata,
                    data,
                    owner,
                },
                None,
            ));
        }
    }
}

fn build_spl_token_ata(mint: Pubkey, wallet: Pubkey) -> (Vec<u8>, Pubkey) {
    let acct = SplAccount {
        amount: DEFAULT_TOKEN_AMOUNT,
        mint,
        owner: wallet,
        state: spl_token::state::AccountState::Initialized,
        is_native: if mint == NATIVE_MINT {
            solana_sdk::program_option::COption::Some(
                solana_sdk::rent::Rent::default().minimum_balance(SplAccount::LEN),
            )
        } else {
            solana_sdk::program_option::COption::None
        },
        ..Default::default()
    };
    let mut data = vec![0u8; SplAccount::LEN];
    SplAccount::pack(acct, &mut data).expect("pack spl-token account");
    (data, spl_token::ID)
}

fn build_token_2022_ata(
    mint_account: &AccountConfigInfo,
    mint: Pubkey,
    wallet: Pubkey,
) -> (Vec<u8>, Pubkey) {
    let state = PodStateWithExtensions::<PodMint>::unpack(&mint_account.data)
        .expect("unpack token-2022 mint");
    let mint_extensions = state
        .get_extension_types()
        .expect("token-2022 mint extensions");
    let mut account_extensions =
        ExtensionType::get_required_init_account_extensions(&mint_extensions);
    account_extensions.push(ExtensionType::ImmutableOwner);

    let account_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
        &account_extensions,
    )
    .expect("calc token-2022 account len");

    let mut data = vec![0u8; account_size];
    {
        let mut account_state =
            PodStateWithExtensionsMut::<PodAccount>::unpack_uninitialized(&mut data)
                .expect("unpack uninit token-2022 account");
        account_state.base.amount = DEFAULT_TOKEN_AMOUNT.into();
        account_state.base.mint = mint;
        account_state.base.owner = wallet;
        account_state.base.state = spl_token_2022::state::AccountState::Initialized.into();
        account_state.base.is_native = if mint == NATIVE_MINT {
            PodCOption::some(
                solana_sdk::rent::Rent::default()
                    .minimum_balance(SplAccount::LEN)
                    .into(),
            )
        } else {
            PodCOption::none()
        };
        account_state.base.close_authority = PodCOption::none();
        account_state.base.delegate = PodCOption::none();
        account_state.base.delegated_amount = 0u64.into();

        for ext in account_extensions {
            account_state
                .init_account_extension_from_type(ext)
                .expect("init token-2022 account extension");
        }
        account_state
            .init_account_type()
            .expect("init token-2022 account type");
    }
    (data, SPL_TOKEN_2022_PROGRAM_ID)
}
