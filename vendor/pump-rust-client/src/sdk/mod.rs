use solana_program::pubkey::Pubkey;

use crate::math::amm::{
    self as amm_math, AmmContext, BuyBaseInputResult, BuyQuoteInputResult, SellBaseInputResult,
};
use crate::math::bonding_curve as bc_math;
use crate::math::utils::{add_slippage, sub_slippage};
pub use crate::math::QuoteError;
use crate::math::QuoteResult;
use crate::pda;
use crate::state::pump_amm::{GlobalConfig, Pool};
use crate::state::{BondingCurve, FeeConfig, Global};

mod pump_amm_ix;
mod pump_legacy;
mod pump_v2;
mod trade_tx;

/// Quote output: `amount` is tokens-out or lamports-out; `min_out` / `max_input` carry slippage where relevant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    pub amount: u64,
    pub min_out: u64,
    pub input_amount_used: u64,
    pub max_input: u64,
}

/// Force bonding-curve vs AMM routing for [`PumpSdk::trade_tx_instructions_with_venue`].
#[derive(Clone, Copy, Debug)]
pub enum TradeVenue<'a> {
    BondingCurve {
        global: &'a Global,
        bonding_curve: &'a BondingCurve,
    },
    Amm {
        pool: Pubkey,
        amm_global: &'a GlobalConfig,
        pool_state: &'a Pool,
    },
}

/// AMM quote inputs: live pool reserves, or estimated reserves from a completed curve (not on-chain AMM state).
#[derive(Clone, Copy, Debug)]
pub enum AmmQuoteSource<'a> {
    Pool {
        pool: &'a Pool,
        base_reserve: u64,
        quote_reserve: u64,
        base_mint_supply: u64,
    },
    BondingCurveComplete {
        global: &'a Global,
        bonding_curve: &'a BondingCurve,
        base_mint: &'a Pubkey,
        base_mint_supply: u64,
    },
}

/// [`PumpSdk::trade_tx_instructions_with_venue`] parameters. wSOL uses wrap/unwrap;
/// amounts come from the `*_quote_*` helpers.
#[derive(Clone, Copy, Debug)]
pub struct TradeTxWithVenueParams<'a> {
    pub mint: Pubkey,
    pub base_token_program: Pubkey,
    pub quote_token_program: Pubkey,
    pub user: Pubkey,
    pub is_buy: bool,
    pub venue: TradeVenue<'a>,
    pub base_amount: u64,
    pub sol_amount_threshold: u64,
}

/// `pump_amm` pool after migration (`BondingCurve::complete`).
#[derive(Clone, Copy, Debug)]
pub struct PumpPoolCtx<'a> {
    pub pool: Pubkey,
    pub amm_global: &'a GlobalConfig,
    pub pool_state: &'a Pool,
}

/// [`PumpSdk::trade_tx_instructions`] parameters: routes from [`BondingCurve::complete`].
/// `pump_pool` is required when the curve is complete.
#[derive(Clone, Copy, Debug)]
pub struct TradeTxParams<'a> {
    pub mint: Pubkey,
    pub base_token_program: Pubkey,
    pub quote_token_program: Pubkey,
    pub user: Pubkey,
    pub is_buy: bool,
    pub base_amount: u64,
    pub sol_amount_threshold: u64,
    pub pump_global: &'a Global,
    pub bonding_curve: &'a BondingCurve,
    pub pump_pool: Option<PumpPoolCtx<'a>>,
}

/// `pump_amm` pool quote inputs — like [`PumpPoolCtx`] but with the reserves and
/// fee config the AMM math needs.
#[derive(Clone, Copy, Debug)]
pub struct PumpPoolQuoteCtx<'a> {
    pub amm_global: &'a GlobalConfig,
    pub amm_fee_config: Option<&'a FeeConfig>,
    pub pool_state: &'a Pool,
    pub base_reserve: u64,
    pub quote_reserve: u64,
}

/// [`PumpSdk::quote_trade`] parameters: routes from [`BondingCurve::complete`], mirroring
/// [`TradeTxParams`]. `pump_pool` is required when the curve is complete.
#[derive(Clone, Copy, Debug)]
pub struct TradeQuoteParams<'a> {
    pub is_buy: bool,
    pub base_amount: u64,
    pub slippage_bps: u16,
    pub base_mint_supply: u64,
    pub pump_global: &'a Global,
    pub pump_fee_config: Option<&'a FeeConfig>,
    pub bonding_curve: &'a BondingCurve,
    pub pump_pool: Option<PumpPoolQuoteCtx<'a>>,
}

/// [`PumpSdk::create_coin_instructions`]. New mint keypair must co-sign. The
/// initial buy is in the chosen `quote_mint` (`Pubkey::default()` → wSOL).
///
/// `tokenized_agent_buyback_bps`: when `Some(bps)`, an `agent_initialize`
/// instruction (pump_agent_payments) is appended that registers `creator` as
/// the agent payment authority with the given buyback rate (basis points;
/// must be ≤ 10000). `None` skips it.
#[derive(Clone, Debug)]
pub struct CreateCoinParams<'a> {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub mayhem_mode: bool,
    pub cashback: bool,
    pub quote_mint: Pubkey,
    pub global: &'a Global,
    pub token_amount: u64,
    pub max_quote_tokens: u64,
    pub tokenized_agent_buyback_bps: Option<u16>,
}

/// Instruction builders (no RPC).
#[derive(Clone, Copy, Debug, Default)]
pub struct PumpSdk;

impl PumpSdk {
    pub const fn new() -> Self {
        Self
    }

    /// Random protocol fee recipient from `Global` (deduped).
    pub fn fee_recipient_from_pump_global(global: &Global, is_mayhem: bool) -> Option<Pubkey> {
        let mut candidates = Vec::new();
        let (primary, pool) = if is_mayhem {
            (
                global.reserved_fee_recipient,
                global.reserved_fee_recipients.as_slice(),
            )
        } else {
            (global.fee_recipient, global.fee_recipients.as_slice())
        };
        if primary != Pubkey::default() {
            candidates.push(primary);
        }
        candidates.extend(pool.iter().copied().filter(|p| *p != Pubkey::default()));
        Self::dedupe_sorted(&mut candidates);
        Self::pick_random_pubkey(&candidates)
    }

    /// Random buyback fee recipient from `Global`.
    pub fn buyback_fee_recipient_from_pump_global(global: &Global) -> Option<Pubkey> {
        let mut candidates: Vec<Pubkey> = global
            .buyback_fee_recipients
            .iter()
            .copied()
            .filter(|p| *p != Pubkey::default())
            .collect();
        Self::dedupe_sorted(&mut candidates);
        Self::pick_random_pubkey(&candidates)
    }

    /// Random protocol fee recipient from AMM `GlobalConfig`.
    pub fn protocol_fee_recipient_from_amm_global(global_config: &GlobalConfig) -> Option<Pubkey> {
        let mut candidates: Vec<Pubkey> = global_config
            .protocol_fee_recipients
            .iter()
            .copied()
            .filter(|p| *p != Pubkey::default())
            .collect();
        Self::dedupe_sorted(&mut candidates);
        Self::pick_random_pubkey(&candidates)
    }

    /// Random buyback fee recipient from AMM `GlobalConfig`.
    pub fn buyback_fee_recipient_from_amm_global(global_config: &GlobalConfig) -> Option<Pubkey> {
        let mut candidates: Vec<Pubkey> = global_config
            .buyback_fee_recipients
            .iter()
            .copied()
            .filter(|p| *p != Pubkey::default())
            .collect();
        Self::dedupe_sorted(&mut candidates);
        Self::pick_random_pubkey(&candidates)
    }

    /// `(fee_recipient, buyback_fee_recipient)` from `Global`. `None` when either pool is empty.
    pub fn pump_fee_recipients_pair(global: &Global, is_mayhem: bool) -> Option<(Pubkey, Pubkey)> {
        Some((
            Self::fee_recipient_from_pump_global(global, is_mayhem)?,
            Self::buyback_fee_recipient_from_pump_global(global)?,
        ))
    }

    /// `(protocol_fee_recipient, buyback_fee_recipient)` from AMM `GlobalConfig`. `None` when either pool is empty.
    pub fn amm_fee_recipients_pair(global_config: &GlobalConfig) -> Option<(Pubkey, Pubkey)> {
        Some((
            Self::protocol_fee_recipient_from_amm_global(global_config)?,
            Self::buyback_fee_recipient_from_amm_global(global_config)?,
        ))
    }

    fn dedupe_sorted(keys: &mut Vec<Pubkey>) {
        keys.sort();
        keys.dedup();
    }

    fn pick_random_pubkey(candidates: &[Pubkey]) -> Option<Pubkey> {
        if candidates.is_empty() {
            return None;
        }
        Some(candidates[fastrand::usize(..candidates.len())])
    }

