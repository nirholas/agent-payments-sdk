//! Fee math for bonding-curve and AMM quotes (basis points as `u64`).

use solana_program::pubkey::Pubkey;

use crate::pda;
use crate::pump::types::{FeeTier, Fees};
use crate::state::pump_amm::GlobalConfig;
use crate::state::{FeeConfig, Global};

/// `ceil(a / b)` for non-zero `b`.
#[inline]
pub fn ceil_div(a: u128, b: u128) -> u128 {
    a.div_ceil(b)
}

/// `ceil(amount * basis_points / 10_000)`.
#[inline]
pub fn fee_amount(amount: u128, basis_points: u64) -> u128 {
    ceil_div(amount * basis_points as u128, 10_000)
}

/// `fee_amount(amount, basis_points)`, or `0` when `creator` is `Pubkey::default()`
/// (the convention for "no creator fee on this trade").
#[inline]
pub fn creator_fee_amount(creator: &Pubkey, amount: u128, basis_points: u64) -> u128 {
    if *creator == Pubkey::default() {
        0
    } else {
        fee_amount(amount, basis_points)
    }
}

/// Bonding-curve market cap in lamports.
/// `marketCap = virtualQuoteReserves * mintSupply / virtualTokenReserves`.
#[inline]
pub fn bonding_curve_market_cap(
    mint_supply: u64,
    virtual_quote_reserves: u64,
    virtual_token_reserves: u64,
) -> u128 {
    debug_assert!(virtual_token_reserves != 0);
    (virtual_quote_reserves as u128) * (mint_supply as u128) / (virtual_token_reserves as u128)
}

/// AMM pool market cap in lamports.
/// `marketCap = quoteReserve * baseMintSupply / baseReserve`.
#[inline]
pub fn pool_market_cap(base_mint_supply: u64, base_reserve: u64, quote_reserve: u64) -> u128 {
    debug_assert!(base_reserve != 0);
    (quote_reserve as u128) * (base_mint_supply as u128) / (base_reserve as u128)
}

/// `true` iff `pool_creator` matches the canonical pump-program-derived pool
/// authority for `base_mint`. Used to decide whether a pool gets tiered fees
/// (pump pools) or flat fees (third-party pools).
pub fn is_pump_pool(base_mint: &Pubkey, pool_creator: &Pubkey) -> bool {
    &pda::pump::pool_authority(base_mint).0 == pool_creator
}

/// Bonding-curve fees split into protocol and creator components. The
/// AMM-style LP fee is not part of the bonding-curve fee model.
#[derive(Clone, Copy, Debug)]
pub struct BondingCurveFeeBps {
    pub protocol_fee_bps: u64,
    pub creator_fee_bps: u64,
}

/// AMM fees split into LP, protocol, and coin-creator components.
#[derive(Clone, Copy, Debug)]
pub struct AmmFeeBps {
    pub lp_fee_bps: u64,
    pub protocol_fee_bps: u64,
    pub creator_fee_bps: u64,
}

/// Highest tier with threshold `<= market_cap`, else first tier.
fn calculate_pump_fee_tier(tiers: &[FeeTier], market_cap: u128) -> &Fees {
    let first = &tiers[0].fees;
    if market_cap < tiers[0].market_cap_lamports_threshold {
        return first;
    }
    for tier in tiers.iter().rev() {
        if market_cap >= tier.market_cap_lamports_threshold {
            return &tier.fees;
        }
    }
    first
}

fn calculate_amm_fee_tier(tiers: &[FeeTier], market_cap: u128) -> &Fees {
    let first = &tiers[0].fees;
    if market_cap < tiers[0].market_cap_lamports_threshold {
        return first;
    }
    for tier in tiers.iter().rev() {
        if market_cap >= tier.market_cap_lamports_threshold {
            return &tier.fees;
        }
    }
    first
}

/// Resolve the bps for a bonding-curve trade. When `fee_config` is `None`,
/// fall back to the flat fees on `Global`. When provided, use the tiered
/// fees indexed by current market cap.
pub fn compute_bonding_curve_fee_bps(
    global: &Global,
    fee_config: Option<&FeeConfig>,
    mint_supply: u64,
    virtual_quote_reserves: u64,
    virtual_token_reserves: u64,
) -> BondingCurveFeeBps {
    if let Some(cfg) = fee_config {
        let market_cap =
            bonding_curve_market_cap(mint_supply, virtual_quote_reserves, virtual_token_reserves);
        let fees = calculate_pump_fee_tier(&cfg.fee_tiers, market_cap);
        BondingCurveFeeBps {
            protocol_fee_bps: fees.protocol_fee_bps,
            creator_fee_bps: fees.creator_fee_bps,
        }
    } else {
        BondingCurveFeeBps {
            protocol_fee_bps: global.fee_basis_points,
            creator_fee_bps: global.creator_fee_basis_points,
        }
    }
}

/// AMM trade fee bps: tiered for pump pools, `flat_fees` for others, else globals.
pub fn compute_amm_fee_bps(
    global_config: &GlobalConfig,
    fee_config: Option<&FeeConfig>,
    base_mint: &Pubkey,
    pool_creator: &Pubkey,
    base_mint_supply: u64,
    base_reserve: u64,
    quote_reserve: u64,
) -> AmmFeeBps {
    if let Some(cfg) = fee_config {
        let market_cap = pool_market_cap(base_mint_supply, base_reserve, quote_reserve);
        let fees = if is_pump_pool(base_mint, pool_creator) {
            calculate_amm_fee_tier(&cfg.fee_tiers, market_cap)
        } else {
            &cfg.flat_fees
        };
        AmmFeeBps {
            lp_fee_bps: fees.lp_fee_bps,
            protocol_fee_bps: fees.protocol_fee_bps,
            creator_fee_bps: fees.creator_fee_bps,
        }
    } else {
        AmmFeeBps {
            lp_fee_bps: global_config.lp_fee_basis_points,
            protocol_fee_bps: global_config.protocol_fee_basis_points,
            creator_fee_bps: global_config.coin_creator_fee_basis_points,
        }
    }
}
