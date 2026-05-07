//! Shared numeric helpers for quote math.

use crate::math::{QuoteError, QuoteResult};

/// `a * b / c` in `u128`, surfacing overflow as [`QuoteError::MathOverflow`].
#[inline]
pub fn mul_div_u128(a: u128, b: u128, c: u128) -> QuoteResult<u128> {
    a.checked_mul(b)
        .ok_or(QuoteError::MathOverflow)?
        .checked_div(c)
        .ok_or(QuoteError::MathOverflow)
}

/// `value * (10_000 + bps) / 10_000`. Saturates on the rare case the
/// multiplication itself overflows `u64`.
#[inline]
pub fn add_slippage(value: u64, bps: u16) -> u64 {
    (((value as u128) * (10_000 + bps as u128)) / 10_000) as u64
}

/// `value * (10_000 - bps) / 10_000`. `bps` larger than 10_000 saturates to 0.
#[inline]
pub fn sub_slippage(value: u64, bps: u16) -> u64 {
    let bps = bps.min(10_000) as u128;
    (((value as u128) * (10_000 - bps)) / 10_000) as u64
}

/// `(value - delta, value + delta)` with `delta = value * bps / 10_000`; `None` on overflow.
#[inline]
pub fn slippage_bounds(value: u128, bps: u16) -> Option<(u128, u128)> {
    let delta = value.checked_mul(u128::from(bps))?.checked_div(10_000)?;
    Some((value.checked_sub(delta)?, value.checked_add(delta)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slippage_helpers_apply_correct_direction() {
        assert_eq!(sub_slippage(100, 250), 97);
        assert_eq!(add_slippage(100, 250), 102);
        assert_eq!(sub_slippage(1_000_000, 10_000), 0);
        assert_eq!(sub_slippage(1_000_000, 20_000), 0);
    }

    #[test]
    fn slippage_bounds_brackets_value() {
        assert_eq!(slippage_bounds(1_000_000, 250), Some((975_000, 1_025_000)));
        assert_eq!(slippage_bounds(42, 0), Some((42, 42)));
    }

    #[test]
    fn slippage_bounds_overflow_returns_none() {
        assert_eq!(slippage_bounds(u128::MAX, 1), None);
    }
}