    fn map_amm_quote_source<R>(
        global_config: &GlobalConfig,
        fee_config: Option<&FeeConfig>,
        source: AmmQuoteSource<'_>,
        with: impl FnOnce(AmmContext<'_>) -> QuoteResult<R>,
    ) -> QuoteResult<R> {
        match source {
            AmmQuoteSource::Pool {
                pool,
                base_reserve,
                quote_reserve,
                base_mint_supply,
            } => {
                let ctx = AmmContext {
                    global_config,
                    fee_config,
                    base_mint: &pool.base_mint,
                    pool_creator: &pool.creator,
                    coin_creator: &pool.coin_creator,
                    base_reserve,
                    quote_reserve,
                    base_mint_supply,
                };
                with(ctx)
            }
            AmmQuoteSource::BondingCurveComplete {
                global,
                bonding_curve,
                base_mint,
                base_mint_supply,
            } => {
                let (base_reserve, quote_reserve) = estimated_reserves(global, bonding_curve)?;
                let pool_creator_pk = pda::pump::pool_authority(base_mint).0;
                let ctx = AmmContext {
                    global_config,
                    fee_config,
                    base_mint,
                    pool_creator: &pool_creator_pk,
                    coin_creator: &bonding_curve.creator,
                    base_reserve,
                    quote_reserve,
                    base_mint_supply,
                };
                with(ctx)
            }
        }
    }

    /// Bonding curve buy: SOL in → tokens out.
    pub fn buy_quote_bonding_curve_sol_in(
        &self,
        global: &Global,
        fee_config: Option<&FeeConfig>,
        bonding_curve: &BondingCurve,
        mint_supply: u64,
        sol_amount: u64,
        slippage_bps: u16,
    ) -> QuoteResult<Quote> {
        let tokens_out = bc_math::buy_token_amount_from_sol_amount(
            global,
            fee_config,
            bonding_curve,
            mint_supply,
            sol_amount,
        )?;
        Ok(Quote {
            amount: tokens_out,
            min_out: sub_slippage(tokens_out, slippage_bps),
            input_amount_used: sol_amount,
            max_input: sol_amount,
        })
    }

    /// Bonding curve buy: fixed token out → SOL cost.
    pub fn buy_quote_bonding_curve_token_out(
        &self,
        global: &Global,
        fee_config: Option<&FeeConfig>,
        bonding_curve: &BondingCurve,
        mint_supply: u64,
        token_amount: u64,
        slippage_bps: u16,
    ) -> QuoteResult<Quote> {
        let sol_cost = bc_math::buy_sol_amount_from_token_amount(
            global,
            fee_config,
            bonding_curve,
            mint_supply,
            token_amount,
        )?;
        Ok(Quote {
            amount: sol_cost,
            min_out: token_amount,
            input_amount_used: token_amount,
            max_input: add_slippage(sol_cost, slippage_bps),
        })
    }

    /// Bonding curve sell.
    pub fn sell_quote_bonding_curve(
        &self,
        global: &Global,
        fee_config: Option<&FeeConfig>,
        bonding_curve: &BondingCurve,
        mint_supply: u64,
        token_amount: u64,
        slippage_bps: u16,
    ) -> QuoteResult<Quote> {
        let sol_out = bc_math::sell_sol_amount_from_token_amount(
            global,
            fee_config,
            bonding_curve,
            mint_supply,
            token_amount,
        )?;
        Ok(Quote {
            amount: sol_out,
            min_out: sub_slippage(sol_out, slippage_bps),
            input_amount_used: token_amount,
            max_input: token_amount,
        })
    }

    /// AMM buy: quote in.
    pub fn buy_quote_amm_sol_in(
        &self,
        global_config: &GlobalConfig,
        fee_config: Option<&FeeConfig>,
        source: AmmQuoteSource<'_>,
        sol_amount: u64,
        slippage_bps: u16,
    ) -> QuoteResult<Quote> {
        Self::map_amm_quote_source(global_config, fee_config, source, |ctx| {
            let BuyQuoteInputResult {
                base_amount_out, ..
            } = amm_math::buy_quote_input(&ctx, sol_amount)?;
            Ok(Quote {
                amount: base_amount_out,
                min_out: sub_slippage(base_amount_out, slippage_bps),
                input_amount_used: sol_amount,
                max_input: add_slippage(sol_amount, slippage_bps),
            })
        })
    }

    /// AMM buy: token amount out.
    pub fn buy_quote_amm_token_out(
        &self,
        global_config: &GlobalConfig,
        fee_config: Option<&FeeConfig>,
        source: AmmQuoteSource<'_>,
        token_amount: u64,
        slippage_bps: u16,
    ) -> QuoteResult<Quote> {
        Self::map_amm_quote_source(global_config, fee_config, source, |ctx| {
            let BuyBaseInputResult { total_quote_in, .. } =
                amm_math::buy_base_input(&ctx, token_amount)?;
            Ok(Quote {
                amount: total_quote_in,
                min_out: token_amount,
                input_amount_used: token_amount,
                max_input: add_slippage(total_quote_in, slippage_bps),
            })
        })
    }

    /// AMM sell.
    pub fn sell_quote_amm(
        &self,
        global_config: &GlobalConfig,
        fee_config: Option<&FeeConfig>,
        source: AmmQuoteSource<'_>,
        token_amount: u64,
        slippage_bps: u16,
    ) -> QuoteResult<Quote> {
        Self::map_amm_quote_source(global_config, fee_config, source, |ctx| {
            let SellBaseInputResult {
                final_quote_out, ..
            } = amm_math::sell_base_input(&ctx, token_amount)?;
            Ok(Quote {
                amount: final_quote_out,
                min_out: sub_slippage(final_quote_out, slippage_bps),
                input_amount_used: token_amount,
                max_input: token_amount,
            })
        })
    }
}

/// Heuristic AMM reserves from a completed curve (not live pool state).
fn estimated_reserves(global: &Global, bonding_curve: &BondingCurve) -> QuoteResult<(u64, u64)> {
    let base_reserve = global
        .token_total_supply
        .checked_sub(global.initial_real_token_reserves)
        .ok_or(QuoteError::EmptyReserves)?;
    let quote_reserve = bonding_curve
        .real_quote_reserves
        .checked_sub(global.pool_migration_fee)
        .ok_or(QuoteError::EmptyReserves)?;
    if base_reserve == 0 || quote_reserve == 0 {
        return Err(QuoteError::EmptyReserves);
    }
    Ok((base_reserve, quote_reserve))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::Discriminator;
    use solana_program::{pubkey, pubkey::Pubkey, system_program};

    use crate::constants;
    use crate::math::amm::AmmContext;
    use crate::pda;
    use crate::pump::client;
    use crate::pump_agent_payments::client as agent_client;
    use crate::pump_amm::client as amm_client;
    use crate::state::pump_amm::{GlobalConfig, GlobalConfigFromIdl, Pool, PoolFromIdl};
    use crate::state::{BondingCurve, BondingCurveFromIdl, Global, GlobalFromIdl};

    fn fake_pubkey(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    fn pump_global_with_fees(fee_recipient: Pubkey, buyback_fee_recipient: Pubkey) -> Global {
        let mut g = Global::default();
        g.fee_recipient = fee_recipient;
        g.buyback_fee_recipients[0] = buyback_fee_recipient;
        g
    }

    fn amm_global_with_fees(protocol: Pubkey, buyback: Pubkey) -> GlobalConfig {
        let mut g = GlobalConfig::default();
        g.protocol_fee_recipients[0] = protocol;
        g.buyback_fee_recipients[0] = buyback;
        g
    }

    #[test]
    #[allow(deprecated)]
    fn create_instruction_wires_metadata_pdas() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(51);
        let user = fake_pubkey(52);
        let creator = fake_pubkey(53);

        let ix = sdk.create_instruction(
            mint,
            user,
            "Test",
            "TST",
            "https://example.com/metadata.json",
            creator,
        );

        assert_eq!(ix.program_id, crate::pump::ID);
        assert_eq!(
            &ix.data[..8],
            <client::args::Create as Discriminator>::DISCRIMINATOR,
        );
        let metas: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
        assert!(metas.contains(&pda::pump::metadata(&mint).0));
        assert!(metas.contains(&constants::MPL_TOKEN_METADATA_PROGRAM_ID));
        assert!(metas.contains(&constants::SPL_TOKEN_PROGRAM_ID));
        assert!(metas.contains(&pda::pump::bonding_curve(&mint).0));
        assert!(metas.contains(&solana_program::sysvar::rent::ID));
    }

    #[test]
    fn create_v2_instruction_wires_mayhem_pdas() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(21);
        let user = fake_pubkey(22);
        let creator = fake_pubkey(23);

        let ix = sdk.create_v2_instruction(
            mint,
            user,
            "Test",
            "TST",
            "https://example.com/metadata.json",
            creator,
            Pubkey::default(),
            false,
            false,
        );

        assert_eq!(ix.program_id, crate::pump::ID);
        assert_eq!(
            &ix.data[..8],
            <client::args::CreateV2 as Discriminator>::DISCRIMINATOR,
        );
        let metas: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
        assert!(metas.contains(&pda::mayhem::global_params().0));
        assert!(metas.contains(&pda::mayhem::sol_vault().0));
        assert!(metas.contains(&pda::mayhem::mayhem_state(&mint).0));
        assert!(metas.contains(&pda::mayhem::mayhem_token_vault(&mint).0));
        assert!(metas.contains(&constants::MAYHEM_PROGRAM_ID));
        assert!(metas.contains(&constants::SPL_TOKEN_2022_PROGRAM_ID));
    }

    #[test]
    fn create_v2_instruction_appends_remaining_accounts_for_non_sol_quote() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(0xA1);
        let user = fake_pubkey(0xA2);
        let creator = fake_pubkey(0xA3);
        let quote_mint = fake_pubkey(0xC1);

        let baseline = sdk.create_v2_instruction(
            mint,
            user,
            "Test",
            "TST",
            "https://example.com/metadata.json",
            creator,
            Pubkey::default(),
            false,
            false,
        );
        let ix = sdk.create_v2_instruction(
            mint,
            user,
            "Test",
            "TST",
            "https://example.com/metadata.json",
            creator,
            quote_mint,
            false,
            false,
        );

        assert_eq!(ix.accounts.len(), baseline.accounts.len() + 3);

        let n = ix.accounts.len();
        let quote_meta = &ix.accounts[n - 3];
        let ata_meta = &ix.accounts[n - 2];
        let token_program_meta = &ix.accounts[n - 1];

        assert_eq!(quote_meta.pubkey, quote_mint);
        assert!(!quote_meta.is_writable);
        assert!(!quote_meta.is_signer);

        let bonding_curve = pda::pump::bonding_curve(&mint).0;
        let expected_ata = pda::associated_token(
            &bonding_curve,
            &constants::SPL_TOKEN_PROGRAM_ID,
            &quote_mint,
        )
        .0;
        assert_eq!(ata_meta.pubkey, expected_ata);
        assert!(ata_meta.is_writable);
        assert!(!ata_meta.is_signer);

