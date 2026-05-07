//! Generic newtype that lets `Account<'info, T>` tolerate buffers shorter
//! than `T`'s current Borsh layout by zero-padding to the expected
//! Anchor-serialized size before deserializing.

use std::io::{Read, Write};
use std::ops::{Deref, DerefMut};

use anchor_lang::prelude::Pubkey;
use anchor_lang::{
    AccountDeserialize, AccountSerialize, AnchorDeserialize, AnchorSerialize, Discriminator,
    Owner, Result,
};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[repr(transparent)]
pub struct AccountWrapper<T>(pub T);

impl<T> AccountWrapper<T> {
    pub fn new(inner: T) -> Self {
        Self(inner)
    }

    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> Deref for AccountWrapper<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

impl<T> DerefMut for AccountWrapper<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.0
    }
}

impl<T> From<T> for AccountWrapper<T> {
    fn from(inner: T) -> Self {
        Self(inner)
    }
}

impl<T: Discriminator> Discriminator for AccountWrapper<T> {
    const DISCRIMINATOR: &'static [u8] = T::DISCRIMINATOR;
}

impl<T: Owner> Owner for AccountWrapper<T> {
    fn owner() -> Pubkey {
        T::owner()
    }
}

impl<T: AccountSerialize> AccountSerialize for AccountWrapper<T> {
    fn try_serialize<W: Write>(&self, writer: &mut W) -> Result<()> {
        self.0.try_serialize(writer)
    }
}

impl<T: AnchorSerialize> AnchorSerialize for AccountWrapper<T> {
    fn serialize<W: Write>(&self, writer: &mut W) -> std::io::Result<()> {
        self.0.serialize(writer)
    }
}

impl<T: AnchorDeserialize> AnchorDeserialize for AccountWrapper<T> {
    fn deserialize_reader<R: Read>(reader: &mut R) -> std::io::Result<Self> {
        T::deserialize_reader(reader).map(Self)
    }
}

#[cfg(feature = "idl-build")]
impl<T> anchor_lang::IdlBuild for AccountWrapper<T> {}

impl<T> AccountDeserialize for AccountWrapper<T>
where
    T: AccountDeserialize + AccountSerialize + Default,
{
    fn try_deserialize(buf: &mut &[u8]) -> Result<Self> {
        let mut canonical = Vec::new();
        T::default().try_serialize(&mut canonical)?;
        let expected = canonical.len();

        if buf.len() >= expected {
            return T::try_deserialize(buf).map(Self);
        }
        let mut padded = vec![0u8; expected];
        padded[..buf.len()].copy_from_slice(buf);
        let mut slice: &[u8] = &padded;
        let inner = T::try_deserialize(&mut slice)?;
        *buf = &buf[buf.len()..];
        Ok(Self(inner))
    }

    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        let mut canonical = Vec::new();
        T::default().try_serialize(&mut canonical)?;
        let expected = canonical.len();

        if buf.len() >= expected {
            return T::try_deserialize_unchecked(buf).map(Self);
        }
        let mut padded = vec![0u8; expected];
        padded[..buf.len()].copy_from_slice(buf);
        let mut slice: &[u8] = &padded;
        let inner = T::try_deserialize_unchecked(&mut slice)?;
        *buf = &buf[buf.len()..];
        Ok(Self(inner))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AccountSerialize;
    use solana_program::pubkey::Pubkey;

    use crate::constants;
    use crate::state::{BondingCurve, BondingCurveFromIdl};

    fn fake_pubkey(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    #[test]
    fn try_deserialize_pads_short_buffer() {
        let original = BondingCurveFromIdl {
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
        };
        let mut full = Vec::new();
        original.try_serialize(&mut full).expect("serialize");

        // Strip the trailing bytes — simulates a pre-extension on-chain
        // account. The wrapper should zero-pad and decode successfully,
        // yielding default-zero values for fields that lived in the
        // truncated tail.
        let truncated_len = full.len() - 33; // drop quote_mint (32) + is_cashback_coin (1)
        let short = &full[..truncated_len];

        let decoded =
            <BondingCurve as AccountDeserialize>::try_deserialize(&mut &short[..]).expect("decode");
        assert_eq!(decoded.virtual_token_reserves, original.virtual_token_reserves);
        assert_eq!(decoded.creator, original.creator);
        assert_eq!(decoded.is_mayhem_mode, original.is_mayhem_mode);
        // Stripped fields land at their `Default` value (zero / Pubkey::default()).
        assert!(!decoded.is_cashback_coin);
        assert_eq!(decoded.quote_mint, Pubkey::default());
    }

    #[test]
    fn try_deserialize_full_buffer_is_passthrough() {
        let original = BondingCurveFromIdl {
            virtual_token_reserves: 42,
            virtual_quote_reserves: 0,
            real_token_reserves: 0,
            real_quote_reserves: 0,
            token_total_supply: 0,
            complete: true,
            creator: fake_pubkey(3),
            is_mayhem_mode: false,
            is_cashback_coin: true,
            quote_mint: constants::NATIVE_MINT,
        };
        let mut full = Vec::new();
        original.try_serialize(&mut full).expect("serialize");

        let decoded = <BondingCurve as AccountDeserialize>::try_deserialize(&mut &full[..])
            .expect("decode");
        assert_eq!(decoded.virtual_token_reserves, 42);
        assert_eq!(decoded.complete, original.complete);
        assert_eq!(decoded.creator, original.creator);
        assert_eq!(decoded.is_cashback_coin, original.is_cashback_coin);
        assert_eq!(decoded.quote_mint, original.quote_mint);
    }
}
