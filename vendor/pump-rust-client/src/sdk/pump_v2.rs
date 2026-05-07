use anchor_lang::{InstructionData, ToAccountMetas};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};

use crate::state::{BondingCurve, BondingCurveFromIdl, Global};
use crate::token::create_associated_token_account_idempotent;
use crate::{
    constants, pda, pump::client, pump::types::OptionBool,
    pump_agent_payments::client as agent_client,
};

use super::{CreateCoinParams, PumpSdk};

/// Pubkeys derived once and threaded into both `BuyV2` and `SellV2` (the two
/// instructions share the same account set apart from `BuyV2`'s extra
/// `global_volume_accumulator`). `quote_mint` is the resolved value
/// (default → wSOL); `base_token_program` is fixed for v2 (Token-2022).
struct V2TradeAccounts {
    quote_mint: Pubkey,
    base_token_program: Pubkey,
    bonding_curve: Pubkey,
    creator_vault: Pubkey,
    user_volume_accumulator: Pubkey,
    associated_quote_fee_recipient: Pubkey,
    associated_quote_buyback_fee_recipient: Pubkey,
    associated_base_bonding_curve: Pubkey,
    associated_quote_bonding_curve: Pubkey,
    associated_base_user: Pubkey,
    associated_quote_user: Pubkey,
    associated_creator_vault: Pubkey,
    associated_user_volume_accumulator: Pubkey,
}

impl V2TradeAccounts {
    fn derive(
        base_mint: Pubkey,
        quote_mint: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        creator: Pubkey,
        fee_recipient: Pubkey,
        buyback_fee_recipient: Pubkey,
    ) -> Self {
        let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
        let quote_mint = if quote_mint == Pubkey::default() {
            constants::NATIVE_MINT
        } else {
            quote_mint
        };
        let bonding_curve = pda::pump::bonding_curve(&base_mint).0;
        let creator_vault = pda::pump::creator_vault(&creator).0;
        let user_volume_accumulator = pda::pump::user_volume_accumulator(&user).0;
        let ata = |owner: &Pubkey, token_program: &Pubkey, mint: &Pubkey| {
            pda::associated_token(owner, token_program, mint).0
        };
        Self {
            quote_mint,
            base_token_program,
            bonding_curve,
            creator_vault,
            user_volume_accumulator,
            associated_quote_fee_recipient: ata(&fee_recipient, &quote_token_program, &quote_mint),
            associated_quote_buyback_fee_recipient: ata(
                &buyback_fee_recipient,
                &quote_token_program,
                &quote_mint,
            ),
            associated_base_bonding_curve: ata(&bonding_curve, &base_token_program, &base_mint),
            associated_quote_bonding_curve: ata(&bonding_curve, &quote_token_program, &quote_mint),
            associated_base_user: ata(&user, &base_token_program, &base_mint),
            associated_quote_user: ata(&user, &quote_token_program, &quote_mint),
            associated_creator_vault: ata(&creator_vault, &quote_token_program, &quote_mint),
            associated_user_volume_accumulator: ata(
                &user_volume_accumulator,
                &quote_token_program,
                &quote_mint,
            ),
        }
    }
}

