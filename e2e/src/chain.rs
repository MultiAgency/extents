use std::time::Duration;

use anyhow::{Context, Result};
use extents_client::objective::Call;
use extents_objective::Timestamp;
use near_kit::{
    AccountId, CryptoHash, Gas, Near, NearToken,
    protocol::StateInit,
    rpc::{ActionView, BlockReference, FinalExecutionOutcome, Finality},
    signer::FileSigner,
    transaction::{Final, Included, TransactionBuilder},
};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::Serialize;
use serde_json::Value;

use crate::Config;

pub struct Chain {
    near: Near,
    network: &'static str,
    pub verifier: AccountId,
    /// Token id inside the Verifier.
    pub token: String,
}

/// One transaction and everything it caused, as recorded in the results.
#[derive(Debug, Clone, Serialize)]
pub struct Tx {
    pub label: String,
    pub signer: AccountId,
    pub receiver: AccountId,
    pub hash: String,
    /// Whether the transaction's own result succeeded. Payout receipts can
    /// still fail independently; see `receipts`.
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The transaction's return value, if it is JSON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    pub prepaid_tgas: f64,
    pub burnt_tgas: f64,
    pub receipts: Vec<ReceiptRecord>,
    /// `EVENT_JSON` logs of the `extents-objective` standard.
    pub events: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReceiptRecord {
    pub predecessor: AccountId,
    pub executor: AccountId,
    /// Function name, or the kind of action(s).
    pub action: String,
    /// Gas attached to the function call, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attached_tgas: Option<f64>,
    /// NEAR attached to the function call, in yocto.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attached_yocto: Option<String>,
    pub burnt_tgas: f64,
    /// NEAR moved by a `Transfer` action, in yocto.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_yocto: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The receipt's return value, if it is JSON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

impl Tx {
    pub fn failed_receipts(&self) -> impl Iterator<Item = &ReceiptRecord> {
        self.receipts.iter().filter(|r| !r.ok)
    }

    pub fn events_of(&self, kind: &str) -> impl Iterator<Item = &Value> {
        self.events.iter().filter(move |e| e["event"] == kind)
    }
}

impl Chain {
    pub fn testnet(config: &Config) -> Result<Self> {
        let mut near = Near::custom(&config.rpc, "testnet");
        if let Some(key) = &config.api_key {
            let mut auth = HeaderValue::from_str(&format!("Bearer {key}"))
                .context("FASTNEAR_API_KEY is not a valid header value")?;
            auth.set_sensitive(true);
            near = near.http_client(
                reqwest::Client::builder()
                    .default_headers(HeaderMap::from_iter([(AUTHORIZATION, auth)]))
                    .build()?,
            );
        }
        Ok(Self {
            near: near.build(),
            network: "testnet",
            verifier: config.verifier.parse()?,
            token: config.token.clone(),
        })
    }

    pub fn signer(&self, account: &AccountId) -> Result<FileSigner> {
        FileSigner::new(self.network, account.clone())
            .with_context(|| format!("no credentials for {account}"))
    }

    pub fn as_signer(&self, account: &AccountId) -> Result<Near> {
        Ok(self.near.with_signer(self.signer(account)?))
    }

    /// `None` if the account does not exist.
    pub async fn near_balance(&self, account: &AccountId) -> Result<Option<u128>> {
        if !self.near.account_exists(account.clone()).await? {
            return Ok(None);
        }
        let view = self.near.account(account.clone()).await?;
        Ok(Some(view.amount.as_yoctonear()))
    }

    pub async fn mt_balance(&self, account: &AccountId) -> Result<u128> {
        let balance: String = self
            .near
            .view(self.verifier.clone(), "mt_balance_of")
            .args(serde_json::json!({ "account_id": account, "token_id": self.token }))
            .await?;
        Ok(balance.parse()?)
    }

    pub async fn view<T: serde::de::DeserializeOwned + Send + 'static>(
        &self,
        contract: &AccountId,
        method: &str,
        args: &Value,
    ) -> Result<T> {
        Ok(self.near.view(contract.clone(), method).args(args).await?)
    }

    /// Whether the Verifier runs the build `extents-client` writes for
    /// (`VERIFIER_SHA256`). Results against any other build would be
    /// misattributed.
    pub async fn verifier_is_pinned(&self) -> Result<bool> {
        let view = self.near.account(self.verifier.clone()).await?;
        Ok(hex::encode(view.code_hash.as_bytes()) == extents_client::VERIFIER_SHA256)
    }

    pub async fn global_contract_exists(&self, hash: [u8; 32]) -> Result<bool> {
        Ok(self
            .near
            .global_contract(CryptoHash::from(hash))
            .await
            .is_ok())
    }

    /// The latest final block's time: intent deadlines are checked against
    /// it, not against this machine's clock.
    pub async fn block_time(&self) -> Result<Timestamp> {
        let block = self
            .near
            .rpc()
            .block(BlockReference::Finality(Finality::Final))
            .await?;
        Timestamp::from_nanos(block.header.timestamp.into()).context("timestamp out of range")
    }

    /// Sends `call` as `signer`.
    pub async fn call(&self, label: &str, signer: &AccountId, call: &Call) -> Result<Tx> {
        let tx = self
            .as_signer(signer)?
            .call(call.receiver.clone(), call.method)
            .args(&call.args)
            .gas(call.gas)
            .deposit(call.deposit)
            .finish();
        self.send(label, signer, tx).await
    }

    /// Sends `args`, as they are, to `receiver`'s `method`, as `signer`.
    pub async fn call_raw(
        &self,
        label: &str,
        signer: &AccountId,
        receiver: &AccountId,
        method: &str,
        args: Vec<u8>,
        gas: Gas,
    ) -> Result<Tx> {
        let tx = self
            .as_signer(signer)?
            .call(receiver.clone(), method)
            .args_raw(args)
            .gas(gas)
            .finish();
        self.send(label, signer, tx).await
    }

    pub async fn transfer(
        &self,
        label: &str,
        signer: &AccountId,
        receiver: &AccountId,
        amount: NearToken,
    ) -> Result<Tx> {
        let tx = self
            .as_signer(signer)?
            .transaction(receiver.clone())
            .transfer(amount);
        self.send(label, signer, tx).await
    }

    /// Deploys an instance by its `StateInit`.
    pub async fn state_init(
        &self,
        label: &str,
        signer: &AccountId,
        state_init: StateInit,
        deposit: NearToken,
    ) -> Result<Tx> {
        let tx = self.as_signer(signer)?.state_init(state_init, deposit);
        self.send(label, signer, tx).await
    }

    /// Sends `call` as `signer`, and waits up to `patience` for its result: a
    /// call that yields, as a request to `OutLayer` does until a worker
    /// answers, can outlast the time an RPC node holds a request open.
    pub async fn call_slow(
        &self,
        label: &str,
        signer: &AccountId,
        call: &Call,
        patience: Duration,
    ) -> Result<Tx> {
        let sent = self
            .as_signer(signer)?
            .call(call.receiver.clone(), call.method)
            .args(&call.args)
            .gas(call.gas)
            .deposit(call.deposit)
            .finish()
            .wait_until::<Included>()
            .await?;
        let waited = tokio::time::Instant::now();
        let full = loop {
            let status = self
                .near
                .tx_status(&sent.transaction_hash, signer.clone())
                .wait_until::<Final>()
                .await;
            match status {
                Ok(full) => break full,
                Err(_) if waited.elapsed() < patience => {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                Err(err) => return Err(err).with_context(|| format!("{label}: no result")),
            }
        };
        Ok(Self::report(label, signer, &full))
    }

    async fn send(&self, label: &str, signer: &AccountId, tx: TransactionBuilder) -> Result<Tx> {
        let sent = tx.wait_until::<Final>().await?;
        // `send` omits receipt bodies; `tx_status` has them.
        let full: FinalExecutionOutcome = self
            .near
            .tx_status(sent.transaction_hash(), signer.clone())
            .wait_until::<Final>()
            .await?;
        Ok(Self::report(label, signer, &full))
    }

    /// Records `outcome`, and prints how it went.
    fn report(label: &str, signer: &AccountId, outcome: &FinalExecutionOutcome) -> Tx {
        let tx = record(label, signer, outcome);
        println!(
            "  {label}: {} {} ({:.1} Tgas){}",
            if tx.ok { "ok" } else { "FAILED" },
            tx.hash,
            tx.burnt_tgas,
            tx.error
                .as_deref()
                .map(|e| format!(": {e}"))
                .unwrap_or_default(),
        );
        for r in tx.failed_receipts() {
            println!(
                "    receipt failed on {} ({}): {}",
                r.executor,
                r.action,
                r.error.as_deref().unwrap_or("?")
            );
        }
        tx
    }
}

fn record(label: &str, signer: &AccountId, outcome: &FinalExecutionOutcome) -> Tx {
    let receipts = extents_client::outcome::receipts(outcome)
        .into_iter()
        .map(|r| {
            let call = r.method.is_some();
            ReceiptRecord {
                predecessor: r.predecessor,
                executor: r.executor,
                action: r.actions.join("+"),
                attached_tgas: call.then(|| tgas(r.gas)),
                attached_yocto: call.then(|| r.attached.to_string()),
                burnt_tgas: tgas(r.burnt),
                transfer_yocto: r.transfer.map(|t| t.to_string()),
                ok: r.ok,
                error: r.error,
                value: r.value,
            }
        })
        .collect();
    let events = extents_client::outcome::events(outcome);

    Tx {
        label: label.into(),
        signer: signer.clone(),
        receiver: outcome.transaction.receiver_id.clone(),
        hash: outcome.transaction_hash().to_string(),
        ok: outcome.is_success(),
        error: outcome.failure_message(),
        value: outcome.result().ok().as_deref().and_then(json_value),
        prepaid_tgas: outcome
            .transaction
            .actions
            .iter()
            .map(|a| match a {
                ActionView::FunctionCall { gas, .. } => tgas(*gas),
                _ => 0.0,
            })
            .sum(),
        burnt_tgas: tgas(outcome.total_gas_used()),
        receipts,
        events,
    }
}

fn json_value(bytes: &[u8]) -> Option<Value> {
    serde_json::from_slice(bytes).ok()
}

/// Tgas with Mgas precision; 300 Tgas is 3e8 Mgas, well within `u32`.
pub fn tgas(gas: Gas) -> f64 {
    f64::from(u32::try_from(gas.as_gas() / 1_000_000).unwrap_or(u32::MAX)) / 1e6
}
