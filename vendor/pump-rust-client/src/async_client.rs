//! RPC wrapper around [`crate::sdk::PumpSdk`].

use std::sync::Arc;

use solana_client::{
    nonblocking::rpc_client::RpcClient, rpc_client::SerializableTransaction,
    rpc_response::RpcSimulateTransactionResult,
};
use solana_sdk::{
    account::Account, compute_budget::ComputeBudgetInstruction, hash::Hash,
    instruction::Instruction, pubkey::Pubkey, signature::Signature, signer::Signer,
    transaction::Transaction,
};

use crate::{
    accounts::{
        decode_bonding_curve, decode_fee_config, decode_global, decode_global_volume_accumulator,
        decode_user_volume_accumulator_nullable,
    },
    errors::{PumpClientError, Result},
    pda,
    sdk::PumpSdk,
    state::{BondingCurve, FeeConfig, Global, GlobalVolumeAccumulator, UserVolumeAccumulator},
};

#[derive(Clone)]
pub struct AsyncPumpClient {
    rpc: Arc<RpcClient>,
    sdk: PumpSdk,
}

/// Account snapshot for building a buy.
#[derive(Debug)]
pub struct BuyState {
    pub bonding_curve_account: Account,
    pub bonding_curve: BondingCurve,
    pub associated_user_account: Option<Account>,
}

/// Account snapshot for building a sell.
#[derive(Debug)]
pub struct SellState {
    pub bonding_curve_account: Account,
    pub bonding_curve: BondingCurve,
}

/// Optional compute-budget instructions prepended to built transactions (limit, then price).
#[derive(Clone, Copy, Debug, Default)]
pub struct ComputeBudget {
    pub units: Option<u32>,
    pub micro_lamports_per_unit: Option<u64>,
}

impl ComputeBudget {
    fn prepend_into(&self, base: &[Instruction]) -> Vec<Instruction> {
        let extra = self.units.is_some() as usize + self.micro_lamports_per_unit.is_some() as usize;
        let mut out = Vec::with_capacity(base.len() + extra);
        if let Some(units) = self.units {
            out.push(ComputeBudgetInstruction::set_compute_unit_limit(units));
        }
        if let Some(price) = self.micro_lamports_per_unit {
            out.push(ComputeBudgetInstruction::set_compute_unit_price(price));
        }
        out.extend_from_slice(base);
        out
    }
}

impl AsyncPumpClient {
    pub fn new(rpc: Arc<RpcClient>) -> Self {
        Self {
            rpc,
            sdk: PumpSdk::new(),
        }
    }

    pub fn rpc(&self) -> &Arc<RpcClient> {
        &self.rpc
    }

    pub fn sdk(&self) -> &PumpSdk {
        &self.sdk
    }

    pub async fn fetch_global(&self) -> Result<Global> {
        let address = pda::pump::global().0;
        let account = self.get_account(&address, "global").await?;
        decode_global(&account.data)
    }

    pub async fn fetch_fee_config(&self) -> Result<FeeConfig> {
        let address = pda::pump::fee_config().0;
        let account = self.get_account(&address, "fee_config").await?;
        decode_fee_config(&account.data)
    }

    pub async fn fetch_bonding_curve(&self, mint: &Pubkey) -> Result<BondingCurve> {
        let address = pda::pump::bonding_curve(mint).0;
        let account = self.get_account(&address, "bonding_curve").await?;
        decode_bonding_curve(&account.data)
    }

    pub async fn fetch_global_volume_accumulator(&self) -> Result<GlobalVolumeAccumulator> {
        let address = pda::pump::global_volume_accumulator().0;
        let account = self
            .get_account(&address, "global_volume_accumulator")
            .await?;
        decode_global_volume_accumulator(&account.data)
    }

    pub async fn fetch_user_volume_accumulator(
        &self,
        user: &Pubkey,
    ) -> Result<Option<UserVolumeAccumulator>> {
        let address = pda::pump::user_volume_accumulator(user).0;
        match self
            .rpc
            .get_account_with_commitment(&address, self.rpc.commitment())
            .await
        {
            Ok(response) => match response.value {
                Some(account) => Ok(decode_user_volume_accumulator_nullable(&account.data)),
                None => Ok(None),
            },
            Err(e) => Err(PumpClientError::from(e)),
        }
    }

    pub async fn fetch_buy_state(
        &self,
        mint: &Pubkey,
        user: &Pubkey,
        token_program: &Pubkey,
    ) -> Result<BuyState> {
        let (bonding_curve_account, bonding_curve, associated_user_account) = self
            .fetch_bonding_curve_with_user_token_account(mint, user, token_program)
            .await?;
        Ok(BuyState {
            bonding_curve_account,
            bonding_curve,
            associated_user_account,
        })
    }