impl PumpSdk {
    /// `create_v2` (Token-2022, Mayhem PDAs).
    ///
    /// `quote_mint` selects the curve's quote asset. Pass `Pubkey::default()`
    /// or [`constants::NATIVE_MINT`] for the standard wSOL curve. Any other
    /// mint (e.g. USDC) is treated as a non-SOL quote and three remaining
    /// accounts are appended (quote mint, the legacy-SPL ATA owned by the
    /// bonding curve, and the legacy SPL Token program).
    pub fn create_v2_instruction(
        &self,
        mint: Pubkey,
        user: Pubkey,
        name: impl Into<String>,
        symbol: impl Into<String>,
        uri: impl Into<String>,
        creator: Pubkey,
        quote_mint: Pubkey,
        mayhem_mode: bool,
        cashback: bool,
    ) -> Instruction {
        let token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
        let bonding_curve = pda::pump::bonding_curve(&mint).0;
        let accounts = client::accounts::CreateV2 {
            mint,
            mint_authority: pda::pump::mint_authority().0,
            bonding_curve,
            associated_bonding_curve: pda::associated_token(&bonding_curve, &token_program, &mint)
                .0,
            global: pda::pump::global().0,
            user,
            system_program: system_program::ID,
            token_program,
            associated_token_program: constants::SPL_ATA_PROGRAM_ID,
            mayhem_program_id: constants::MAYHEM_PROGRAM_ID,
            global_params: pda::mayhem::global_params().0,
            sol_vault: pda::mayhem::sol_vault().0,
            mayhem_state: pda::mayhem::mayhem_state(&mint).0,
            mayhem_token_vault: pda::mayhem::mayhem_token_vault(&mint).0,
            event_authority: pda::pump::event_authority().0,
            program: crate::pump::ID,
        };
        let args = client::args::CreateV2 {
            name: name.into(),
            symbol: symbol.into(),
            uri: uri.into(),
            creator,
            is_mayhem_mode: mayhem_mode,
            is_cashback_enabled: OptionBool(cashback),
        };
        let mut metas = accounts.to_account_metas(None);
        let resolved_quote_mint = if quote_mint == Pubkey::default() {
            constants::NATIVE_MINT
        } else {
            quote_mint
        };
        if resolved_quote_mint != constants::NATIVE_MINT {
            let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
            let associated_quote_bonding_curve =
                pda::associated_token(&bonding_curve, &quote_token_program, &resolved_quote_mint).0;
            metas.push(AccountMeta::new_readonly(resolved_quote_mint, false));
            metas.push(AccountMeta::new(associated_quote_bonding_curve, false));
            metas.push(AccountMeta::new_readonly(quote_token_program, false));
        }
        Instruction {
            program_id: crate::pump::ID,
            accounts: metas,
            data: args.data(),
        }
    }

    /// `buy_v2` with fee recipients from [`Global`] and quote layout from [`BondingCurve`].
    pub fn buy_v2_instruction(
        &self,
        global: &Global,
        bonding_curve: &BondingCurve,
        base_mint: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        amount: u64,
        max_quote_tokens: u64,
    ) -> Option<Instruction> {
        let (fee_recipient, buyback_fee_recipient) =
            Self::pump_fee_recipients_pair(global, bonding_curve.is_mayhem_mode)?;
        Some(self.buy_v2_instruction_with_recipients(
            base_mint,
            bonding_curve.quote_mint,
            quote_token_program,
            user,
            bonding_curve.creator,
            fee_recipient,
            buyback_fee_recipient,
            amount,
            max_quote_tokens,
        ))
    }

    pub(crate) fn buy_v2_instruction_with_recipients(
        &self,
        base_mint: Pubkey,
        quote_mint: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        creator: Pubkey,
        fee_recipient: Pubkey,
        buyback_fee_recipient: Pubkey,
        amount: u64,
        max_sol_cost: u64,
    ) -> Instruction {
        let a = V2TradeAccounts::derive(
            base_mint,
            quote_mint,
            quote_token_program,
            user,
            creator,
            fee_recipient,
            buyback_fee_recipient,
        );
        let accounts = client::accounts::BuyV2 {
            global: pda::pump::global().0,
            base_mint,
            quote_mint: a.quote_mint,
            base_token_program: a.base_token_program,
            quote_token_program,
            associated_token_program: constants::SPL_ATA_PROGRAM_ID,
            fee_recipient,
            associated_quote_fee_recipient: a.associated_quote_fee_recipient,
            buyback_fee_recipient,
            associated_quote_buyback_fee_recipient: a.associated_quote_buyback_fee_recipient,
            bonding_curve: a.bonding_curve,
            associated_base_bonding_curve: a.associated_base_bonding_curve,
            associated_quote_bonding_curve: a.associated_quote_bonding_curve,
            user,
            associated_base_user: a.associated_base_user,
            associated_quote_user: a.associated_quote_user,
            creator_vault: a.creator_vault,
            associated_creator_vault: a.associated_creator_vault,
            sharing_config: pda::pump::sharing_config(&base_mint).0,
            global_volume_accumulator: pda::pump::global_volume_accumulator().0,
            user_volume_accumulator: a.user_volume_accumulator,
            associated_user_volume_accumulator: a.associated_user_volume_accumulator,
            fee_config: pda::pump::fee_config().0,
            fee_program: constants::FEE_PROGRAM_ID,
            system_program: system_program::ID,
            event_authority: pda::pump::event_authority().0,
            program: crate::pump::ID,
        };
        let args = client::args::BuyV2 {
            amount,
            max_sol_cost,
        };
        Instruction {
            program_id: crate::pump::ID,
            accounts: accounts.to_account_metas(None),
            data: args.data(),
        }
    }

