use crate::account_wrapper::AccountWrapper;

// `SharingConfig` is re-exported unwrapped because the IDL-generated struct
// does not derive `Default`, so it cannot satisfy `AccountWrapper`'s
// `AccountDeserialize` bound. Same for `pump_amm::SharingConfig` below.
pub use crate::pump::accounts::SharingConfig;
pub(crate) use crate::pump::accounts::{
    BondingCurve as BondingCurveFromIdl, FeeConfig as FeeConfigFromIdl, Global as GlobalFromIdl,
    GlobalVolumeAccumulator as GlobalVolumeAccumulatorFromIdl,
    UserVolumeAccumulator as UserVolumeAccumulatorFromIdl,
};

pub type BondingCurve = AccountWrapper<BondingCurveFromIdl>;
pub type FeeConfig = AccountWrapper<FeeConfigFromIdl>;
pub type Global = AccountWrapper<GlobalFromIdl>;
pub type GlobalVolumeAccumulator = AccountWrapper<GlobalVolumeAccumulatorFromIdl>;
pub type UserVolumeAccumulator = AccountWrapper<UserVolumeAccumulatorFromIdl>;

pub mod pump_amm {
    use crate::account_wrapper::AccountWrapper;

    pub(crate) use crate::pump_amm::accounts::{
        GlobalConfig as GlobalConfigFromIdl,
        GlobalVolumeAccumulator as GlobalVolumeAccumulatorFromIdl, Pool as PoolFromIdl,
        UserVolumeAccumulator as UserVolumeAccumulatorFromIdl,
    };

    pub type GlobalConfig = AccountWrapper<GlobalConfigFromIdl>;
    pub type GlobalVolumeAccumulator = AccountWrapper<GlobalVolumeAccumulatorFromIdl>;
    pub type Pool = AccountWrapper<PoolFromIdl>;
    pub type UserVolumeAccumulator = AccountWrapper<UserVolumeAccumulatorFromIdl>;
}

pub mod pump_agent_payments {
    use crate::account_wrapper::AccountWrapper;

    pub(crate) use crate::pump_agent_payments::accounts::{
        GlobalConfig as GlobalConfigFromIdl,
        TokenAgentPaymentInCurrency as TokenAgentPaymentInCurrencyIdl,
        TokenAgentPayments as TokenAgentPaymentsIdl,
    };

    pub type GlobalConfig = AccountWrapper<GlobalConfigFromIdl>;
    pub type TokenAgentPaymentInCurrency = AccountWrapper<TokenAgentPaymentInCurrencyIdl>;
    pub type TokenAgentPayments = AccountWrapper<TokenAgentPaymentsIdl>;
}
