//! `OutLayer` on testnet: a WASI program run in its TEE workers, requested on
//! chain. The request's transaction returns what the program printed.

use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use borsh::BorshSerialize;
use extents_client::objective::Call;
use near_kit::{AccountId, Gas, NearToken};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::chain::{Chain, Tx};

/// The contract that takes requests, and the receiver its CLI uploads under.
const CONTRACT: &str = "outlayer.testnet";
/// `FastFS` serves a file from the arguments of a call to this method, at
/// `https://<host>/<sender>/<receiver>/<path>`.
const FASTFS_METHOD: &str = "__fastdata_fastfs";
const FASTFS_HOST: &str = "test.fastfs.io";
/// A larger file is uploaded in parts, which this does not do.
const FASTFS_MAX: usize = 1 << 20;
/// How long `FastFS` may take to index an upload.
const FASTFS_WAIT: Duration = Duration::from_mins(5);
/// The output's storage, paid in advance; what a run does not use returns.
const OUTPUT_BYTES: usize = 4096;

#[derive(BorshSerialize)]
struct FastfsFile<'a> {
    relative_path: &'a str,
    content: Option<FastfsContent<'a>>,
}

#[derive(BorshSerialize)]
struct FastfsContent<'a> {
    mime_type: &'a str,
    content: &'a [u8],
}

/// A wasm where `OutLayer`'s workers can fetch it, run directly by its URL:
/// the only way a key bound to the code is issued.
pub struct Program {
    pub url: String,
    pub sha256: [u8; 32],
}

impl Program {
    /// Uploads `wasm` to `FastFS` as `uploader`, unless it is already served.
    pub async fn publish(chain: &Chain, uploader: &AccountId, wasm: &[u8]) -> Result<Self> {
        ensure!(wasm.len() <= FASTFS_MAX, "wasm is over 1 MiB");
        let sha256: [u8; 32] = Sha256::digest(wasm).into();
        let path = format!("{}.wasm", hex::encode(sha256));
        let program = Self {
            url: format!("https://{FASTFS_HOST}/{uploader}/{CONTRACT}/{path}"),
            sha256,
        };
        if program.served().await {
            println!("  already served at {}", program.url);
            return Ok(program);
        }

        // The file's variant, then the file.
        let mut args = vec![0u8];
        FastfsFile {
            relative_path: &path,
            content: Some(FastfsContent {
                mime_type: "application/wasm",
                content: wasm,
            }),
        }
        .serialize(&mut args)?;
        // Nothing implements the method: the call fails, and FastFS indexes
        // its arguments anyway. One gas keeps the failure cheap.
        chain
            .call_raw(
                "upload the program to FastFS (fails by design)",
                uploader,
                &CONTRACT.parse()?,
                FASTFS_METHOD,
                args,
                Gas::from_gas(1),
            )
            .await?;

        let waited = tokio::time::Instant::now();
        while !program.served().await {
            ensure!(
                waited.elapsed() < FASTFS_WAIT,
                "{} is not served {}s after its upload",
                program.url,
                FASTFS_WAIT.as_secs()
            );
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
        println!("  served at {}", program.url);
        Ok(program)
    }

    /// Whether the URL serves exactly this wasm.
    async fn served(&self) -> bool {
        let Ok(response) = reqwest::get(&self.url).await else {
            return false;
        };
        let Ok(bytes) = response.bytes().await else {
            return false;
        };
        <[u8; 32]>::from(Sha256::digest(&bytes)) == self.sha256
    }

    /// Runs the program on `input`, requested and paid for by `caller`.
    /// Returns the request's transaction and the program's output.
    pub async fn run(
        &self,
        chain: &Chain,
        label: &str,
        caller: &AccountId,
        input: &Value,
    ) -> Result<(Tx, Value)> {
        let contract: AccountId = CONTRACT.parse()?;
        let limits = json!({
            "max_instructions": 1_000_000_000u64,
            "max_memory_mb": 128,
            "max_execution_seconds": 10,
        });
        let input = input.to_string();
        let cost: String = chain
            .view(
                &contract,
                "estimate_execution_cost",
                &json!({
                    "resource_limits": limits,
                    "input_len": input.len(),
                    "output_len": OUTPUT_BYTES,
                }),
            )
            .await?;
        let call = Call {
            receiver: contract,
            method: "request_execution",
            args: json!({
                "source": { "WasmUrl": {
                    "url": self.url,
                    "hash": hex::encode(self.sha256),
                    "build_target": "wasm32-wasip2",
                } },
                "resource_limits": limits,
                "input_data": input,
                "secrets_ref": null,
                "response_format": "Json",
                "payer_account_id": null,
                "params": null,
            }),
            gas: Gas::from_tgas(300),
            deposit: NearToken::from_yoctonear(cost.parse()?),
        };
        let tx = chain.call(label, caller, &call).await?;
        let output = tx
            .value
            .clone()
            .with_context(|| format!("{label}: no output; {:?}", tx.error))?;
        if let Some(error) = output["error"].as_str() {
            bail!("{label}: the program refused: {error}");
        }
        Ok((tx, output))
    }
}