    /// `buy_v2` with idempotent ATA creates for base/quote user accounts (skipped when `quote_mint` is the default).
    pub fn buy_v2_instructions(
        &self,
        global: &Global,
        bonding_curve: &BondingCurve,
        base_mint: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        amount: u64,
        max_quote_tokens: u64,
    ) -> Option<Vec<Instruction>> {
        let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
        let (fee_recipient, buyback_fee_recipient) =
            Self::pump_fee_recipients_pair(global, bonding_curve.is_mayhem_mode)?;
        let quote_mint = bonding_curve.quote_mint;
        let creator = bonding_curve.creator;
        let mut instructions = Self::user_trade_atas(
            user,
            base_mint,
            bonding_curve,
            base_token_program,
            quote_token_program,
            true,
        );
        instructions.push(self.buy_v2_instruction_with_recipients(
            base_mint,
            quote_mint,
            quote_token_program,
            user,
            creator,
            fee_recipient,
            buyback_fee_recipient,
            amount,
            max_quote_tokens,
        ));
        Some(instructions)
    }

    /// `buy_exact_quote_in_v2`: spend exactly `spendable_quote_in`, requiring at least `min_tokens_out` base tokens out.
    pub fn buy_exact_quote_in_v2_instruction(
        &self,
        global: &Global,
        bonding_curve: &BondingCurve,
        base_mint: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        spendable_quote_in: u64,
        min_tokens_out: u64,
    ) -> Option<Instruction> {
        let (fee_recipient, buyback_fee_recipient) =
            Self::pump_fee_recipients_pair(global, bonding_curve.is_mayhem_mode)?;
        Some(self.buy_exact_quote_in_v2_instruction_with_recipients(
            base_mint,
            bonding_curve.quote_mint,
            quote_token_program,
            user,
            bonding_curve.creator,
            fee_recipient,
            buyback_fee_recipient,
            spendable_quote_in,
            min_tokens_out,
        ))
    }

    pub(crate) fn buy_exact_quote_in_v2_instruction_with_recipients(
        &self,
        base_mint: Pubkey,
        quote_mint: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        creator: Pubkey,
        fee_recipient: Pubkey,
        buyback_fee_recipient: Pubkey,
        spendable_quote_in: u64,
        min_tokens_out: u64,
    ) -> Instruction {
        let a = V2TradeAccounts::derive(
            base_mint,
            quote_mint,
            quote_token_program,
            user,
            creator,
            fee_recipient,
            buyback_fee_recipient,
        );
        let accounts = client::accounts::BuyExactQuoteInV2 {
            global: pda::pump::global().0,
            base_mint,
            quote_mint: a.quote_mint,
            base_token_program: a.base_token_program,
            quote_token_program,
            associated_token_program: constants::SPL_ATA_PROGRAM_ID,
            fee_recipient,
            associated_quote_fee_recipient: a.associated_quote_fee_recipient,
            buyback_fee_recipient,
            associated_quote_buyback_fee_recipient: a.associated_quote_buyback_fee_recipient,
            bonding_curve: a.bonding_curve,
            associated_base_bonding_curve: a.associated_base_bonding_curve,
            associated_quote_bonding_curve: a.associated_quote_bonding_curve,
            user,
            associated_base_user: a.associated_base_user,
            associated_quote_user: a.associated_quote_user,
            creator_vault: a.creator_vault,
            associated_creator_vault: a.associated_creator_vault,
            sharing_config: pda::pump::sharing_config(&base_mint).0,
            global_volume_accumulator: pda::pump::global_volume_accumulator().0,
            user_volume_accumulator: a.user_volume_accumulator,
            associated_user_volume_accumulator: a.associated_user_volume_accumulator,
            fee_config: pda::pump::fee_config().0,
            fee_program: constants::FEE_PROGRAM_ID,
            system_program: system_program::ID,
            event_authority: pda::pump::event_authority().0,
            program: crate::pump::ID,
        };
        let args = client::args::BuyExactQuoteInV2 {
            spendable_quote_in,
            min_tokens_out,
        };
        Instruction {
            program_id: crate::pump::ID,
            accounts: accounts.to_account_metas(None),
            data: args.data(),
        }
    }

