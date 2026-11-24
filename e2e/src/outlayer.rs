//! `OutLayer` on testnet: a WASI program run in its TEE workers, requested on
//! chain. The request's transaction returns what the program printed.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
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
/// The most of a file one call carries.
const FASTFS_PART: usize = 1 << 20;
/// Parts of one upload share a nonce: seconds since this moment, as
/// `OutLayer`'s CLI counts them.
const FASTFS_EPOCH: u64 = 1_769_376_240;
/// How long `FastFS` may take to index an upload.
const FASTFS_WAIT: Duration = Duration::from_mins(5);
/// How long a worker may take to answer a request.
const RUN_WAIT: Duration = Duration::from_mins(5);
/// The output's storage, paid in advance; what a run does not use returns.
const OUTPUT_BYTES: usize = 8192;

/// One part of a file, at `offset` of `full_size` bytes.
#[derive(BorshSerialize)]
struct FastfsPart<'a> {
    relative_path: &'a str,
    offset: u32,
    full_size: u32,
    mime_type: &'a str,
    content_chunk: &'a [u8],
    nonce: u32,
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

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_secs()
            .saturating_sub(FASTFS_EPOCH);
        let parts = wasm.chunks(FASTFS_PART);
        let count = parts.len();
        for (i, part) in parts.enumerate() {
            // The variant of a file in parts, then the part.
            let mut args = vec![1u8];
            FastfsPart {
                relative_path: &path,
                offset: u32::try_from(i * FASTFS_PART)?,
                full_size: u32::try_from(wasm.len())?,
                mime_type: "application/wasm",
                content_chunk: part,
                nonce: u32::try_from(nonce)?,
            }
            .serialize(&mut args)?;
            // Nothing implements the method: the call fails, and FastFS
            // indexes its arguments anyway. One gas keeps the failure cheap.
            chain
                .call_raw(
                    &format!(
                        "upload the program to FastFS, part {} of {count} (fails by design)",
                        i + 1
                    ),
                    uploader,
                    &CONTRACT.parse()?,
                    FASTFS_METHOD,
                    args,
                    Gas::from_gas(1),
                )
                .await?;
        }

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
    /// Returns the request's transaction and the program's output, which is
    /// `{"error": ..}` when the program refuses.
    pub async fn run(
        &self,
        chain: &Chain,
        label: &str,
        caller: &AccountId,
        input: &Value,
    ) -> Result<(Tx, Value)> {
        let contract: AccountId = CONTRACT.parse()?;
        let limits = json!({
            "max_instructions": 10_000_000_000u64,
            "max_memory_mb": 128,
            "max_execution_seconds": 60,
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
        let tx = chain.call_slow(label, caller, &call, RUN_WAIT).await?;
        let output = tx
            .value
            .clone()
            .with_context(|| format!("{label}: no output; {:?}", tx.error))?;
        Ok((tx, output))
    }
}
