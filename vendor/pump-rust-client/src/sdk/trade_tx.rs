use solana_program::instruction::Instruction;

use crate::constants;
use crate::math::QuoteResult;
use crate::token::{
    create_associated_token_account_idempotent, unwrap_sol_instruction, wrap_sol_instructions,
};

use super::{
    AmmQuoteSource, PumpSdk, Quote, TradeQuoteParams, TradeTxParams, TradeTxWithVenueParams,
    TradeVenue,
};

impl PumpSdk {
    /// Full buy or sell: bonding curve via [`Self::buy_v2_instructions`] /
    /// [`Self::sell_v2_instructions`], or AMM with wSOL wrap/unwrap when the quote is native.
    /// `None` if global fee recipients are missing.
    pub fn trade_tx_instructions_with_venue(
        &self,
        params: TradeTxWithVenueParams<'_>,
    ) -> Option<Vec<Instruction>> {
        let TradeTxWithVenueParams {
            mint,
            base_token_program,
            quote_token_program,
            user,
            is_buy,
            venue,
            base_amount,
            sol_amount_threshold,
        } = params;

        match venue {
            TradeVenue::BondingCurve {
                global,
                bonding_curve,
            } => {
                if is_buy {
                    self.buy_v2_instructions(
                        global,
                        bonding_curve,
                        mint,
                        quote_token_program,
                        user,
                        base_amount,
                        sol_amount_threshold,
                    )
                } else {
                    self.sell_v2_instructions(
                        global,
                        bonding_curve,
                        mint,
                        quote_token_program,
                        user,
                        base_amount,
                        sol_amount_threshold,
                    )
                }
            }
            TradeVenue::Amm {
                pool,
                amm_global,
                pool_state,
            } => {
                debug_assert_eq!(mint, pool_state.base_mint);
                let base_mint = pool_state.base_mint;
                let quote_mint = pool_state.quote_mint;
                let (protocol_fee_recipient, buyback_fee_recipient) =
                    Self::amm_fee_recipients_pair(amm_global)?;
                let coin_creator = pool_state.coin_creator;
                let is_cashback_coin = pool_state.is_cashback_coin;
                let uses_native_quote = quote_mint == constants::NATIVE_MINT;

                let mut ixs: Vec<Instruction> = Vec::with_capacity(6);
                if is_buy {
                    ixs.push(create_associated_token_account_idempotent(
                        &user,
                        &user,
                        &base_mint,
                        &base_token_program,
                    ));
                    ixs.push(create_associated_token_account_idempotent(
                        &user,
                        &user,
                        &quote_mint,
                        &quote_token_program,
                    ));
                    if uses_native_quote {
                        ixs.extend(wrap_sol_instructions(&user, sol_amount_threshold));
                    }
                    ixs.push(self.buy_amm_instruction_with_recipients(
                        pool,
                        base_mint,
                        quote_mint,
                        base_token_program,
                        quote_token_program,
                        user,
                        coin_creator,
                        protocol_fee_recipient,
                        buyback_fee_recipient,
                        is_cashback_coin,
                        base_amount,
                        sol_amount_threshold,
                    ));
                } else {
                    ixs.push(create_associated_token_account_idempotent(
                        &user,
                        &user,
                        &quote_mint,
                        &quote_token_program,
                    ));
                    ixs.push(self.sell_amm_instruction_with_recipients(
                        pool,
                        base_mint,
                        quote_mint,
                        base_token_program,
                        quote_token_program,
                        user,
                        coin_creator,
                        protocol_fee_recipient,
                        buyback_fee_recipient,
                        is_cashback_coin,
                        base_amount,
                        sol_amount_threshold,
                    ));
                }
                if uses_native_quote {
                    ixs.push(unwrap_sol_instruction(&user));
                }
                Some(ixs)
            }
        }
    }

    /// [`Self::trade_tx_instructions_with_venue`] with routing from `bonding_curve.complete`.
    pub fn trade_tx_instructions(&self, params: TradeTxParams<'_>) -> Option<Vec<Instruction>> {
        let TradeTxParams {
            mint,
            base_token_program,
            quote_token_program,
            user,
            is_buy,
            base_amount,
            sol_amount_threshold,
            pump_global,
            bonding_curve,
            pump_pool,
        } = params;

        let venue = if bonding_curve.complete {
            let p = pump_pool?;
            TradeVenue::Amm {
                pool: p.pool,
                amm_global: p.amm_global,
                pool_state: p.pool_state,
            }
        } else {
            TradeVenue::BondingCurve {
                global: pump_global,
                bonding_curve,
            }
        };

        self.trade_tx_instructions_with_venue(TradeTxWithVenueParams {
            mint,
            base_token_program,
            quote_token_program,
            user,
            is_buy,
            venue,
            base_amount,
            sol_amount_threshold,
        })
    }

    /// Auto-routed quote: bonding curve via [`Self::buy_quote_bonding_curve_token_out`] /
    /// [`Self::sell_quote_bonding_curve`], or AMM via [`Self::buy_quote_amm_token_out`] /
    /// [`Self::sell_quote_amm`] using `bonding_curve.complete`. `None` when the curve is
    /// complete and `pump_pool` was not supplied — mirrors [`Self::trade_tx_instructions`].
    pub fn quote_trade(&self, params: TradeQuoteParams<'_>) -> Option<QuoteResult<Quote>> {
        let TradeQuoteParams {
            is_buy,
            base_amount,
            slippage_bps,
            base_mint_supply,
            pump_global,
            pump_fee_config,
            bonding_curve,
            pump_pool,
        } = params;

        if bonding_curve.complete {
            let p = pump_pool?;
            let source = AmmQuoteSource::Pool {
                pool: p.pool_state,
                base_reserve: p.base_reserve,
                quote_reserve: p.quote_reserve,
                base_mint_supply,
            };
            Some(if is_buy {
                self.buy_quote_amm_token_out(
                    p.amm_global,
                    p.amm_fee_config,
                    source,
                    base_amount,
                    slippage_bps,
                )
            } else {
                self.sell_quote_amm(
                    p.amm_global,
                    p.amm_fee_config,
                    source,
                    base_amount,
                    slippage_bps,
                )
            })
        } else {
            Some(if is_buy {
                self.buy_quote_bonding_curve_token_out(
                    pump_global,
                    pump_fee_config,
                    bonding_curve,
                    base_mint_supply,
                    base_amount,
                    slippage_bps,
                )
            } else {
                self.sell_quote_bonding_curve(
                    pump_global,
                    pump_fee_config,
                    bonding_curve,
                    base_mint_supply,
                    base_amount,
                    slippage_bps,
                )
            })
        }
    }
}