    /// `buy_exact_quote_in_v2` with idempotent ATA creates for base/quote user accounts (skipped when `quote_mint` is the default).
    pub fn buy_exact_quote_in_v2_instructions(
        &self,
        global: &Global,
        bonding_curve: &BondingCurve,
        base_mint: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        spendable_quote_in: u64,
        min_tokens_out: u64,
    ) -> Option<Vec<Instruction>> {
        let base_token_program = constants::SPL_TOKEN_2022_PROGRAM_ID;
        let (fee_recipient, buyback_fee_recipient) =
            Self::pump_fee_recipients_pair(global, bonding_curve.is_mayhem_mode)?;
        let quote_mint = bonding_curve.quote_mint;
        let creator = bonding_curve.creator;
        let mut instructions = Self::user_trade_atas(
            user,
            base_mint,
            bonding_curve,
            base_token_program,
            quote_token_program,
            true,
        );
        instructions.push(self.buy_exact_quote_in_v2_instruction_with_recipients(
            base_mint,
            quote_mint,
            quote_token_program,
            user,
            creator,
            fee_recipient,
            buyback_fee_recipient,
            spendable_quote_in,
            min_tokens_out,
        ));
        Some(instructions)
    }

    /// `sell_v2`; fee recipients from [`Global`], quote accounts from [`BondingCurve`].
    pub fn sell_v2_instruction(
        &self,
        global: &Global,
        bonding_curve: &BondingCurve,
        base_mint: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        amount: u64,
        min_sol_output: u64,
    ) -> Option<Instruction> {
        let (fee_recipient, buyback_fee_recipient) =
            Self::pump_fee_recipients_pair(global, bonding_curve.is_mayhem_mode)?;
        Some(self.sell_v2_instruction_with_recipients(
            base_mint,
            bonding_curve.quote_mint,
            quote_token_program,
            user,
            bonding_curve.creator,
            fee_recipient,
            buyback_fee_recipient,
            amount,
            min_sol_output,
        ))
    }

