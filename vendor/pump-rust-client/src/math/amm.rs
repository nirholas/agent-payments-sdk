//! AMM (pump-swap) quote helpers.

use solana_program::pubkey::Pubkey;

use crate::math::bonding_curve::TOKEN_SUPPLY;
use crate::math::fees::{ceil_div, compute_amm_fee_bps, creator_fee_amount, fee_amount, AmmFeeBps};
use crate::math::utils::{mul_div_u128, slippage_bounds};
use crate::math::{QuoteError, QuoteResult};
use crate::state::FeeConfig;
use crate::state::pump_amm::{ GlobalConfig};

pub struct BuyQuoteInputResult {
    pub base_amount_out: u64,
    pub effective_quote: u64,
}

pub struct BuyBaseInputResult {
    pub total_quote_in: u64,
    pub raw_quote_in: u64,
}

pub struct SellBaseInputResult {
    pub final_quote_out: u64,
    pub raw_quote_out: u64,
}

/// Common AMM trade context. `pool_creator` is the pool's anchor `creator`
/// field; `coin_creator` is the per-coin creator that receives the
/// coin-creator fee slice (set to `Pubkey::default()` to skip the slice).
pub struct AmmContext<'a> {
    pub global_config: &'a GlobalConfig,
    pub fee_config: Option<&'a FeeConfig>,
    pub base_mint: &'a Pubkey,
    pub pool_creator: &'a Pubkey,
    pub coin_creator: &'a Pubkey,
    pub base_reserve: u64,
    pub quote_reserve: u64,
    pub base_mint_supply: u64,
}

impl AmmContext<'_> {
    fn check_reserves(&self) -> QuoteResult<()> {
        if self.base_reserve == 0 || self.quote_reserve == 0 {
            return Err(QuoteError::EmptyReserves);
        }
        Ok(())
    }
}

/// AMM buy: caller specifies SOL input, gets tokens out.
pub fn buy_quote_input(ctx: &AmmContext<'_>, quote_in: u64) -> QuoteResult<BuyQuoteInputResult> {
    ctx.check_reserves()?;

    let AmmFeeBps {
        lp_fee_bps,
        protocol_fee_bps,
        creator_fee_bps,
    } = compute_amm_fee_bps(
        ctx.global_config,
        ctx.fee_config,
        ctx.base_mint,
        ctx.pool_creator,
        ctx.base_mint_supply,
        ctx.base_reserve,
        ctx.quote_reserve,
    );
    let coin_creator_bps = if *ctx.coin_creator == Pubkey::default() {
        0
    } else {
        creator_fee_bps
    };

    let total_fee_bps = lp_fee_bps + protocol_fee_bps + coin_creator_bps;
    let denom = 10_000u128 + total_fee_bps as u128;

    let effective_quote = (quote_in as u128) * 10_000 / denom;
    let base_out = (ctx.base_reserve as u128) * effective_quote
        / ((ctx.quote_reserve as u128) + effective_quote);

    Ok(BuyQuoteInputResult {
        base_amount_out: base_out as u64,
        effective_quote: effective_quote as u64,
    })
}

/// AMM buy: caller specifies desired tokens out, gets total SOL cost.
pub fn buy_base_input(ctx: &AmmContext<'_>, base_out: u64) -> QuoteResult<BuyBaseInputResult> {
    ctx.check_reserves()?;
    if base_out >= ctx.base_reserve {
        return Err(QuoteError::BaseOutExceedsReserve);
    }

    let numerator = (ctx.quote_reserve as u128) * (base_out as u128);
    let denominator = (ctx.base_reserve as u128) - (base_out as u128);
    let raw_quote = ceil_div(numerator, denominator);

    let AmmFeeBps {
        lp_fee_bps,
        protocol_fee_bps,
        creator_fee_bps,
    } = compute_amm_fee_bps(
        ctx.global_config,
        ctx.fee_config,
        ctx.base_mint,
        ctx.pool_creator,
        ctx.base_mint_supply,
        ctx.base_reserve,
        ctx.quote_reserve,
    );

    let lp = fee_amount(raw_quote, lp_fee_bps);
    let protocol = fee_amount(raw_quote, protocol_fee_bps);
    let coin_creator = creator_fee_amount(ctx.coin_creator, raw_quote, creator_fee_bps);
    let total = raw_quote + lp + protocol + coin_creator;

    Ok(BuyBaseInputResult {
        total_quote_in: total as u64,
        raw_quote_in: raw_quote as u64,
    })
}

/// AMM sell: caller specifies tokens in, gets net SOL out.
pub fn sell_base_input(ctx: &AmmContext<'_>, base_in: u64) -> QuoteResult<SellBaseInputResult> {
    ctx.check_reserves()?;

    let raw_quote = (ctx.quote_reserve as u128) * (base_in as u128)
        / ((ctx.base_reserve as u128) + (base_in as u128));

    let AmmFeeBps {
        lp_fee_bps,
        protocol_fee_bps,
        creator_fee_bps,
    } = compute_amm_fee_bps(
        ctx.global_config,
        ctx.fee_config,
        ctx.base_mint,
        ctx.pool_creator,
        ctx.base_mint_supply,
        ctx.base_reserve,
        ctx.quote_reserve,
    );

    let lp = fee_amount(raw_quote, lp_fee_bps);
    let protocol = fee_amount(raw_quote, protocol_fee_bps);
    let coin_creator = creator_fee_amount(ctx.coin_creator, raw_quote, creator_fee_bps);
    let total_fee = lp + protocol + coin_creator;
    if raw_quote < total_fee {
        return Err(QuoteError::FeesExceedOutput);
    }
    let final_quote = raw_quote - total_fee;

    Ok(SellBaseInputResult {
        final_quote_out: final_quote as u64,
        raw_quote_out: raw_quote as u64,
    })
}

