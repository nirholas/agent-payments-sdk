//! Bonding-curve buy/sell quotes.

use solana_program::pubkey::Pubkey;

use crate::math::fees::{
    compute_bonding_curve_fee_bps, creator_fee_amount, fee_amount, BondingCurveFeeBps,
};
use crate::math::utils::{mul_div_u128, slippage_bounds};
use crate::math::{QuoteError, QuoteResult};
use crate::state::{BondingCurve, FeeConfig, Global};

/// Fixed curve supply: 1B tokens × 10^6 decimals (used by [`validate_market_cap`]).
pub const TOKEN_SUPPLY: u128 = 1_000_000_000_000_000;

/// Tokens received for a SOL input on the bonding curve, after fees.
/// Caps at `bonding_curve.real_token_reserves` like the on-chain program.
///
/// Returns `Ok(0)` for zero input or for a migrated curve
/// (`virtual_token_reserves == 0`).
pub fn buy_token_amount_from_sol_amount(
    global: &Global,
    fee_config: Option<&FeeConfig>,
    bonding_curve: &BondingCurve,
    mint_supply: u64,
    sol_amount: u64,
) -> QuoteResult<u64> {
    if sol_amount == 0 || bonding_curve.virtual_token_reserves == 0 {
        return Ok(0);
    }
    if bonding_curve.virtual_quote_reserves == 0 {
        return Err(QuoteError::EmptyReserves);
    }

    let BondingCurveFeeBps {
        protocol_fee_bps,
        creator_fee_bps,
    } = compute_bonding_curve_fee_bps(
        global,
        fee_config,
        mint_supply,
        bonding_curve.virtual_quote_reserves,
        bonding_curve.virtual_token_reserves,
    );

    let total_fee_bps = protocol_fee_bps
        + if bonding_curve.creator != Pubkey::default() {
            creator_fee_bps
        } else {
            0
        };

    let input_amount = (sol_amount as u128 - 1) * 10_000 / (total_fee_bps as u128 + 10_000);

    let tokens = input_amount * (bonding_curve.virtual_token_reserves as u128)
        / (bonding_curve.virtual_quote_reserves as u128 + input_amount);

    let capped = tokens.min(bonding_curve.real_token_reserves as u128);
    Ok(capped as u64)
}

/// SOL needed to buy a desired token amount on the bonding curve, including
/// fees. Caller-side amount is capped at `real_token_reserves` like the
/// on-chain program.
///
/// Returns `Ok(0)` for zero input or for a migrated curve. Returns
/// `Err(DepletedBondingCurve)` if the capped trade size would empty the
/// curve.
pub fn buy_sol_amount_from_token_amount(
    global: &Global,
    fee_config: Option<&FeeConfig>,
    bonding_curve: &BondingCurve,
    mint_supply: u64,
    token_amount: u64,
) -> QuoteResult<u64> {
    if token_amount == 0 || bonding_curve.virtual_token_reserves == 0 {
        return Ok(0);
    }

    let min_amount = (token_amount as u128).min(bonding_curve.real_token_reserves as u128);
    if min_amount >= bonding_curve.virtual_token_reserves as u128 {
        return Err(QuoteError::DepletedBondingCurve);
    }

    let sol_cost = min_amount * (bonding_curve.virtual_quote_reserves as u128)
        / ((bonding_curve.virtual_token_reserves as u128) - min_amount)
        + 1;

    let fee = fee_for_quote(global, fee_config, bonding_curve, mint_supply, sol_cost);
    Ok((sol_cost + fee) as u64)
}

/// SOL received for selling a token amount on the bonding curve, after
/// subtracting fees.
///
/// Returns `Ok(0)` for zero input or for a migrated curve.
pub fn sell_sol_amount_from_token_amount(
    global: &Global,
    fee_config: Option<&FeeConfig>,
    bonding_curve: &BondingCurve,
    mint_supply: u64,
    token_amount: u64,
) -> QuoteResult<u64> {
    if token_amount == 0 || bonding_curve.virtual_token_reserves == 0 {
        return Ok(0);
    }

    let sol_out = (token_amount as u128) * (bonding_curve.virtual_quote_reserves as u128)
        / ((bonding_curve.virtual_token_reserves as u128) + (token_amount as u128));

    let fee = fee_for_quote(global, fee_config, bonding_curve, mint_supply, sol_out);
    if (sol_out as i128) - (fee as i128) < 0 {
        return Err(QuoteError::FeesExceedOutput);
    }
    Ok((sol_out - fee) as u64)
}

/// Fee in lamports for a quote amount (non-mayhem tiers use fixed 1B supply).
fn fee_for_quote(
    global: &Global,
    fee_config: Option<&FeeConfig>,
    bonding_curve: &BondingCurve,
    mint_supply: u64,
    amount: u128,
) -> u128 {
    let supply_for_tier = if bonding_curve.is_mayhem_mode {
        mint_supply
    } else {
        TOKEN_SUPPLY as u64
    };

    let BondingCurveFeeBps {
        protocol_fee_bps,
        creator_fee_bps,
    } = compute_bonding_curve_fee_bps(
        global,
        fee_config,
        supply_for_tier,
        bonding_curve.virtual_quote_reserves,
        bonding_curve.virtual_token_reserves,
    );

    let protocol = fee_amount(amount, protocol_fee_bps);
    let creator = creator_fee_amount(&bonding_curve.creator, amount, creator_fee_bps);
    protocol + creator
}