    pub(crate) fn sell_v2_instruction_with_recipients(
        &self,
        base_mint: Pubkey,
        quote_mint: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        creator: Pubkey,
        fee_recipient: Pubkey,
        buyback_fee_recipient: Pubkey,
        amount: u64,
        min_sol_output: u64,
    ) -> Instruction {
        let a = V2TradeAccounts::derive(
            base_mint,
            quote_mint,
            quote_token_program,
            user,
            creator,
            fee_recipient,
            buyback_fee_recipient,
        );
        let accounts = client::accounts::SellV2 {
            global: pda::pump::global().0,
            base_mint,
            quote_mint: a.quote_mint,
            base_token_program: a.base_token_program,
            quote_token_program,
            associated_token_program: constants::SPL_ATA_PROGRAM_ID,
            fee_recipient,
            associated_quote_fee_recipient: a.associated_quote_fee_recipient,
            buyback_fee_recipient,
            associated_quote_buyback_fee_recipient: a.associated_quote_buyback_fee_recipient,
            bonding_curve: a.bonding_curve,
            associated_base_bonding_curve: a.associated_base_bonding_curve,
            associated_quote_bonding_curve: a.associated_quote_bonding_curve,
            user,
            associated_base_user: a.associated_base_user,
            associated_quote_user: a.associated_quote_user,
            creator_vault: a.creator_vault,
            associated_creator_vault: a.associated_creator_vault,
            sharing_config: pda::pump::sharing_config(&base_mint).0,
            user_volume_accumulator: a.user_volume_accumulator,
            associated_user_volume_accumulator: a.associated_user_volume_accumulator,
            fee_config: pda::pump::fee_config().0,
            fee_program: constants::FEE_PROGRAM_ID,
            system_program: system_program::ID,
            event_authority: pda::pump::event_authority().0,
            program: crate::pump::ID,
        };
        let args = client::args::SellV2 {
            amount,
            min_sol_output,
        };
        Instruction {
            program_id: crate::pump::ID,
            accounts: accounts.to_account_metas(None),
            data: args.data(),
        }
    }

    /// `sell_v2` with idempotent ATA creates for base/quote user accounts (skipped when `quote_mint` is the default).
    pub fn sell_v2_instructions(
        &self,
        global: &Global,
        bonding_curve: &BondingCurve,
        base_mint: Pubkey,
        quote_token_program: Pubkey,
        user: Pubkey,
        amount: u64,
        min_sol_output: u64,
    ) -> Option<Vec<Instruction>> {
        let (fee_recipient, buyback_fee_recipient) =
            Self::pump_fee_recipients_pair(global, bonding_curve.is_mayhem_mode)?;
        let quote_mint = bonding_curve.quote_mint;
        let creator = bonding_curve.creator;
        let mut instructions = Self::user_trade_atas(
            user,
            base_mint,
            bonding_curve,
            constants::SPL_TOKEN_2022_PROGRAM_ID,
            quote_token_program,
            false,
        );
        instructions.push(self.sell_v2_instruction_with_recipients(
            base_mint,
            quote_mint,
            quote_token_program,
            user,
            creator,
            fee_recipient,
            buyback_fee_recipient,
            amount,
            min_sol_output,
        ));
        Some(instructions)
    }

    /// `create_v2` then [`Self::buy_v2_instructions`]. Pass
    /// `quote_mint = Pubkey::default()` for a wSOL-quoted coin, or a
    /// supported quote mint (e.g. USDC) for a non-native quote.
    /// Pass `tokenized_agent_buyback_bps = Some(bps)` to also append
    /// [`Self::agent_initialize_instruction`] in the same tx (mirrors the
    /// frontend's tokenized-agent flow).
    pub fn create_v2_and_buy_instruction(
        &self,
        mint: Pubkey,
        user: Pubkey,
        name: impl Into<String>,
        symbol: impl Into<String>,
        uri: impl Into<String>,
        creator: Pubkey,
        quote_mint: Pubkey,
        mayhem_mode: bool,
        cashback: bool,
        tokenized_agent_buyback_bps: Option<u16>,
        global: &Global,
        amount: u64,
        max_quote_tokens: u64,
    ) -> Option<Vec<Instruction>> {
        let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
        let resolved_quote_mint = if quote_mint == Pubkey::default() {
            constants::NATIVE_MINT
        } else {
            quote_mint
        };
        let bonding_curve_preview = BondingCurve::new(BondingCurveFromIdl {
            creator,
            is_cashback_coin: cashback,
            is_mayhem_mode: mayhem_mode,
            quote_mint: resolved_quote_mint,
            ..Default::default()
        });
        let buy_v2_instructions = self.buy_v2_instructions(
            global,
            &bonding_curve_preview,
            mint,
            quote_token_program,
            user,
            amount,
            max_quote_tokens,
        )?;
        let mut instructions = vec![self.create_v2_instruction(
            mint,
            user,
            name,
            symbol,
            uri,
            creator,
            quote_mint,
            mayhem_mode,
            cashback,
        )];

        instructions.extend(buy_v2_instructions);

        if let Some(buyback_bps) = tokenized_agent_buyback_bps {
            instructions.push(self.agent_initialize_instruction(mint, user, creator, buyback_bps));
        }

        Some(instructions)
    }

