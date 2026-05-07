//! Bonding-curve and AMM quote math (`u128` intermediates, `u64` at the boundary).

pub mod amm;
pub mod bonding_curve;
pub mod fees;
pub mod utils;

pub use bonding_curve::TOKEN_SUPPLY;

/// Quote failure modes (empty reserves, bad inputs, fee overflow, etc.).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteError {
    /// `base_reserve` or `quote_reserve` is zero, so the pool cannot price
    /// any trade.
    EmptyReserves,
    /// Caller asked for `base_out` >= `base_reserve` on a buy. Equivalent
    /// to draining the pool; the constant-product denominator would be
    /// `<= 0`.
    BaseOutExceedsReserve,
    /// Sum of LP, protocol, and coin-creator fees exceeds the raw quote
    /// output — only reachable with a degenerate fee table whose total bps
    /// > 10_000.
    FeesExceedOutput,
    /// Bonding curve degeneracy where `real_token_reserves ==
    /// virtual_token_reserves`, which would zero the constant-product
    /// denominator on a token-out buy.
    DepletedBondingCurve,
    /// A `u128` intermediate overflowed, or a subtraction would underflow
    /// (e.g. `sol_out >= virtual_sol_reserves` on the `sell_token_quote_with_sol`
    /// inverse). Surfaced from the fee-less primitive quote helpers so callers
    /// don't need to wrap primitive arithmetic.
    MathOverflow,
    /// Observed market cap fell outside the caller's `target ± slippage_bps`
    /// envelope. Returned by `validate_market_cap` on both quote paths.
    SlippageExceeded,
}

impl std::fmt::Display for QuoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyReserves => write!(f, "pool reserves are zero"),
            Self::BaseOutExceedsReserve => {
                write!(f, "base_out exceeds the pool's base reserve")
            }
            Self::FeesExceedOutput => write!(f, "fees exceed the pool's quote output"),
            Self::DepletedBondingCurve => {
                write!(f, "bonding curve is depleted (real == virtual reserves)")
            }
            Self::MathOverflow => write!(f, "checked arithmetic overflowed"),
            Self::SlippageExceeded => {
                write!(f, "market cap fell outside the slippage envelope")
            }
        }
    }
}

impl std::error::Error for QuoteError {}

pub type QuoteResult<T> = std::result::Result<T, QuoteError>;