    pub async fn fetch_sell_state(
        &self,
        mint: &Pubkey,
        user: &Pubkey,
        token_program: &Pubkey,
    ) -> Result<SellState> {
        let (bonding_curve_account, bonding_curve, associated_user_account) = self
            .fetch_bonding_curve_with_user_token_account(mint, user, token_program)
            .await?;
        if associated_user_account.is_none() {
            return Err(PumpClientError::AccountNotFound {
                name: "associated_user",
                address: pda::associated_token(user, token_program, mint).0,
            });
        }
        Ok(SellState {
            bonding_curve_account,
            bonding_curve,
        })
    }

    async fn fetch_bonding_curve_with_user_token_account(
        &self,
        mint: &Pubkey,
        user: &Pubkey,
        token_program: &Pubkey,
    ) -> Result<(Account, BondingCurve, Option<Account>)> {
        let bonding_curve_address = pda::pump::bonding_curve(mint).0;
        let associated_user = pda::associated_token(user, token_program, mint).0;

        let mut accounts = self
            .rpc
            .get_multiple_accounts(&[bonding_curve_address, associated_user])
            .await
            .map_err(PumpClientError::from)?
            .into_iter();

        let bonding_curve_account =
            accounts
                .next()
                .flatten()
                .ok_or(PumpClientError::AccountNotFound {
                    name: "bonding_curve",
                    address: bonding_curve_address,
                })?;
        let associated_user_account = accounts.next().flatten();
        let bonding_curve = decode_bonding_curve(&bonding_curve_account.data)?;
        Ok((bonding_curve_account, bonding_curve, associated_user_account))
    }

    /// Spendable lamports in the creator vault (above rent); 0 if missing or rent-only.
    pub async fn get_creator_vault_balance(&self, creator: &Pubkey) -> Result<u64> {
        let creator_vault = pda::pump::creator_vault(creator).0;

        let account = match self
            .rpc
            .get_account_with_commitment(&creator_vault, self.rpc.commitment())
            .await
            .map_err(PumpClientError::from)?
            .value
        {
            Some(account) => account,
            None => return Ok(0),
        };

        let rent_exempt = self
            .rpc
            .get_minimum_balance_for_rent_exemption(account.data.len())
            .await
            .map_err(PumpClientError::from)?;

        if account.lamports <= rent_exempt {
            return Ok(0);
        }
        Ok(account.lamports - rent_exempt)
    }

    /// Recent blockhash at the client's commitment.
    pub async fn latest_blockhash(&self) -> Result<Hash> {
        self.rpc
            .get_latest_blockhash()
            .await
            .map_err(PumpClientError::from)
    }

    /// Fetches a blockhash then signs. Prefer [`Self::build_transaction_with_blockhash`] if you already have a hash.
    pub async fn build_transaction(
        &self,
        ixs: &[Instruction],
        payer: &Pubkey,
        signers: &[&dyn Signer],
        compute_budget: Option<ComputeBudget>,
    ) -> Result<Transaction> {
        let recent_blockhash = self.latest_blockhash().await?;
        Ok(self.build_transaction_with_blockhash(
            ixs,
            payer,
            signers,
            recent_blockhash,
            compute_budget,
        ))
    }

    /// Prepends compute-budget instructions when set, then signs.
    pub fn build_transaction_with_blockhash(
        &self,
        ixs: &[Instruction],
        payer: &Pubkey,
        signers: &[&dyn Signer],
        recent_blockhash: Hash,
        compute_budget: Option<ComputeBudget>,
    ) -> Transaction {
        let full_ixs = match compute_budget {
            Some(cb) => cb.prepend_into(ixs),
            None => ixs.to_vec(),
        };
        Transaction::new_signed_with_payer(&full_ixs, Some(payer), signers, recent_blockhash)
    }

    /// Simulate a transaction.
    pub async fn simulate_transaction<T: SerializableTransaction>(
        &self,
        tx: &T,
    ) -> Result<RpcSimulateTransactionResult> {
        let response = self
            .rpc
            .simulate_transaction(tx)
            .await
            .map_err(PumpClientError::from)?;
        Ok(response.value)
    }

    /// Send without waiting for confirmation.
    pub async fn send_transaction<T: SerializableTransaction>(&self, tx: &T) -> Result<Signature> {
        self.rpc
            .send_transaction(tx)
            .await
            .map_err(PumpClientError::from)
    }