    /// `agent_initialize` (pump_agent_payments). Initializes the
    /// `TokenAgentPayments` PDA for `mint` with `creator` as the agent
    /// payment authority. `user` signs and pays for the new account.
    pub fn agent_initialize_instruction(
        &self,
        mint: Pubkey,
        user: Pubkey,
        creator: Pubkey,
        buyback_bps: u16,
    ) -> Instruction {
        let accounts = agent_client::accounts::AgentInitialize {
            authority: user,
            bonding_curve: pda::pump::bonding_curve(&mint).0,
            global_config: pda::pump_agent_payments::global_config().0,
            mint,
            token_agent_payments: pda::pump_agent_payments::token_agent_payments(&mint).0,
            system_program: system_program::ID,
            event_authority: pda::pump_agent_payments::event_authority().0,
            program: crate::pump_agent_payments::ID,
            sharing_fee_config: pda::pump::sharing_config(&mint).0,
        };
        let args = agent_client::args::AgentInitialize {
            authority: creator,
            buyback_bps,
        };
        Instruction {
            program_id: crate::pump_agent_payments::ID,
            accounts: accounts.to_account_metas(None),
            data: args.data(),
        }
    }

    pub fn extend_account_ix(&self, mint: Pubkey, user: Pubkey) -> Instruction {
        let accounts = client::accounts::ExtendAccount {
            account: pda::pump::bonding_curve(&mint).0,
            user,
            system_program: system_program::ID,
            event_authority: pda::pump::event_authority().0,
            program: crate::pump::ID,
        };
        Instruction {
            program_id: crate::pump::ID,
            accounts: accounts.to_account_metas(None),
            data: client::args::ExtendAccount.data(),
        }
    }

    /// `claim_cashback_v2`. Pulls accumulated cashback for `user` to either
    /// the user's lamport balance (legacy wSOL curves) or to their quote ATA
    /// (non-SOL curves). Pass `quote_mint = Pubkey::default()` or
    /// [`constants::NATIVE_MINT`] for the legacy/wSOL claim path.
    pub fn claim_cashback_v2_instruction(
        &self,
        user: Pubkey,
        quote_mint: Pubkey,
        quote_token_program: Pubkey,
    ) -> Instruction {
        let resolved_quote_mint = if quote_mint == Pubkey::default() {
            constants::NATIVE_MINT
        } else {
            quote_mint
        };
        let user_volume_accumulator = pda::pump::user_volume_accumulator(&user).0;
        let associated_user_volume_accumulator = pda::associated_token(
            &user_volume_accumulator,
            &quote_token_program,
            &resolved_quote_mint,
        )
        .0;
        let associated_quote_user =
            pda::associated_token(&user, &quote_token_program, &resolved_quote_mint).0;
        let accounts = client::accounts::ClaimCashbackV2 {
            user,
            user_volume_accumulator,
            quote_mint: resolved_quote_mint,
            quote_token_program,
            associated_token_program: constants::SPL_ATA_PROGRAM_ID,
            associated_user_volume_accumulator,
            associated_quote_user,
            system_program: system_program::ID,
            event_authority: pda::pump::event_authority().0,
            program: crate::pump::ID,
        };
        Instruction {
            program_id: crate::pump::ID,
            accounts: accounts.to_account_metas(None),
            data: client::args::ClaimCashbackV2.data(),
        }
    }