/// Constant-product sell quote, fees not applied.
/// `out = amount * pool_quote / (pool_base + amount)`.
pub fn sell_quote(
    pool_base_token_reserves: u64,
    pool_quote_token_reserves: u64,
    amount: u64,
) -> QuoteResult<u128> {
    let amount = u128::from(amount);
    let v_quote = u128::from(pool_quote_token_reserves);
    let v_base = u128::from(pool_base_token_reserves);
    let denom = v_base.checked_add(amount).ok_or(QuoteError::MathOverflow)?;
    mul_div_u128(amount, v_quote, denom)
}

/// Pure constant-product buy quote on an AMM pool, no fees applied.
/// `out = sol_amount * pool_base / (pool_quote + sol_amount)`.
pub fn buy_token_quote_with_sol(
    pool_base_token_reserves: u64,
    pool_quote_token_reserves: u64,
    sol_amount: u64,
) -> QuoteResult<u128> {
    let sol_amount = u128::from(sol_amount);
    let v_quote = u128::from(pool_quote_token_reserves);
    let v_base = u128::from(pool_base_token_reserves);
    let denom = v_quote
        .checked_add(sol_amount)
        .ok_or(QuoteError::MathOverflow)?;
    mul_div_u128(sol_amount, v_base, denom)
}

/// Inverse of [`sell_quote`]: given a desired SOL output, how many tokens
/// must be sold. `out = sol_amount * pool_base / (pool_quote - sol_amount)`.
///
/// Returns [`QuoteError::MathOverflow`] if `sol_amount >= pool_quote_token_reserves`.
pub fn sell_token_quote_with_sol(
    pool_base_token_reserves: u64,
    pool_quote_token_reserves: u64,
    sol_amount: u64,
) -> QuoteResult<u128> {
    let sol_amount = u128::from(sol_amount);
    let v_quote = u128::from(pool_quote_token_reserves);
    let v_base = u128::from(pool_base_token_reserves);
    let denom = v_quote
        .checked_sub(sol_amount)
        .ok_or(QuoteError::MathOverflow)?;
    mul_div_u128(sol_amount, v_base, denom)
}

/// Validate that the AMM pool's current market cap is within
/// `target_market_cap ± slippage_bps`. Uses the fixed [`TOKEN_SUPPLY`] for
/// market-cap derivation: `mcap = TOKEN_SUPPLY * pool_quote / pool_base`.
pub fn validate_market_cap(
    pool_base_token_reserves: u64,
    pool_quote_token_reserves: u64,
    target_market_cap: u128,
    slippage_bps: u16,
) -> QuoteResult<()> {
    let v_quote = u128::from(pool_quote_token_reserves);
    let v_base = u128::from(pool_base_token_reserves);

    let current = mul_div_u128(TOKEN_SUPPLY, v_quote, v_base)?;

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

    const POOL_QUOTE: u64 = 100_000_000_000;
    const POOL_BASE: u64 = 800_000_000_000_000;

    #[test]
    fn sell_quote_matches_constant_product() {
        let amount: u64 = 1_000_000_000_000;
        let out = sell_quote(POOL_BASE, POOL_QUOTE, amount).unwrap();
        let expected =
            (amount as u128) * (POOL_QUOTE as u128) / ((POOL_BASE as u128) + amount as u128);
        assert_eq!(out, expected);
    }

    #[test]
    fn buy_and_sell_token_quote_with_sol_use_correct_denominators() {
        let sol_in: u64 = 1_000_000_000;
        let bought = buy_token_quote_with_sol(POOL_BASE, POOL_QUOTE, sol_in).unwrap();
        let expected =
            (sol_in as u128) * (POOL_BASE as u128) / ((POOL_QUOTE as u128) + sol_in as u128);
        assert_eq!(bought, expected);

        let inv = sell_token_quote_with_sol(POOL_BASE, POOL_QUOTE, sol_in).unwrap();
        let expected_inv =
            (sol_in as u128) * (POOL_BASE as u128) / ((POOL_QUOTE as u128) - sol_in as u128);
        assert_eq!(inv, expected_inv);
    }

    #[test]
    fn sell_token_quote_overflow_when_sol_exceeds_reserve() {
        assert_eq!(
            sell_token_quote_with_sol(POOL_BASE, POOL_QUOTE, POOL_QUOTE),
            Err(QuoteError::MathOverflow)
        );
        assert_eq!(
            sell_token_quote_with_sol(POOL_BASE, POOL_QUOTE, POOL_QUOTE + 1),
            Err(QuoteError::MathOverflow)
        );
    }

    #[test]
    fn validate_market_cap_passes_within_envelope() {
        let current = TOKEN_SUPPLY * (POOL_QUOTE as u128) / (POOL_BASE as u128);
        validate_market_cap(POOL_BASE, POOL_QUOTE, current, 0).unwrap();
        validate_market_cap(POOL_BASE, POOL_QUOTE, current * 99 / 100, 200).unwrap();
    }

    #[test]
    fn validate_market_cap_fails_outside_envelope() {
        let current = TOKEN_SUPPLY * (POOL_QUOTE as u128) / (POOL_BASE as u128);
        assert_eq!(
            validate_market_cap(POOL_BASE, POOL_QUOTE, current * 95 / 100, 100),
            Err(QuoteError::SlippageExceeded)
        );
    }
}