/// Constant-product sell on the bonding curve, fees not applied.
/// `out = amount * vSol / (vTokens + amount)`.
///
/// Returns [`QuoteError::MathOverflow`] on `u128` overflow.
pub fn sell_quote(
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    amount: u64,
) -> QuoteResult<u128> {
    let amount = u128::from(amount);
    let v_sol = u128::from(virtual_sol_reserves);
    let v_tokens = u128::from(virtual_token_reserves);
    let denom = v_tokens.checked_add(amount).ok_or(QuoteError::MathOverflow)?;
    mul_div_u128(amount, v_sol, denom)
}

/// Constant-product buy, fees not applied.
/// `out = sol_amount * vTokens / (vSol + sol_amount)`.
///
/// Returns [`QuoteError::MathOverflow`] on `u128` overflow.
pub fn buy_token_quote_with_sol(
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    sol_amount: u64,
) -> QuoteResult<u128> {
    let sol_amount = u128::from(sol_amount);
    let v_sol = u128::from(virtual_sol_reserves);
    let v_tokens = u128::from(virtual_token_reserves);
    let denom = v_sol
        .checked_add(sol_amount)
        .ok_or(QuoteError::MathOverflow)?;
    mul_div_u128(sol_amount, v_tokens, denom)
}

/// Inverse of [`sell_quote`]: given a desired SOL output, how many tokens
/// must be sold. `out = sol_amount * vTokens / (vSol - sol_amount)`.
///
/// Returns [`QuoteError::MathOverflow`] if `sol_amount >= virtual_sol_reserves`
/// (the denominator would be zero or underflow).
pub fn sell_token_quote_with_sol(
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    sol_amount: u64,
) -> QuoteResult<u128> {
    let sol_amount = u128::from(sol_amount);
    let v_sol = u128::from(virtual_sol_reserves);
    let v_tokens = u128::from(virtual_token_reserves);
    let denom = v_sol
        .checked_sub(sol_amount)
        .ok_or(QuoteError::MathOverflow)?;
    mul_div_u128(sol_amount, v_tokens, denom)
}

/// Validate that the bonding curve's current market cap is within
/// `target_market_cap ± slippage_bps`. Uses the fixed [`TOKEN_SUPPLY`] for
/// market-cap derivation: `mcap = TOKEN_SUPPLY * vSol / vTokens`.
///
/// Returns [`QuoteError::SlippageExceeded`] if the observed market cap falls
/// outside the envelope, or [`QuoteError::MathOverflow`] on intermediate
/// overflow.
pub fn validate_market_cap(
    virtual_sol_reserves: u64,
    virtual_token_reserves: u64,
    target_market_cap: u128,
    slippage_bps: u16,
) -> QuoteResult<()> {
    let v_sol = u128::from(virtual_sol_reserves);
    let v_tokens = u128::from(virtual_token_reserves);

    let current = mul_div_u128(TOKEN_SUPPLY, v_sol, v_tokens)?;

    let (min, max) =
        slippage_bounds(target_market_cap, slippage_bps).ok_or(QuoteError::MathOverflow)?;

    if current < min || current > max {
        return Err(QuoteError::SlippageExceeded);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const V_SOL: u64 = 30_000_000_000;
    const V_TOKENS: u64 = 1_073_000_000_000_000;

    #[test]
    fn sell_quote_matches_constant_product() {
        let amount: u64 = 1_000_000_000_000;
        let out = sell_quote(V_SOL, V_TOKENS, amount).unwrap();
        let expected = (amount as u128) * (V_SOL as u128) / ((V_TOKENS as u128) + amount as u128);
        assert_eq!(out, expected);
    }

    #[test]
    fn buy_token_quote_round_trips_with_sell_token_quote() {
        let sol_in: u64 = 1_000_000_000;
        let bought = buy_token_quote_with_sol(V_SOL, V_TOKENS, sol_in).unwrap();
        let expected =
            (sol_in as u128) * (V_TOKENS as u128) / ((V_SOL as u128) + sol_in as u128);
        assert_eq!(bought, expected);

        let inv = sell_token_quote_with_sol(V_SOL, V_TOKENS, sol_in).unwrap();
        let expected_inv =
            (sol_in as u128) * (V_TOKENS as u128) / ((V_SOL as u128) - sol_in as u128);
        assert_eq!(inv, expected_inv);
    }

    #[test]
    fn sell_token_quote_overflow_when_sol_exceeds_reserve() {
        assert_eq!(
            sell_token_quote_with_sol(V_SOL, V_TOKENS, V_SOL),
            Err(QuoteError::MathOverflow)
        );
        assert_eq!(
            sell_token_quote_with_sol(V_SOL, V_TOKENS, V_SOL + 1),
            Err(QuoteError::MathOverflow)
        );
    }

    #[test]
    fn validate_market_cap_passes_within_envelope() {
        let current = TOKEN_SUPPLY * (V_SOL as u128) / (V_TOKENS as u128);
        validate_market_cap(V_SOL, V_TOKENS, current, 0).unwrap();
        validate_market_cap(V_SOL, V_TOKENS, current * 99 / 100, 200).unwrap();
    }

    #[test]
    fn validate_market_cap_fails_outside_envelope() {
        let current = TOKEN_SUPPLY * (V_SOL as u128) / (V_TOKENS as u128);
        assert_eq!(
            validate_market_cap(V_SOL, V_TOKENS, current * 95 / 100, 100),
            Err(QuoteError::SlippageExceeded)
        );
    }
}