        assert_eq!(token_program_meta.pubkey, constants::SPL_TOKEN_PROGRAM_ID);
        assert!(!token_program_meta.is_writable);
        assert!(!token_program_meta.is_signer);
    }

    #[test]
    fn create_v2_instruction_omits_remaining_accounts_for_sol_quote() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(0xB1);
        let user = fake_pubkey(0xB2);
        let creator = fake_pubkey(0xB3);

        let with_default = sdk.create_v2_instruction(
            mint,
            user,
            "Test",
            "TST",
            "https://example.com/metadata.json",
            creator,
            Pubkey::default(),
            false,
            false,
        );
        let with_native = sdk.create_v2_instruction(
            mint,
            user,
            "Test",
            "TST",
            "https://example.com/metadata.json",
            creator,
            constants::NATIVE_MINT,
            false,
            false,
        );

        assert_eq!(with_default.accounts.len(), with_native.accounts.len());
        for (a, b) in with_default
            .accounts
            .iter()
            .zip(with_native.accounts.iter())
        {
            assert_eq!(a.pubkey, b.pubkey);
            assert_eq!(a.is_writable, b.is_writable);
            assert_eq!(a.is_signer, b.is_signer);
        }
        assert!(!with_default
            .accounts
            .iter()
            .any(|m| m.pubkey == constants::SPL_TOKEN_PROGRAM_ID));
    }

    #[test]
    #[allow(deprecated)]
    fn buy_instruction_appends_bonding_curve_v2_then_buyback_fee_recipient() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(61);
        let user = fake_pubkey(62);
        let creator = fake_pubkey(63);
        let fee_recipient = fake_pubkey(64);
        let buyback_fee_recipient = fake_pubkey(65);
        let token_program = constants::SPL_TOKEN_PROGRAM_ID;

        let ix = sdk.buy_instruction(
            mint,
            user,
            creator,
            fee_recipient,
            buyback_fee_recipient,
            100,
            5_000_000,
            token_program,
        );

        assert_eq!(ix.program_id, crate::pump::ID);
        assert_eq!(
            &ix.data[..8],
            <client::args::Buy as Discriminator>::DISCRIMINATOR,
        );

        let metas: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
        assert!(metas.contains(&pda::pump::global().0));
        assert!(metas.contains(&pda::pump::bonding_curve(&mint).0));
        assert!(metas.contains(&pda::pump::creator_vault(&creator).0));
        assert!(metas.contains(&pda::pump::user_volume_accumulator(&user).0));
        assert!(metas.contains(&pda::pump::fee_config().0));
        assert!(metas.contains(&constants::FEE_PROGRAM_ID));
        assert!(metas.contains(&fee_recipient));

        let n = ix.accounts.len();
        let bcv2 = &ix.accounts[n - 2];
        let buyback = &ix.accounts[n - 1];
        assert_eq!(bcv2.pubkey, pda::pump::bonding_curve_v2(&mint).0);
        assert!(!bcv2.is_writable);
        assert!(!bcv2.is_signer);
        assert_eq!(buyback.pubkey, buyback_fee_recipient);
        assert!(buyback.is_writable);
        assert!(!buyback.is_signer);
    }

    #[test]
    fn create_v2_and_buy_instruction_returns_create_then_buy_v2_prefix_in_order() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(71);
        let user = fake_pubkey(72);
        let creator = fake_pubkey(73);
        let fee_recipient = fake_pubkey(74);
        let buyback_fee_recipient = fake_pubkey(75);
        let global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);

        let ixs = sdk
            .create_v2_and_buy_instruction(
                mint,
                user,
                "Test",
                "TST",
                "https://example.com/metadata.json",
                creator,
                Pubkey::default(),
                false,
                false,
                None,
                &global,
                1_000,
                500_000,
            )
            .expect("create_v2_and_buy_instruction");

        assert_eq!(ixs.len(), 6);
        assert_eq!(
            &ixs[0].data[..8],
            <client::args::CreateV2 as Discriminator>::DISCRIMINATOR,
        );
        for i in 1..5 {
            assert_eq!(ixs[i].data, vec![1], "expected SPL ATA idempotent ix");
        }
        assert_eq!(
            &ixs[5].data[..8],
            <client::args::BuyV2 as Discriminator>::DISCRIMINATOR,
        );

        let buy_metas: Vec<Pubkey> = ixs[5].accounts.iter().map(|m| m.pubkey).collect();
        assert!(buy_metas.contains(&constants::SPL_TOKEN_2022_PROGRAM_ID));
        assert!(buy_metas.contains(&constants::SPL_TOKEN_PROGRAM_ID));
        assert!(buy_metas.contains(&constants::NATIVE_MINT));
        assert!(buy_metas.contains(&pda::pump::sharing_config(&mint).0));
    }

    #[test]
    fn buy_v2_instruction_wires_quote_and_sharing_config_pdas() {
        let sdk = PumpSdk::new();
        let base_mint = fake_pubkey(81);
        let quote_mint = fake_pubkey(82);
        let user = fake_pubkey(83);
        let creator = fake_pubkey(84);
        let fee_recipient = fake_pubkey(85);
        let buyback_fee_recipient = fake_pubkey(86);
        let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
        let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
        let global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);
        let bonding_curve = BondingCurve::new(BondingCurveFromIdl {
            creator,
            quote_mint,
            ..Default::default()
        });

        let ix = sdk
            .buy_v2_instruction(
                &global,
                &bonding_curve,
                base_mint,
                quote_token_program,
                user,
                1_000,
                5_000_000,
            )
            .expect("buy_v2_instruction");

        assert_eq!(ix.program_id, crate::pump::ID);
        assert_eq!(
            &ix.data[..8],
            <client::args::BuyV2 as Discriminator>::DISCRIMINATOR,
        );

        let metas: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
        assert!(metas.contains(&pda::pump::global().0));
        assert!(metas.contains(&base_mint));
        assert!(metas.contains(&quote_mint));
        assert!(metas.contains(&fee_recipient));
        assert!(metas.contains(&buyback_fee_recipient));
        assert!(metas.contains(&pda::pump::bonding_curve(&base_mint).0));
        assert!(metas.contains(&pda::pump::creator_vault(&creator).0));
        assert!(metas.contains(&pda::pump::sharing_config(&base_mint).0));
        assert!(metas.contains(&pda::pump::user_volume_accumulator(&user).0));
        assert!(metas.contains(&pda::pump::fee_config().0));
        assert!(metas.contains(&constants::FEE_PROGRAM_ID));

        assert!(metas
            .contains(&pda::associated_token(&fee_recipient, &quote_token_program, &quote_mint).0));
        assert!(metas.contains(
            &pda::associated_token(&buyback_fee_recipient, &quote_token_program, &quote_mint).0
        ));

        let signers: Vec<Pubkey> = ix
            .accounts
            .iter()
            .filter(|m| m.is_signer)
            .map(|m| m.pubkey)
            .collect();
        assert_eq!(signers, vec![user]);
    }

    #[test]
    fn buy_v2_instructions_prepends_four_ata_creates() {
        let sdk = PumpSdk::new();
        let base_mint = fake_pubkey(91);
        let quote_mint = fake_pubkey(92);
        let user = fake_pubkey(93);
        let creator = fake_pubkey(94);
        let fee_recipient = fake_pubkey(95);
        let buyback_fee_recipient = fake_pubkey(96);
        let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
        let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
        let global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);
        let bonding_curve = BondingCurve::new(BondingCurveFromIdl {
            creator,
            quote_mint,
            ..Default::default()
        });

        let ixs = sdk
            .buy_v2_instructions(
                &global,
                &bonding_curve,
                base_mint,
                quote_token_program,
                user,
                1_000,
                5_000_000,
            )
            .expect("buy_v2_instructions");

        assert_eq!(ixs.len(), 5);
        for ata_ix in &ixs[..4] {
            assert_eq!(ata_ix.program_id, constants::SPL_ATA_PROGRAM_ID);
            assert_eq!(ata_ix.data, vec![1]);
        }
        assert_eq!(
            &ixs[4].data[..8],
            <client::args::BuyV2 as Discriminator>::DISCRIMINATOR,
        );

        let bonding_curve = pda::pump::bonding_curve(&base_mint).0;
        let expected_atas: [Pubkey; 4] = [
            pda::associated_token(&user, &base_token_program, &base_mint).0,
            pda::associated_token(&bonding_curve, &quote_token_program, &quote_mint).0,
            pda::associated_token(&user, &quote_token_program, &quote_mint).0,
            pda::associated_token(&buyback_fee_recipient, &quote_token_program, &quote_mint).0,
        ];
        for (i, expected) in expected_atas.iter().enumerate() {
            let metas: Vec<Pubkey> = ixs[i].accounts.iter().map(|m| m.pubkey).collect();
            assert!(metas.contains(expected), "ix {i} missing expected ATA");
        }
    }

    #[test]
    #[allow(deprecated)]
    fn sell_instruction_cashback_appends_uva_then_bonding_curve_v2() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(101);
        let user = fake_pubkey(102);
        let creator = fake_pubkey(103);
        let fee_recipient = fake_pubkey(104);
        let buyback_fee_recipient = fake_pubkey(105);
        let token_program = constants::SPL_TOKEN_PROGRAM_ID;

        let ix = sdk.sell_instruction(
            mint,
            user,
            creator,
            fee_recipient,
            buyback_fee_recipient,
            100,
            1_000_000,
            token_program,
            true,
        );

        assert_eq!(ix.program_id, crate::pump::ID);
        assert_eq!(
            &ix.data[..8],
            <client::args::Sell as Discriminator>::DISCRIMINATOR,
        );

        let metas: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
        assert!(metas.contains(&pda::pump::global().0));
        assert!(metas.contains(&pda::pump::bonding_curve(&mint).0));
        assert!(metas.contains(&pda::pump::creator_vault(&creator).0));
        assert!(metas.contains(&pda::pump::fee_config().0));
        assert!(metas.contains(&constants::FEE_PROGRAM_ID));
        assert!(metas.contains(&fee_recipient));
        assert!(metas.contains(&pda::associated_token(&user, &token_program, &mint).0));

        let n = ix.accounts.len();
        let uva = &ix.accounts[n - 2];
        let bcv2 = &ix.accounts[n - 1];
        assert_eq!(uva.pubkey, pda::pump::user_volume_accumulator(&user).0);
        assert!(uva.is_writable);
        assert!(!uva.is_signer);
        assert_eq!(bcv2.pubkey, pda::pump::bonding_curve_v2(&mint).0);
        assert!(!bcv2.is_writable);
        assert!(!bcv2.is_signer);
    }

    #[test]
    #[allow(deprecated)]
    fn sell_instruction_non_cashback_skips_uva() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(101);
        let user = fake_pubkey(102);
        let creator = fake_pubkey(103);
        let fee_recipient = fake_pubkey(104);
        let buyback_fee_recipient = fake_pubkey(105);
        let token_program = constants::SPL_TOKEN_PROGRAM_ID;

        let ix = sdk.sell_instruction(
            mint,
            user,
            creator,
            fee_recipient,
            buyback_fee_recipient,
            100,
            1_000_000,
            token_program,
            false,
        );

        let metas: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
        assert!(!metas.contains(&pda::pump::user_volume_accumulator(&user).0));

        let bcv2 = &ix.accounts[ix.accounts.len() - 1];
        assert_eq!(bcv2.pubkey, pda::pump::bonding_curve_v2(&mint).0);
        assert!(!bcv2.is_writable);
        assert!(!bcv2.is_signer);
    }

    #[test]
    fn sell_v2_instruction_wires_quote_and_sharing_config_pdas() {
        let sdk = PumpSdk::new();
        let base_mint = fake_pubkey(111);
        let quote_mint = fake_pubkey(112);
        let user = fake_pubkey(113);
        let creator = fake_pubkey(114);
        let fee_recipient = fake_pubkey(115);
        let buyback_fee_recipient = fake_pubkey(116);
        let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
        let global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);
        let bonding_curve = BondingCurve::new(BondingCurveFromIdl {
            creator,
            quote_mint,
            ..Default::default()
        });

        let ix = sdk
            .sell_v2_instruction(
                &global,
                &bonding_curve,
                base_mint,
                quote_token_program,
                user,
                1_000,
                1_000_000,
            )
            .expect("sell_v2_instruction");

        assert_eq!(ix.program_id, crate::pump::ID);
        assert_eq!(
            &ix.data[..8],
            <client::args::SellV2 as Discriminator>::DISCRIMINATOR,
        );

        let metas: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
        assert!(metas.contains(&pda::pump::global().0));
        assert!(metas.contains(&base_mint));
        assert!(metas.contains(&quote_mint));
        assert!(metas.contains(&fee_recipient));
        assert!(metas.contains(&buyback_fee_recipient));
        assert!(metas.contains(&pda::pump::bonding_curve(&base_mint).0));
        assert!(metas.contains(&pda::pump::creator_vault(&creator).0));
        assert!(metas.contains(&pda::pump::sharing_config(&base_mint).0));
        assert!(metas.contains(&pda::pump::user_volume_accumulator(&user).0));
        assert!(metas.contains(&pda::pump::fee_config().0));
        assert!(metas.contains(&constants::FEE_PROGRAM_ID));

        assert!(!metas.contains(&pda::pump::global_volume_accumulator().0));

        assert!(metas
            .contains(&pda::associated_token(&fee_recipient, &quote_token_program, &quote_mint).0));
        assert!(metas.contains(
            &pda::associated_token(&buyback_fee_recipient, &quote_token_program, &quote_mint).0
        ));

        let signers: Vec<Pubkey> = ix
            .accounts
            .iter()
            .filter(|m| m.is_signer)
            .map(|m| m.pubkey)
            .collect();
        assert_eq!(signers, vec![user]);
    }

    #[test]
    fn sell_v2_instructions_prepends_four_ata_creates() {
        let sdk = PumpSdk::new();
        let base_mint = fake_pubkey(121);
        let quote_mint = fake_pubkey(122);
        let user = fake_pubkey(123);
        let creator = fake_pubkey(124);
        let fee_recipient = fake_pubkey(125);
        let buyback_fee_recipient = fake_pubkey(126);
        let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
        let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
        let global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);
        let bonding_curve = BondingCurve::new(BondingCurveFromIdl {
            creator,
            quote_mint,
            ..Default::default()
        });

        let ixs = sdk
            .sell_v2_instructions(
                &global,
                &bonding_curve,
                base_mint,
                quote_token_program,
                user,
                1_000,
                1_000_000,
            )
            .expect("sell_v2_instructions");

        assert_eq!(ixs.len(), 5);
        for ata_ix in &ixs[..4] {
            assert_eq!(ata_ix.program_id, constants::SPL_ATA_PROGRAM_ID);
            assert_eq!(ata_ix.data, vec![1]);
        }
        assert_eq!(
            &ixs[4].data[..8],
            <client::args::SellV2 as Discriminator>::DISCRIMINATOR,
        );

        let bonding_curve = pda::pump::bonding_curve(&base_mint).0;
        let expected_atas: [Pubkey; 4] = [
            pda::associated_token(&user, &base_token_program, &base_mint).0,
            pda::associated_token(&bonding_curve, &quote_token_program, &quote_mint).0,
            pda::associated_token(&user, &quote_token_program, &quote_mint).0,
            pda::associated_token(&buyback_fee_recipient, &quote_token_program, &quote_mint).0,
        ];
        for (i, expected) in expected_atas.iter().enumerate() {
            let metas: Vec<Pubkey> = ixs[i].accounts.iter().map(|m| m.pubkey).collect();
            assert!(metas.contains(expected), "ix {i} missing expected ATA");
        }
    }

    fn fake_amm_inputs() -> (
        Pubkey,
        Pubkey,
        Pubkey,
        Pubkey,
        Pubkey,
        Pubkey,
        Pubkey,
        Pubkey,
    ) {
        (
            fake_pubkey(0xA1),
            fake_pubkey(0xA2),
            fake_pubkey(0xA3),
            fake_pubkey(0xA4),
            fake_pubkey(0xA5),
            fake_pubkey(0xA6),
            fake_pubkey(0xA7),
            constants::SPL_TOKEN_PROGRAM_ID,
        )
    }

    #[test]
    fn buy_amm_instruction_wires_pump_amm_pdas() {
        let sdk = PumpSdk::new();
        let (pool, base_mint, quote_mint, user, coin_creator, fee_rec, buyback, _) =
            fake_amm_inputs();
        let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
        let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
        let amm_global = amm_global_with_fees(fee_rec, buyback);
        let pool_state = Pool::new(PoolFromIdl {
            base_mint,
            quote_mint,
            coin_creator,
            is_cashback_coin: true,
            ..Default::default()
        });

        let ix = sdk
            .buy_amm_instruction(
                pool,
                &amm_global,
                &pool_state,
                base_token_program,
                quote_token_program,
                user,
                1_000,
                500_000,
            )
            .expect("buy_amm_instruction");

        assert_eq!(ix.program_id, crate::pump_amm::ID);
        assert_eq!(
            &ix.data[..8],
            <amm_client::args::Buy as Discriminator>::DISCRIMINATOR,
        );
        assert_eq!(ix.accounts.len(), 27);

        let pubkeys: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
        assert!(pubkeys.contains(&pda::pump_amm::global_config().0));
        assert!(pubkeys.contains(&pda::pump_amm::event_authority().0));
        assert!(pubkeys.contains(&pda::pump_amm::global_volume_accumulator().0));
        assert!(pubkeys.contains(&pda::pump_amm::user_volume_accumulator(&user).0));
        assert!(pubkeys.contains(&pda::pump_amm::fee_config().0));
        assert!(pubkeys.contains(&pda::pump_amm::coin_creator_vault_authority(&coin_creator).0));

        assert_eq!(ix.accounts[0].pubkey, pool);
        assert!(ix.accounts[0].is_writable);
        assert!(!ix.accounts[0].is_signer);
        assert_eq!(ix.accounts[1].pubkey, user);
        assert!(ix.accounts[1].is_signer);

        let n = ix.accounts.len();
        let cashback = &ix.accounts[n - 4];
        let bcv2 = &ix.accounts[n - 3];
        let buyback_meta = &ix.accounts[n - 2];
        let buyback_ata = &ix.accounts[n - 1];

        let user_vol_accum = pda::pump_amm::user_volume_accumulator(&user).0;
        assert_eq!(
            cashback.pubkey,
            pda::associated_token(
                &user_vol_accum,
                &quote_token_program,
                &constants::NATIVE_MINT,
            )
            .0
        );
        assert!(cashback.is_writable);

        assert_eq!(bcv2.pubkey, pda::pump_amm::pool_v2(&base_mint).0);
        assert!(!bcv2.is_writable);

        assert_eq!(buyback_meta.pubkey, buyback);
        assert!(buyback_meta.is_writable);

        assert_eq!(
            buyback_ata.pubkey,
            pda::associated_token(&buyback, &quote_token_program, &quote_mint).0
        );
        assert!(buyback_ata.is_writable);
    }

    #[test]
    fn buy_amm_instruction_skips_remaining_when_no_cashback_no_creator() {
        let sdk = PumpSdk::new();
        let (pool, base_mint, quote_mint, user, _, fee_rec, buyback, _) = fake_amm_inputs();
        let amm_global = amm_global_with_fees(fee_rec, buyback);
        let pool_state = Pool::new(PoolFromIdl {
            base_mint,
            quote_mint,
            coin_creator: Pubkey::default(),
            is_cashback_coin: false,
            ..Default::default()
        });

        let ix = sdk
            .buy_amm_instruction(
                pool,
                &amm_global,
                &pool_state,
                constants::SPL_TOKEN_2022_PROGRAM_ID,
                constants::SPL_TOKEN_PROGRAM_ID,
                user,
                1_000,
                500_000,
            )
            .expect("buy_amm_instruction");

        assert_eq!(ix.accounts.len(), 25);
        let n = ix.accounts.len();
        assert_eq!(ix.accounts[n - 2].pubkey, buyback);
        assert!(ix.accounts[n - 2].is_writable);
    }

    #[test]
    fn sell_amm_instruction_wires_pump_amm_pdas() {
        let sdk = PumpSdk::new();
        let (pool, base_mint, quote_mint, user, coin_creator, fee_rec, buyback, _) =
            fake_amm_inputs();
        let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
        let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
        let amm_global = amm_global_with_fees(fee_rec, buyback);
        let pool_state = Pool::new(PoolFromIdl {
            base_mint,
            quote_mint,
            coin_creator,
            is_cashback_coin: true,
            ..Default::default()
        });

        let ix = sdk
            .sell_amm_instruction(
                pool,
                &amm_global,
                &pool_state,
                base_token_program,
                quote_token_program,
                user,
                1_000_000,
                500,
            )
            .expect("sell_amm_instruction");

        assert_eq!(ix.program_id, crate::pump_amm::ID);
        assert_eq!(
            &ix.data[..8],
            <amm_client::args::Sell as Discriminator>::DISCRIMINATOR,
        );
        assert_eq!(ix.accounts.len(), 26);

        let pubkeys: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
        assert!(!pubkeys.contains(&pda::pump_amm::global_volume_accumulator().0));

        let user_vol_accum = pda::pump_amm::user_volume_accumulator(&user).0;
        let n = ix.accounts.len();
        let cashback_ata = &ix.accounts[n - 5];
        let cashback_uva = &ix.accounts[n - 4];
        let bcv2 = &ix.accounts[n - 3];
        let buyback_meta = &ix.accounts[n - 2];
        let buyback_ata = &ix.accounts[n - 1];

        assert_eq!(
            cashback_ata.pubkey,
            pda::associated_token(&user_vol_accum, &quote_token_program, &quote_mint).0
        );
        assert!(cashback_ata.is_writable);

        assert_eq!(cashback_uva.pubkey, user_vol_accum);
        assert!(cashback_uva.is_writable);

        assert_eq!(bcv2.pubkey, pda::pump_amm::pool_v2(&base_mint).0);
        assert!(!bcv2.is_writable);

        assert_eq!(buyback_meta.pubkey, buyback);
        assert!(!buyback_meta.is_writable);

        assert_eq!(
            buyback_ata.pubkey,
            pda::associated_token(&buyback, &quote_token_program, &quote_mint).0
        );
        assert!(buyback_ata.is_writable);
    }

    #[test]
    fn sell_amm_instruction_skips_remaining_when_no_cashback_no_creator() {
        let sdk = PumpSdk::new();
        let (pool, base_mint, quote_mint, user, _, fee_rec, buyback, _) = fake_amm_inputs();
        let amm_global = amm_global_with_fees(fee_rec, buyback);
        let pool_state = Pool::new(PoolFromIdl {
            base_mint,
            quote_mint,
            coin_creator: Pubkey::default(),
            is_cashback_coin: false,
            ..Default::default()
        });

        let ix = sdk
            .sell_amm_instruction(
                pool,
                &amm_global,
                &pool_state,
                constants::SPL_TOKEN_2022_PROGRAM_ID,
                constants::SPL_TOKEN_PROGRAM_ID,
                user,
                1_000_000,
                500,
            )
            .expect("sell_amm_instruction");

        assert_eq!(ix.accounts.len(), 23);
        let n = ix.accounts.len();
        assert_eq!(ix.accounts[n - 2].pubkey, buyback);
        assert!(!ix.accounts[n - 2].is_writable);
    }

    #[test]
    fn buy_amm_instructions_prepends_one_ata_create() {
        let sdk = PumpSdk::new();
        let (pool, base_mint, quote_mint, user, coin_creator, fee_rec, buyback, _) =
            fake_amm_inputs();
        let amm_global = amm_global_with_fees(fee_rec, buyback);
        let pool_state = Pool::new(PoolFromIdl {
            base_mint,
            quote_mint,
            coin_creator,
            is_cashback_coin: false,
            ..Default::default()
        });

        let ixs = sdk
            .buy_amm_instructions(
                pool,
                &amm_global,
                &pool_state,
                constants::SPL_TOKEN_2022_PROGRAM_ID,
                constants::SPL_TOKEN_PROGRAM_ID,
                user,
                1_000,
                500_000,
            )
            .expect("buy_amm_instructions");

        assert_eq!(ixs.len(), 2);
        assert_eq!(ixs[0].program_id, constants::SPL_ATA_PROGRAM_ID);
        assert_eq!(ixs[0].data, vec![1]);
        assert_eq!(ixs[1].program_id, crate::pump_amm::ID);
        assert_eq!(
            &ixs[1].data[..8],
            <amm_client::args::Buy as Discriminator>::DISCRIMINATOR,
        );
    }

    #[test]
    fn sell_amm_instructions_prepends_one_ata_create() {
        let sdk = PumpSdk::new();
        let (pool, base_mint, quote_mint, user, coin_creator, fee_rec, buyback, _) =
            fake_amm_inputs();
        let amm_global = amm_global_with_fees(fee_rec, buyback);
        let pool_state = Pool::new(PoolFromIdl {
            base_mint,
            quote_mint,
            coin_creator,
            is_cashback_coin: false,
            ..Default::default()
        });

        let ixs = sdk
            .sell_amm_instructions(
                pool,
                &amm_global,
                &pool_state,
                constants::SPL_TOKEN_2022_PROGRAM_ID,
                constants::SPL_TOKEN_PROGRAM_ID,
                user,
                1_000_000,
                500,
            )
            .expect("sell_amm_instructions");

        assert_eq!(ixs.len(), 2);
        assert_eq!(ixs[0].program_id, constants::SPL_ATA_PROGRAM_ID);
        assert_eq!(ixs[0].data, vec![1]);
        assert_eq!(ixs[1].program_id, crate::pump_amm::ID);
        assert_eq!(
            &ixs[1].data[..8],
            <amm_client::args::Sell as Discriminator>::DISCRIMINATOR,
        );
    }

    fn user_wsol_ata(user: &Pubkey) -> Pubkey {
        pda::associated_token(
            user,
            &constants::SPL_TOKEN_PROGRAM_ID,
            &constants::NATIVE_MINT,
        )
        .0
    }

    /// Parses lamports from a system `transfer` instruction (tests).
    fn parse_system_transfer_lamports(ix: &solana_program::instruction::Instruction) -> u64 {
        assert_eq!(ix.program_id, system_program::ID);
        assert_eq!(ix.data.len(), 12);
        assert_eq!(&ix.data[..4], &2u32.to_le_bytes());
        u64::from_le_bytes(ix.data[4..12].try_into().unwrap())
    }

    #[test]
    fn trade_tx_buy_bc_delegates_to_buy_v2_instructions() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(0xB1);
        let user = fake_pubkey(0xB2);
        let creator = fake_pubkey(0xB3);
        let fee_recipient = fake_pubkey(0xB4);
        let buyback_fee_recipient = fake_pubkey(0xB5);
        let max_sol = 7_500_000u64;
        let global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);
        let bonding_curve = BondingCurve::new(BondingCurveFromIdl {
            creator,
            quote_mint: constants::NATIVE_MINT,
            ..Default::default()
        });

        let ixs = sdk
            .trade_tx_instructions_with_venue(TradeTxWithVenueParams {
                mint,
                base_token_program: constants::SPL_TOKEN_2022_PROGRAM_ID,
                quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
                user,
                is_buy: true,
                venue: TradeVenue::BondingCurve {
                    global: &global,
                    bonding_curve: &bonding_curve,
                },
                base_amount: 1_000,
                sol_amount_threshold: max_sol,
            })
            .expect("trade_tx_instructions");

        assert_eq!(ixs.len(), 3);
        for ata_ix in &ixs[..2] {
            assert_eq!(ata_ix.program_id, constants::SPL_ATA_PROGRAM_ID);
            assert_eq!(ata_ix.data, vec![1]);
        }
        assert_eq!(ixs[2].program_id, crate::pump::ID);
        assert_eq!(
            &ixs[2].data[..8],
            <client::args::BuyV2 as Discriminator>::DISCRIMINATOR,
        );

        let expected_atas: [Pubkey; 2] = [
            pda::associated_token(&user, &constants::SPL_TOKEN_2022_PROGRAM_ID, &mint).0,
            user_wsol_ata(&user),
        ];
        for (i, expected) in expected_atas.iter().enumerate() {
            let metas: Vec<Pubkey> = ixs[i].accounts.iter().map(|m| m.pubkey).collect();
            assert!(metas.contains(expected), "ata ix {i} missing expected ATA");
        }
    }

    #[test]
    fn trade_tx_sell_bc_delegates_to_sell_v2_instructions() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(0xC1);
        let user = fake_pubkey(0xC2);
        let creator = fake_pubkey(0xC3);
        let fee_recipient = fake_pubkey(0xC4);
        let buyback_fee_recipient = fake_pubkey(0xC5);
        let global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);
        let bonding_curve = BondingCurve::new(BondingCurveFromIdl {
            creator,
            quote_mint: constants::NATIVE_MINT,
            ..Default::default()
        });

        let ixs = sdk
            .trade_tx_instructions_with_venue(TradeTxWithVenueParams {
                mint,
                base_token_program: constants::SPL_TOKEN_2022_PROGRAM_ID,
                quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
                user,
                is_buy: false,
                venue: TradeVenue::BondingCurve {
                    global: &global,
                    bonding_curve: &bonding_curve,
                },
                base_amount: 1_000,
                sol_amount_threshold: 1_000_000,
            })
            .expect("trade_tx_instructions");

        assert_eq!(ixs.len(), 2);
        assert_eq!(ixs[0].program_id, constants::SPL_ATA_PROGRAM_ID);
        assert_eq!(ixs[0].data, vec![1]);
        assert_eq!(ixs[1].program_id, crate::pump::ID);
        assert_eq!(
            &ixs[1].data[..8],
            <client::args::SellV2 as Discriminator>::DISCRIMINATOR,
        );
        let metas: Vec<Pubkey> = ixs[0].accounts.iter().map(|m| m.pubkey).collect();
        assert!(metas.contains(&user_wsol_ata(&user)));
    }

    #[test]
    fn trade_tx_auto_matches_explicit_bc_when_not_complete() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(0x70);
        let user = fake_pubkey(0x71);
        let creator = fake_pubkey(0x72);
        let fee_recipient = fake_pubkey(0x73);
        let buyback_fee_recipient = fake_pubkey(0x74);
        let max_sol = 7_500_000u64;
        let global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);
        let bonding_curve = BondingCurve::new(BondingCurveFromIdl {
            creator,
            quote_mint: constants::NATIVE_MINT,
            complete: false,
            ..Default::default()
        });

        let explicit = sdk
            .trade_tx_instructions_with_venue(TradeTxWithVenueParams {
                mint,
                base_token_program: constants::SPL_TOKEN_2022_PROGRAM_ID,
                quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
                user,
                is_buy: true,
                venue: TradeVenue::BondingCurve {
                    global: &global,
                    bonding_curve: &bonding_curve,
                },
                base_amount: 1_000,
                sol_amount_threshold: max_sol,
            })
            .expect("explicit bc");

        let pool = fake_pubkey(0x75);
        let amm_g = amm_global_with_fees(fake_pubkey(0x76), fake_pubkey(0x77));
        let ps = Pool::new(PoolFromIdl {
            base_mint: mint,
            quote_mint: constants::NATIVE_MINT,
            ..Default::default()
        });
        let auto = sdk
            .trade_tx_instructions(TradeTxParams {
                mint,
                base_token_program: constants::SPL_TOKEN_2022_PROGRAM_ID,
                quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
                user,
                is_buy: true,
                base_amount: 1_000,
                sol_amount_threshold: max_sol,
                pump_global: &global,
                bonding_curve: &bonding_curve,
                pump_pool: Some(PumpPoolCtx {
                    pool,
                    amm_global: &amm_g,
                    pool_state: &ps,
                }),
            })
            .expect("auto bc");

        assert_eq!(explicit.len(), auto.len());
        for (a, b) in explicit.iter().zip(auto.iter()) {
            assert_eq!(a.program_id, b.program_id);
            assert_eq!(a.data, b.data);
        }
    }

    #[test]
    fn trade_tx_auto_returns_none_when_complete_without_graduated() {
        let sdk = PumpSdk::new();
        let global = pump_global_with_fees(fake_pubkey(0x80), fake_pubkey(0x81));
        let bonding_curve = BondingCurve::new(BondingCurveFromIdl {
            complete: true,
            ..Default::default()
        });
        assert!(sdk
            .trade_tx_instructions(TradeTxParams {
                mint: fake_pubkey(0x82),
                base_token_program: constants::SPL_TOKEN_2022_PROGRAM_ID,
                quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
                user: fake_pubkey(0x83),
                is_buy: true,
                base_amount: 1,
                sol_amount_threshold: 1,
                pump_global: &global,
                bonding_curve: &bonding_curve,
                pump_pool: None,
            })
            .is_none());
    }

    #[test]
    fn trade_tx_auto_matches_explicit_amm_when_complete() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(0x90);
        let user = fake_pubkey(0x91);
        let coin_creator = fake_pubkey(0x92);
        let fee_recipient = fake_pubkey(0x93);
        let buyback_fee_recipient = fake_pubkey(0x94);
        let pool = fake_pubkey(0x95);
        let max_sol = 2_500_000u64;
        let amm_global = amm_global_with_fees(fee_recipient, buyback_fee_recipient);
        let pool_state = Pool::new(PoolFromIdl {
            base_mint: mint,
            quote_mint: constants::NATIVE_MINT,
            coin_creator,
            is_cashback_coin: true,
            ..Default::default()
        });
        let pump_global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);
        let bonding_curve = BondingCurve::new(BondingCurveFromIdl {
            creator: coin_creator,
            quote_mint: constants::NATIVE_MINT,
            complete: true,
            ..Default::default()
        });

        let explicit = sdk
            .trade_tx_instructions_with_venue(TradeTxWithVenueParams {
                mint,
                base_token_program: constants::SPL_TOKEN_2022_PROGRAM_ID,
                quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
                user,
                is_buy: true,
                venue: TradeVenue::Amm {
                    pool,
                    amm_global: &amm_global,
                    pool_state: &pool_state,
                },
                base_amount: 1_000,
                sol_amount_threshold: max_sol,
            })
            .expect("explicit amm");

        let auto = sdk
            .trade_tx_instructions(TradeTxParams {
                mint,
                base_token_program: constants::SPL_TOKEN_2022_PROGRAM_ID,
                quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
                user,
                is_buy: true,
                base_amount: 1_000,
                sol_amount_threshold: max_sol,
                pump_global: &pump_global,
                bonding_curve: &bonding_curve,
                pump_pool: Some(PumpPoolCtx {
                    pool,
                    amm_global: &amm_global,
                    pool_state: &pool_state,
                }),
            })
            .expect("auto amm");

        assert_eq!(explicit.len(), auto.len());
        for (a, b) in explicit.iter().zip(auto.iter()) {
            assert_eq!(a.program_id, b.program_id);
            assert_eq!(a.data, b.data);
        }
    }

    #[test]
    fn quote_trade_bc_matches_direct_buy_and_sell_quotes() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let bc = fixture_bonding_curve(fake_pubkey(7));
        let supply = g.token_total_supply;
        let target = 100_000_000_000_000u64;
        let slip = 200u16;

        let buy_direct = sdk
            .buy_quote_bonding_curve_token_out(&g, None, &bc, supply, target, slip)
            .expect("buy direct");
        let buy_auto = sdk
            .quote_trade(TradeQuoteParams {
                is_buy: true,
                base_amount: target,
                slippage_bps: slip,
                base_mint_supply: supply,
                pump_global: &g,
                pump_fee_config: None,
                bonding_curve: &bc,
                pump_pool: None,
            })
            .expect("auto routed")
            .expect("buy auto");
        assert_eq!(buy_direct, buy_auto);

        let sell_direct = sdk
            .sell_quote_bonding_curve(&g, None, &bc, supply, target, slip)
            .expect("sell direct");
        let sell_auto = sdk
            .quote_trade(TradeQuoteParams {
                is_buy: false,
                base_amount: target,
                slippage_bps: slip,
                base_mint_supply: supply,
                pump_global: &g,
                pump_fee_config: None,
                bonding_curve: &bc,
                pump_pool: None,
            })
            .expect("auto routed")
            .expect("sell auto");
        assert_eq!(sell_direct, sell_auto);
    }

    #[test]
    fn quote_trade_amm_matches_direct_buy_and_sell_quotes() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let gc = fixture_amm_global_config();
        let pool_state = fixture_pool(fake_pubkey(0xCC));
        let mut bc = fixture_bonding_curve(fake_pubkey(7));
        bc.complete = true;

        let base_reserve = 200_000_000_000_000u64;
        let quote_reserve = 30_000_000_000u64;
        let base_mint_supply = 1_000_000_000_000_000u64;
        let target = 1_000_000_000_000u64;
        let slip = 100u16;

        let source = AmmQuoteSource::Pool {
            pool: &pool_state,
            base_reserve,
            quote_reserve,
            base_mint_supply,
        };
        let buy_direct = sdk
            .buy_quote_amm_token_out(&gc, None, source, target, slip)
            .expect("buy direct");
        let buy_auto = sdk
            .quote_trade(TradeQuoteParams {
                is_buy: true,
                base_amount: target,
                slippage_bps: slip,
                base_mint_supply,
                pump_global: &g,
                pump_fee_config: None,
                bonding_curve: &bc,
                pump_pool: Some(PumpPoolQuoteCtx {
                    amm_global: &gc,
                    amm_fee_config: None,
                    pool_state: &pool_state,
                    base_reserve,
                    quote_reserve,
                }),
            })
            .expect("auto routed")
            .expect("buy auto");
        assert_eq!(buy_direct, buy_auto);

        let sell_source = AmmQuoteSource::Pool {
            pool: &pool_state,
            base_reserve,
            quote_reserve,
            base_mint_supply,
        };
        let sell_direct = sdk
            .sell_quote_amm(&gc, None, sell_source, target, slip)
            .expect("sell direct");
        let sell_auto = sdk
            .quote_trade(TradeQuoteParams {
                is_buy: false,
                base_amount: target,
                slippage_bps: slip,
                base_mint_supply,
                pump_global: &g,
                pump_fee_config: None,
                bonding_curve: &bc,
                pump_pool: Some(PumpPoolQuoteCtx {
                    amm_global: &gc,
                    amm_fee_config: None,
                    pool_state: &pool_state,
                    base_reserve,
                    quote_reserve,
                }),
            })
            .expect("auto routed")
            .expect("sell auto");
        assert_eq!(sell_direct, sell_auto);
    }

    #[test]
    fn quote_trade_returns_none_when_complete_without_pump_pool() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let mut bc = fixture_bonding_curve(fake_pubkey(7));
        bc.complete = true;
        assert!(sdk
            .quote_trade(TradeQuoteParams {
                is_buy: true,
                base_amount: 1,
                slippage_bps: 0,
                base_mint_supply: g.token_total_supply,
                pump_global: &g,
                pump_fee_config: None,
                bonding_curve: &bc,
                pump_pool: None,
            })
            .is_none());
    }

    #[test]
    fn trade_tx_buy_amm_wraps_and_unwraps_with_cashback() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(0xD1);
        let user = fake_pubkey(0xD2);
        let coin_creator = fake_pubkey(0xD3);
        let fee_recipient = fake_pubkey(0xD4);
        let buyback_fee_recipient = fake_pubkey(0xD5);
        let pool = fake_pubkey(0xD6);
        let max_sol = 2_500_000u64;
        let amm_global = amm_global_with_fees(fee_recipient, buyback_fee_recipient);
        let pool_state = Pool::new(PoolFromIdl {
            base_mint: mint,
            quote_mint: constants::NATIVE_MINT,
            coin_creator,
            is_cashback_coin: true,
            ..Default::default()
        });

        let ixs = sdk
            .trade_tx_instructions_with_venue(TradeTxWithVenueParams {
                mint,
                base_token_program: constants::SPL_TOKEN_2022_PROGRAM_ID,
                quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
                user,
                is_buy: true,
                venue: TradeVenue::Amm {
                    pool,
                    amm_global: &amm_global,
                    pool_state: &pool_state,
                },
                base_amount: 1_000,
                sol_amount_threshold: max_sol,
            })
            .expect("trade_tx_instructions");

        assert_eq!(ixs.len(), 6);
        assert_eq!(ixs[0].program_id, constants::SPL_ATA_PROGRAM_ID);
        assert_eq!(ixs[1].program_id, constants::SPL_ATA_PROGRAM_ID);
        assert_eq!(parse_system_transfer_lamports(&ixs[2]), max_sol);
        assert_eq!(ixs[3].program_id, constants::SPL_TOKEN_PROGRAM_ID);
        assert_eq!(ixs[4].program_id, crate::pump_amm::ID);
        assert_eq!(
            &ixs[4].data[..8],
            <amm_client::args::Buy as Discriminator>::DISCRIMINATOR,
        );
        assert_eq!(ixs[5].program_id, constants::SPL_TOKEN_PROGRAM_ID);

        let pubkeys: Vec<Pubkey> = ixs[4].accounts.iter().map(|m| m.pubkey).collect();
        let user_vol_accum = pda::pump_amm::user_volume_accumulator(&user).0;
        assert!(pubkeys.contains(
            &pda::associated_token(
                &user_vol_accum,
                &constants::SPL_TOKEN_PROGRAM_ID,
                &constants::NATIVE_MINT,
            )
            .0
        ));
        assert!(pubkeys.contains(&pda::pump_amm::pool_v2(&mint).0));
    }

    #[test]
    fn trade_tx_sell_amm_unwraps_proceeds_no_wrap() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(0xE1);
        let user = fake_pubkey(0xE2);
        let coin_creator = fake_pubkey(0xE3);
        let fee_recipient = fake_pubkey(0xE4);
        let buyback_fee_recipient = fake_pubkey(0xE5);
        let pool = fake_pubkey(0xE6);
        let amm_global = amm_global_with_fees(fee_recipient, buyback_fee_recipient);
        let pool_state = Pool::new(PoolFromIdl {
            base_mint: mint,
            quote_mint: constants::NATIVE_MINT,
            coin_creator,
            is_cashback_coin: false,
            ..Default::default()
        });

        let ixs = sdk
            .trade_tx_instructions_with_venue(TradeTxWithVenueParams {
                mint,
                base_token_program: constants::SPL_TOKEN_2022_PROGRAM_ID,
                quote_token_program: constants::SPL_TOKEN_PROGRAM_ID,
                user,
                is_buy: false,
                venue: TradeVenue::Amm {
                    pool,
                    amm_global: &amm_global,
                    pool_state: &pool_state,
                },
                base_amount: 5_000,
                sol_amount_threshold: 100,
            })
            .expect("trade_tx_instructions");

        assert_eq!(ixs.len(), 3);
        assert_eq!(ixs[0].program_id, constants::SPL_ATA_PROGRAM_ID);
        let wsol_ata = user_wsol_ata(&user);
        assert!(ixs[0].accounts.iter().any(|m| m.pubkey == wsol_ata));
        assert_eq!(ixs[1].program_id, crate::pump_amm::ID);
        assert_eq!(
            &ixs[1].data[..8],
            <amm_client::args::Sell as Discriminator>::DISCRIMINATOR,
        );
        assert_eq!(ixs[2].program_id, constants::SPL_TOKEN_PROGRAM_ID);
        assert!(ixs[2].accounts.iter().any(|m| m.pubkey == wsol_ata));
    }

    #[test]
    fn create_coin_instructions_emits_create_then_buy_v2() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(0xF1);
        let user = fake_pubkey(0xF2);
        let creator = fake_pubkey(0xF3);
        let fee_recipient = fake_pubkey(0xF4);
        let buyback_fee_recipient = fake_pubkey(0xF5);
        let max_sol = 1_234_567u64;
        let global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);

        let ixs = sdk
            .create_coin_instructions(CreateCoinParams {
                mint,
                user,
                creator,
                name: "Test".into(),
                symbol: "TST".into(),
                uri: "https://example.com/metadata.json".into(),
                mayhem_mode: false,
                cashback: false,
                quote_mint: Pubkey::default(),
                global: &global,
                token_amount: 1_000,
                max_quote_tokens: max_sol,
                tokenized_agent_buyback_bps: None,
            })
            .expect("create_coin_instructions");

        assert_eq!(ixs.len(), 4);
        assert_eq!(
            &ixs[0].data[..8],
            <client::args::CreateV2 as Discriminator>::DISCRIMINATOR,
        );
        for ata_ix in &ixs[1..3] {
            assert_eq!(ata_ix.program_id, constants::SPL_ATA_PROGRAM_ID);
            assert_eq!(ata_ix.data, vec![1]);
        }
        assert_eq!(ixs[3].program_id, crate::pump::ID);
        assert_eq!(
            &ixs[3].data[..8],
            <client::args::BuyV2 as Discriminator>::DISCRIMINATOR,
        );
        let buy_metas: Vec<Pubkey> = ixs[3].accounts.iter().map(|m| m.pubkey).collect();
        assert!(buy_metas.contains(&constants::SPL_TOKEN_2022_PROGRAM_ID));
        assert!(buy_metas.contains(&constants::NATIVE_MINT));
        assert!(buy_metas.contains(&pda::pump::sharing_config(&mint).0));
    }

    #[test]
    fn create_coin_instructions_appends_agent_initialize_when_some() {
        let sdk = PumpSdk::new();
        let mint = fake_pubkey(0xA1);
        let user = fake_pubkey(0xA2);
        let creator = fake_pubkey(0xA3);
        let fee_recipient = fake_pubkey(0xA4);
        let buyback_fee_recipient = fake_pubkey(0xA5);
        let global = pump_global_with_fees(fee_recipient, buyback_fee_recipient);

        let buyback_bps = 5000u16;
        let with_agent = sdk
            .create_coin_instructions(CreateCoinParams {
                mint,
                user,
                creator,
                name: "Test".into(),
                symbol: "TST".into(),
                uri: "https://example.com/metadata.json".into(),
                mayhem_mode: false,
                cashback: false,
                quote_mint: Pubkey::default(),
                global: &global,
                token_amount: 1_000,
                max_quote_tokens: 500_000,
                tokenized_agent_buyback_bps: Some(buyback_bps),
            })
            .expect("create_coin_instructions Some");
        let without_agent = sdk
            .create_coin_instructions(CreateCoinParams {
                mint,
                user,
                creator,
                name: "Test".into(),
                symbol: "TST".into(),
                uri: "https://example.com/metadata.json".into(),
                mayhem_mode: false,
                cashback: false,
                quote_mint: Pubkey::default(),
                global: &global,
                token_amount: 1_000,
                max_quote_tokens: 500_000,
                tokenized_agent_buyback_bps: None,
            })
            .expect("create_coin_instructions None");

        assert_eq!(
            with_agent.len(),
            without_agent.len() + 1,
            "Some(bps) appends exactly one extra ix"
        );
        let agent_ix = with_agent.last().expect("agent ix present");
        assert_eq!(agent_ix.program_id, crate::pump_agent_payments::ID);
        assert_eq!(
            &agent_ix.data[..8],
            <agent_client::args::AgentInitialize as Discriminator>::DISCRIMINATOR,
        );
        // args.authority (creator) + args.buyback_bps trail the discriminator.
        assert_eq!(&agent_ix.data[8..40], creator.as_ref());
        assert_eq!(
            u16::from_le_bytes([agent_ix.data[40], agent_ix.data[41]]),
            buyback_bps,
        );
        let agent_metas: Vec<Pubkey> = agent_ix.accounts.iter().map(|m| m.pubkey).collect();
        assert!(agent_metas.contains(&user), "user is the signer");
        assert!(agent_metas.contains(&pda::pump::bonding_curve(&mint).0));
        assert!(agent_metas.contains(&pda::pump_agent_payments::global_config().0));
        assert!(agent_metas.contains(&mint));
        assert!(agent_metas.contains(&pda::pump_agent_payments::token_agent_payments(&mint).0));
        assert!(agent_metas.contains(&pda::pump_agent_payments::event_authority().0));
        assert!(agent_metas.contains(&crate::pump_agent_payments::ID));
        assert!(agent_metas.contains(&pda::pump::sharing_config(&mint).0));
    }

    #[test]
    fn program_ids_match_idl() {
        assert_eq!(
            crate::pump::ID,
            pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
        );
        assert_eq!(
            crate::pump_amm::ID,
            pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")
        );
    }

    fn fixture_global() -> Global {
        Global::new(GlobalFromIdl {
            fee_basis_points: 100,
            creator_fee_basis_points: 50,
            token_total_supply: 1_000_000_000_000_000,
            initial_real_token_reserves: 793_100_000_000_000,
            pool_migration_fee: 6_900_000_000,
            ..Default::default()
        })
    }

    fn fixture_bonding_curve(creator: Pubkey) -> BondingCurve {
        BondingCurve::new(BondingCurveFromIdl {
            virtual_token_reserves: 1_073_000_000_000_000,
            virtual_quote_reserves: 30_000_000_000,
            real_token_reserves: 793_100_000_000_000,
            real_quote_reserves: 0,
            token_total_supply: 1_000_000_000_000_000,
            complete: false,
            creator,
            is_mayhem_mode: false,
            is_cashback_coin: false,
            quote_mint: constants::NATIVE_MINT,
        })
    }

    fn fixture_amm_global_config() -> GlobalConfig {
        GlobalConfig::new(GlobalConfigFromIdl {
            lp_fee_basis_points: 20,
            protocol_fee_basis_points: 5,
            coin_creator_fee_basis_points: 5,
            ..Default::default()
        })
    }

    fn fixture_pool(coin_creator: Pubkey) -> Pool {
        Pool::new(PoolFromIdl {
            base_mint: fake_pubkey(0xAA),
            creator: fake_pubkey(0xBB),
            coin_creator,
            quote_mint: constants::NATIVE_MINT,
            ..Default::default()
        })
    }

    #[test]
    fn bc_buy_sol_in_matches_ts() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let bc = fixture_bonding_curve(fake_pubkey(7));
        let q = sdk
            .buy_quote_bonding_curve_sol_in(
                &g,
                None,
                &bc,
                g.token_total_supply,
                1_000_000_000, // 1 SOL
                100,           // 1% slippage
            )
            .unwrap();
        assert_eq!(q.amount, 34_117_646_995_895);
        assert_eq!(q.min_out, 33_776_470_525_936);
        assert_eq!(q.input_amount_used, 1_000_000_000);
        assert_eq!(q.max_input, 1_000_000_000);
    }

    #[test]
    fn bc_buy_token_out_matches_ts() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let bc = fixture_bonding_curve(fake_pubkey(7));
        let q = sdk
            .buy_quote_bonding_curve_token_out(
                &g,
                None,
                &bc,
                g.token_total_supply,
                100_000_000_000_000,
                200, // 2% slippage
            )
            .unwrap();
        assert_eq!(q.amount, 3_129_496_404);
        assert_eq!(q.max_input, 3_192_086_332);
        assert_eq!(q.min_out, 100_000_000_000_000);
        assert_eq!(q.input_amount_used, 100_000_000_000_000);
    }

    #[test]
    fn bc_sell_with_creator_matches_ts() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let bc = fixture_bonding_curve(fake_pubkey(7));
        let q = sdk
            .sell_quote_bonding_curve(
                &g,
                None,
                &bc,
                g.token_total_supply,
                50_000_000_000_000,
                50, // 0.5% slippage
            )
            .unwrap();
        assert_eq!(q.amount, 1_315_672_305);
        assert_eq!(q.min_out, 1_309_093_943);
    }

    #[test]
    fn bc_sell_default_creator_skips_creator_fee() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let bc = fixture_bonding_curve(Pubkey::default());
        let q = sdk
            .sell_quote_bonding_curve(&g, None, &bc, g.token_total_supply, 50_000_000_000_000, 0)
            .unwrap();
        assert_eq!(q.amount, 1_322_350_845);
    }

    #[test]
    fn amm_buy_sol_in_matches_ts() {
        let sdk = PumpSdk::new();
        let gc = fixture_amm_global_config();
        let pool = fixture_pool(fake_pubkey(0xCC));
        let q = sdk
            .buy_quote_amm_sol_in(
                &gc,
                None,
                AmmQuoteSource::Pool {
                    pool: &pool,
                    base_reserve: 200_000_000_000_000,
                    quote_reserve: 30_000_000_000,
                    base_mint_supply: 1_000_000_000_000_000,
                },
                1_000_000_000,
                100,
            )
            .unwrap();
        assert_eq!(q.amount, 6_432_936_635_069);
        assert_eq!(q.min_out, 6_368_607_268_718);
        assert_eq!(q.max_input, 1_010_000_000);
    }

    #[test]
    fn amm_buy_token_out_matches_ts() {
        let sdk = PumpSdk::new();
        let gc = fixture_amm_global_config();
        let pool = fixture_pool(fake_pubkey(0xCC));
        let q = sdk
            .buy_quote_amm_token_out(
                &gc,
                None,
                AmmQuoteSource::Pool {
                    pool: &pool,
                    base_reserve: 200_000_000_000_000,
                    quote_reserve: 30_000_000_000,
                    base_mint_supply: 1_000_000_000_000_000,
                },
                1_000_000_000_000,
                100,
            )
            .unwrap();
        assert_eq!(q.amount, 151_206_031);
        assert_eq!(q.max_input, 152_718_091);
    }

    #[test]
    fn amm_sell_with_coin_creator_matches_ts() {
        let sdk = PumpSdk::new();
        let gc = fixture_amm_global_config();
        let pool = fixture_pool(fake_pubkey(0xCC));
        let q = sdk
            .sell_quote_amm(
                &gc,
                None,
                AmmQuoteSource::Pool {
                    pool: &pool,
                    base_reserve: 200_000_000_000_000,
                    quote_reserve: 30_000_000_000,
                    base_mint_supply: 1_000_000_000_000_000,
                },
                1_000_000_000_000,
                100,
            )
            .unwrap();
        assert_eq!(q.amount, 148_805_969);
        assert_eq!(q.min_out, 147_317_909);
    }

    #[test]
    fn amm_sell_default_coin_creator_skips_creator_fee() {
        let sdk = PumpSdk::new();
        let gc = fixture_amm_global_config();
        let pool = fixture_pool(Pubkey::default());
        let q = sdk
            .sell_quote_amm(
                &gc,
                None,
                AmmQuoteSource::Pool {
                    pool: &pool,
                    base_reserve: 200_000_000_000_000,
                    quote_reserve: 30_000_000_000,
                    base_mint_supply: 1_000_000_000_000_000,
                },
                1_000_000_000_000,
                0,
            )
            .unwrap();
        assert_eq!(q.amount, 148_880_596);
    }

    #[test]
    fn zero_input_returns_zero() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let bc = fixture_bonding_curve(fake_pubkey(7));
        let q = sdk
            .buy_quote_bonding_curve_sol_in(&g, None, &bc, g.token_total_supply, 0, 100)
            .unwrap();
        assert_eq!(q.amount, 0);
        let q = sdk
            .sell_quote_bonding_curve(&g, None, &bc, g.token_total_supply, 0, 100)
            .unwrap();
        assert_eq!(q.amount, 0);
    }

    #[test]
    fn migrated_curve_returns_zero() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let mut bc = fixture_bonding_curve(fake_pubkey(7));
        bc.virtual_token_reserves = 0;
        let q = sdk
            .buy_quote_bonding_curve_sol_in(&g, None, &bc, g.token_total_supply, 1_000_000_000, 0)
            .unwrap();
        assert_eq!(q.amount, 0);
    }

    #[test]
    fn amm_empty_reserves_errors() {
        let sdk = PumpSdk::new();
        let gc = fixture_amm_global_config();
        let pool = fixture_pool(fake_pubkey(0xCC));
        let err = sdk
            .buy_quote_amm_sol_in(
                &gc,
                None,
                AmmQuoteSource::Pool {
                    pool: &pool,
                    base_reserve: 0,
                    quote_reserve: 1_000,
                    base_mint_supply: 1_000,
                },
                1,
                0,
            )
            .unwrap_err();
        assert_eq!(err, QuoteError::EmptyReserves);
        let err = sdk
            .sell_quote_amm(
                &gc,
                None,
                AmmQuoteSource::Pool {
                    pool: &pool,
                    base_reserve: 1_000,
                    quote_reserve: 0,
                    base_mint_supply: 1_000,
                },
                1,
                0,
            )
            .unwrap_err();
        assert_eq!(err, QuoteError::EmptyReserves);
    }

    #[test]
    fn amm_buy_token_out_oversize_errors() {
        let sdk = PumpSdk::new();
        let gc = fixture_amm_global_config();
        let pool = fixture_pool(fake_pubkey(0xCC));
        let err = sdk
            .buy_quote_amm_token_out(
                &gc,
                None,
                AmmQuoteSource::Pool {
                    pool: &pool,
                    base_reserve: 1_000,
                    quote_reserve: 1_000,
                    base_mint_supply: 1_000_000,
                },
                1_000,
                0,
            )
            .unwrap_err();
        assert_eq!(err, QuoteError::BaseOutExceedsReserve);
        let err = sdk
            .buy_quote_amm_token_out(
                &gc,
                None,
                AmmQuoteSource::Pool {
                    pool: &pool,
                    base_reserve: 1_000,
                    quote_reserve: 1_000,
                    base_mint_supply: 1_000_000,
                },
                5_000,
                0,
            )
            .unwrap_err();
        assert_eq!(err, QuoteError::BaseOutExceedsReserve);
    }

    #[test]
    fn bc_token_out_buy_at_real_reserves_errors() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let mut bc = fixture_bonding_curve(fake_pubkey(7));
        bc.real_token_reserves = bc.virtual_token_reserves;
        let err = sdk
            .buy_quote_bonding_curve_token_out(
                &g,
                None,
                &bc,
                g.token_total_supply,
                bc.virtual_token_reserves,
                0,
            )
            .unwrap_err();
        assert_eq!(err, QuoteError::DepletedBondingCurve);
    }

    #[test]
    fn amm_quote_bonding_curve_complete_underflow_errors() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let gc = fixture_amm_global_config();
        let bc = fixture_bonding_curve(fake_pubkey(7)); // real_quote_reserves = 0
        let base_mint = fake_pubkey(0xAA);
        let err = sdk
            .buy_quote_amm_sol_in(
                &gc,
                None,
                AmmQuoteSource::BondingCurveComplete {
                    global: &g,
                    bonding_curve: &bc,
                    base_mint: &base_mint,
                    base_mint_supply: g.token_total_supply,
                },
                1_000_000_000,
                0,
            )
            .unwrap_err();
        assert_eq!(err, QuoteError::EmptyReserves);
    }

    #[test]
    fn amm_quote_bonding_curve_complete_matches_formula() {
        let sdk = PumpSdk::new();
        let g = fixture_global();
        let gc = fixture_amm_global_config();
        let mut bc = fixture_bonding_curve(fake_pubkey(7));
        bc.real_quote_reserves = 100_000_000_000;
        let base_mint = fake_pubkey(0xAA);

        let q = sdk
            .buy_quote_amm_sol_in(
                &gc,
                None,
                AmmQuoteSource::BondingCurveComplete {
                    global: &g,
                    bonding_curve: &bc,
                    base_mint: &base_mint,
                    base_mint_supply: g.token_total_supply,
                },
                1_000_000_000,
                0,
            )
            .unwrap();

        let base_reserve = g.token_total_supply - g.initial_real_token_reserves;
        let quote_reserve = bc.real_quote_reserves - g.pool_migration_fee;
        let pool_creator = pda::pump::pool_authority(&base_mint).0;
        let ctx = AmmContext {
            global_config: &gc,
            fee_config: None,
            base_mint: &base_mint,
            pool_creator: &pool_creator,
            coin_creator: &bc.creator,
            base_reserve,
            quote_reserve,
            base_mint_supply: g.token_total_supply,
        };
        let expected = amm_math::buy_quote_input(&ctx, 1_000_000_000)
            .unwrap()
            .base_amount_out;
        assert_eq!(q.amount, expected);
    }
}