    /// Send and confirm at the client's commitment.
    pub async fn send_and_confirm_transaction<T: SerializableTransaction>(
        &self,
        tx: &T,
    ) -> Result<Signature> {
        self.rpc
            .send_and_confirm_transaction(tx)
            .await
            .map_err(PumpClientError::from)
    }

    async fn get_account(&self, address: &Pubkey, name: &'static str) -> Result<Account> {
        let value = self
            .rpc
            .get_account_with_commitment(address, self.rpc.commitment())
            .await
            .map_err(PumpClientError::from)?
            .value;
        value.ok_or(PumpClientError::AccountNotFound {
            name,
            address: *address,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::{signature::Keypair, system_instruction};

    #[test]
    fn client_is_send_sync_clone() {
        fn assert_traits<T: Send + Sync + Clone>() {}
        assert_traits::<AsyncPumpClient>();
    }

    #[test]
    fn constructible_against_localhost() {
        let rpc = Arc::new(RpcClient::new("http://localhost:8899".to_string()));
        let client = AsyncPumpClient::new(rpc);
        let _: &PumpSdk = client.sdk();
    }

    fn local_client() -> AsyncPumpClient {
        AsyncPumpClient::new(Arc::new(RpcClient::new(
            "http://localhost:8899".to_string(),
        )))
    }

    fn discriminator(ix: &Instruction) -> Option<u8> {
        ix.data.first().copied()
    }

    #[test]
    fn build_transaction_with_blockhash_prepends_compute_budget_ixs() {
        let client = local_client();
        let payer = Keypair::new();
        let recipient = Pubkey::new_unique();
        let transfer = system_instruction::transfer(&payer.pubkey(), &recipient, 1);
        let blockhash = Hash::new_unique();

        let tx = client.build_transaction_with_blockhash(
            &[transfer],
            &payer.pubkey(),
            &[&payer],
            blockhash,
            Some(ComputeBudget {
                units: Some(200_000),
                micro_lamports_per_unit: Some(1_000),
            }),
        );

        assert_eq!(tx.message.instructions.len(), 3);
        let cb_program = solana_sdk::compute_budget::id();
        assert_eq!(
            tx.message.account_keys[tx.message.instructions[0].program_id_index as usize],
            cb_program,
        );
        assert_eq!(tx.message.instructions[0].data.first(), Some(&2u8));
        assert_eq!(
            tx.message.account_keys[tx.message.instructions[1].program_id_index as usize],
            cb_program,
        );
        assert_eq!(tx.message.instructions[1].data.first(), Some(&3u8));
    }

    #[test]
    fn build_transaction_with_blockhash_emits_only_requested_compute_budget_ixs() {
        let client = local_client();
        let payer = Keypair::new();
        let recipient = Pubkey::new_unique();
        let transfer = system_instruction::transfer(&payer.pubkey(), &recipient, 1);

        let tx = client.build_transaction_with_blockhash(
            &[transfer.clone()],
            &payer.pubkey(),
            &[&payer],
            Hash::new_unique(),
            Some(ComputeBudget {
                units: Some(50_000),
                micro_lamports_per_unit: None,
            }),
        );
        assert_eq!(tx.message.instructions.len(), 2);
        assert_eq!(tx.message.instructions[0].data.first(), Some(&2u8));

        let tx = client.build_transaction_with_blockhash(
            &[transfer],
            &payer.pubkey(),
            &[&payer],
            Hash::new_unique(),
            None,
        );
        assert_eq!(tx.message.instructions.len(), 1);
    }

    #[test]
    fn build_transaction_with_blockhash_signs_with_payer() {
        let client = local_client();
        let payer = Keypair::new();
        let recipient = Pubkey::new_unique();
        let transfer = system_instruction::transfer(&payer.pubkey(), &recipient, 1);
        let blockhash = Hash::new_unique();

        let tx = client.build_transaction_with_blockhash(
            &[transfer],
            &payer.pubkey(),
            &[&payer],
            blockhash,
            None,
        );

        assert!(tx.is_signed());
        assert_eq!(tx.message.recent_blockhash, blockhash);
        assert_eq!(tx.message.account_keys[0], payer.pubkey());
    }

    #[test]
    fn compute_budget_helper_emits_known_discriminators() {
        let limit = ComputeBudgetInstruction::set_compute_unit_limit(0);
        let price = ComputeBudgetInstruction::set_compute_unit_price(0);
        assert_eq!(discriminator(&limit), Some(2));
        assert_eq!(discriminator(&price), Some(3));
    }
}
