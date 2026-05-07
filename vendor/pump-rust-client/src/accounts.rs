//! Account decoders for the pump and pump_amm programs.

use anchor_lang::AccountDeserialize;

use crate::{
    errors::{PumpClientError, Result},
    state::{
        BondingCurve, FeeConfig, Global, GlobalVolumeAccumulator, SharingConfig,
        UserVolumeAccumulator,
    },
};

/// Anchor-deserialize an account buffer. Errors on bad discriminator or
/// truncation. Works for any `T` from `crate::pump::accounts::*` or
/// `crate::pump_amm::accounts::*`.
pub fn decode<T: AccountDeserialize>(data: &[u8]) -> Result<T> {
    T::try_deserialize(&mut &data[..]).map_err(PumpClientError::from)
}

// ----------------------------------------------------------------------
// Named pump-account decoders
// ----------------------------------------------------------------------

pub fn decode_global(data: &[u8]) -> Result<Global> {
    decode::<Global>(data)
}

pub fn decode_fee_config(data: &[u8]) -> Result<FeeConfig> {
    decode::<FeeConfig>(data)
}

pub fn decode_bonding_curve(data: &[u8]) -> Result<BondingCurve> {
    decode::<BondingCurve>(data)
}

pub fn decode_bonding_curve_nullable(data: &[u8]) -> Option<BondingCurve> {
    decode::<BondingCurve>(data).ok()
}

pub fn decode_global_volume_accumulator(data: &[u8]) -> Result<GlobalVolumeAccumulator> {
    decode::<GlobalVolumeAccumulator>(data)
}

pub fn decode_user_volume_accumulator(data: &[u8]) -> Result<UserVolumeAccumulator> {
    decode::<UserVolumeAccumulator>(data)
}

pub fn decode_user_volume_accumulator_nullable(data: &[u8]) -> Option<UserVolumeAccumulator> {
    decode::<UserVolumeAccumulator>(data).ok()
}

pub fn decode_sharing_config(data: &[u8]) -> Result<SharingConfig> {
    decode::<SharingConfig>(data)
}

// ----------------------------------------------------------------------
// Named pump_amm-account decoders
// ----------------------------------------------------------------------

pub mod pump_amm {
    use super::{decode, Result};
    use crate::state::pump_amm::{
        GlobalConfig, GlobalVolumeAccumulator, Pool, UserVolumeAccumulator,
    };

    pub fn decode_global_config(data: &[u8]) -> Result<GlobalConfig> {
        decode::<GlobalConfig>(data)
    }

    pub fn decode_global_volume_accumulator(data: &[u8]) -> Result<GlobalVolumeAccumulator> {
        decode::<GlobalVolumeAccumulator>(data)
    }

    pub fn decode_pool(data: &[u8]) -> Result<Pool> {
        decode::<Pool>(data)
    }

    pub fn decode_user_volume_accumulator(data: &[u8]) -> Result<UserVolumeAccumulator> {
        decode::<UserVolumeAccumulator>(data)
    }
}

// ----------------------------------------------------------------------
// Named pump_agent_payments-account decoders
// ----------------------------------------------------------------------

pub mod pump_agent_payments {
    use super::{decode, Result};
    use crate::state::pump_agent_payments::GlobalConfig;

    pub fn decode_global_config(data: &[u8]) -> Result<GlobalConfig> {
        decode::<GlobalConfig>(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AccountSerialize;
    use solana_program::pubkey::Pubkey;

    use crate::{
        constants,
        state::{BondingCurve, BondingCurveFromIdl},
    };

    fn fake_pubkey(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    #[test]
    fn bonding_curve_round_trip() {
        let original = BondingCurve::new(BondingCurveFromIdl {
            virtual_token_reserves: 1_000_000_000,
            virtual_quote_reserves: 30_000_000_000,
            real_token_reserves: 800_000_000,
            real_quote_reserves: 0,
            token_total_supply: 1_000_000_000_000,
            complete: false,
            creator: fake_pubkey(7),
            is_mayhem_mode: true,
            is_cashback_coin: false,
            quote_mint: constants::NATIVE_MINT,
        });

        let mut buf = Vec::new();
        original.try_serialize(&mut buf).expect("serialize");

        let decoded: BondingCurve = decode(&buf).expect("decode");
        assert_eq!(
            decoded.virtual_token_reserves,
            original.virtual_token_reserves
        );
        assert_eq!(decoded.creator, original.creator);
        assert_eq!(decoded.is_mayhem_mode, original.is_mayhem_mode);
        assert_eq!(decoded.quote_mint, original.quote_mint);
    }
}