    /// `create_v2` then [`Self::buy_v2_instructions`]. Set
    /// `params.quote_mint = Pubkey::default()` for a wSOL-quoted coin, or a
    /// supported quote mint (e.g. USDC) for a non-native quote.
    /// Setting `params.tokenized_agent_buyback_bps = Some(bps)` also appends
    /// [`Self::agent_initialize_instruction`].
    pub fn create_coin_instructions(
        &self,
        params: CreateCoinParams<'_>,
    ) -> Option<Vec<Instruction>> {
        let CreateCoinParams {
            mint,
            user,
            creator,
            name,
            symbol,
            uri,
            mayhem_mode,
            cashback,
            quote_mint,
            global,
            token_amount,
            max_quote_tokens,
            tokenized_agent_buyback_bps,
        } = params;
        let quote_token_program = constants::SPL_TOKEN_PROGRAM_ID;
        let resolved_quote_mint = if quote_mint == Pubkey::default() {
            constants::NATIVE_MINT
        } else {
            quote_mint
        };
        let bonding_curve_preview = BondingCurve::new(BondingCurveFromIdl {
            creator,
            is_cashback_coin: cashback,
            is_mayhem_mode: mayhem_mode,
            quote_mint: resolved_quote_mint,
            ..Default::default()
        });

        let mut ixs: Vec<Instruction> = vec![self.create_v2_instruction(
            mint,
            user,
            name,
            symbol,
            uri,
            creator,
            quote_mint,
            mayhem_mode,
            cashback,
        )];
        ixs.extend(self.buy_v2_instructions(
            global,
            &bonding_curve_preview,
            mint,
            quote_token_program,
            user,
            token_amount,
            max_quote_tokens,
        )?);
        if let Some(buyback_bps) = tokenized_agent_buyback_bps {
            ixs.push(self.agent_initialize_instruction(mint, user, creator, buyback_bps));
        }
        Some(ixs)
    }

    /// Idempotent ATA creates for the user's base + quote token accounts plus
    /// the two PDA-owned quote ATAs (`associated_creator_vault` and
    /// `associated_user_volume_accumulator`) that v2 buy/sell reference. The
    /// base ATA is skipped when `include_base` is `false` (sell-side flows
    /// where the user already holds the base balance to spend). A default
    /// `bonding_curve.quote_mint` resolves to wSOL to match
    /// [`V2TradeAccounts::derive`].
    fn user_trade_atas(
        user: Pubkey,
        base_mint: Pubkey,
        bonding_curve: &BondingCurve,
        base_token_program: Pubkey,
        quote_token_program: Pubkey,
        include_base: bool,
    ) -> Vec<Instruction> {
        let mut ixs = vec![];
        if include_base {
            ixs.push(create_associated_token_account_idempotent(
                &user,
                &user,
                &base_mint,
                &base_token_program,
            ));
        }
        let bonding_curve_has_non_sol_quote = bonding_curve.quote_mint != Pubkey::default()
            && bonding_curve.quote_mint != constants::NATIVE_MINT;
        // associated_quote_fee_recipient: Has alraedy been initialized, we will initalize this during initial testing.
        // associated_quote_buyback_fee_recipient: Has alraedy been initialized, we will initalize this during initial testing.
        if bonding_curve_has_non_sol_quote {
            ixs.push(create_associated_token_account_idempotent(
                &user,
                &user,
                &bonding_curve.quote_mint,
                &quote_token_program,
            ));
            ixs.push(create_associated_token_account_idempotent(
                &user,
                &bonding_curve.creator,
                &bonding_curve.quote_mint,
                &quote_token_program,
            ));
            // associated_quote_bonding_curve
            let bonding_curve_pda = pda::pump::bonding_curve(&base_mint).0;
            ixs.push(create_associated_token_account_idempotent(
                &user,
                &bonding_curve_pda,
                &bonding_curve.quote_mint,
                &quote_token_program,
            ));
            if bonding_curve.is_cashback_coin {
                let user_volume_accumulator = pda::pump::user_volume_accumulator(&user).0;
                ixs.push(create_associated_token_account_idempotent(
                    &user,
                    &user_volume_accumulator,
                    &bonding_curve.quote_mint,
                    &quote_token_program,
                ));
            }
        }
        ixs
    }
}
