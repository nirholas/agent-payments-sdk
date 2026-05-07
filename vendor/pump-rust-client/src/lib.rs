//! Rust SDK for the pump and pump_amm programs.
//!
//! Default features pull in `solana-client` for [`AsyncPumpClient`]. For CPI-only
//! use, set `default-features = false` (instruction helpers use `solana-program`).

pub mod pump {
    use anchor_lang::declare_program;
    declare_program!(pump);
    // We export accounts from state, which are wrapped for better deseralization
    pub(crate) use pump::accounts;
    pub use pump::{client, constants, cpi, events, program, types, utils, ID, ID_CONST};
}
pub mod pump_amm {
    use anchor_lang::declare_program;
    declare_program!(pump_amm);
    // We export accounts from state, which are wrapped for better deseralization
    pub(crate) use pump_amm::accounts;
    pub use pump_amm::{client, constants, cpi, events, program, types, utils, ID, ID_CONST};
}
pub mod pump_agent_payments {
    use anchor_lang::declare_program;
    declare_program!(pump_agent_payments);
    // We export accounts from state, which are wrapped for better deseralization
    pub(crate) use pump_agent_payments::accounts;
    pub use pump_agent_payments::{
        client, constants, cpi, events, program, types, utils, ID, ID_CONST,
    };
}

pub mod account_wrapper;
pub mod accounts;
#[cfg(feature = "client")]
pub mod async_client;
pub mod constants;
pub mod errors;
pub mod math;
pub mod pda;
pub mod sdk;
pub mod state;
pub mod token;

pub use account_wrapper::AccountWrapper;
pub use accounts::decode;
#[cfg(feature = "client")]
pub use async_client::{AsyncPumpClient, ComputeBudget};
pub use errors::{PumpClientError, Result};
pub use sdk::{
    AmmQuoteSource, CreateCoinParams, PumpPoolCtx, PumpPoolQuoteCtx, PumpSdk, Quote,
    TradeQuoteParams, TradeTxParams, TradeTxWithVenueParams, TradeVenue,
};
