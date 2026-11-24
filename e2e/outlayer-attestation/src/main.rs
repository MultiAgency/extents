//! Checks the attestation of one run of a program on OutLayer's testnet,
//! from sources OutLayer does not control where there is one:
//!
//! - what was asked and answered, from the request's transaction on chain;
//! - the quote's signature chain, against collateral from Intel's own
//!   service and the Intel root certificate compiled into `dcap-qvl`;
//! - the worker build's measurements, against the register contract's list.
//!
//! Only the quote itself comes from OutLayer's API.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use dcap_qvl::{collateral::get_collateral_from_pcs, quote::Report, verify::ring::verify};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const API: &str = "https://testnet-api.outlayer.ai";
const RPC: &str = "https://test.rpc.fastnear.com";
/// Where worker builds are approved.
const REGISTER: &str = "worker.outlayer.testnet";

fn sha256(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes))
}

async fn rpc(client: &reqwest::Client, method: &str, params: Value) -> Result<Value> {
    let answer: Value = client
        .post(RPC)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await?
        .json()
        .await?;
    if let Some(error) = answer.get("error") {
        bail!("{method}: {error}");
    }
    Ok(answer["result"].clone())
}

/// `value[name]`, a string.
fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("no string `{name}`"))
}

/// The hash a worker puts in a quote's report data: the task's fields, one
/// after another. Text is its bytes; an integer is eight little-endian
/// bytes. A direct run of a wasm URL has no repository, project or secrets.
fn task_hash(record: &Value) -> Result<String> {
    let integer = |name: &str| {
        record[name]
            .as_i64()
            .with_context(|| format!("no integer `{name}`"))
    };
    let mut task = Vec::new();
    task.extend(text(record, "task_type")?.bytes());
    task.extend(integer("task_id")?.to_le_bytes());
    task.extend(text(record, "build_target")?.bytes());
    task.extend(text(record, "wasm_hash")?.bytes());
    task.extend(text(record, "input_hash")?.bytes());
    task.extend(text(record, "output_hash")?.bytes());
    task.extend(integer("block_height")?.to_le_bytes());
    task.extend(text(record, "caller_account_id")?.bytes());
    task.extend(integer("timestamp")?.to_le_bytes());
    task.extend(text(record, "attached_usd")?.bytes());
    Ok(sha256(task))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [tx_hash, signer, wasm] = &args[..] else {
        bail!("usage: outlayer-attestation <tx hash> <tx signer> <wasm file>");
    };
    let wasm_hash = sha256(std::fs::read(wasm).with_context(|| format!("reading {wasm}"))?);
    let client = reqwest::Client::builder().user_agent("extents").build()?;

    // What the chain says was asked and answered.
    let tx = rpc(
        &client,
        "EXPERIMENTAL_tx_status",
        json!({ "tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "FINAL" }),
    )
    .await?;
    let call = &tx["transaction"]["actions"][0]["FunctionCall"];
    ensure!(
        tx["transaction"]["receiver_id"] == "outlayer.testnet"
            && call["method_name"] == "request_execution",
        "{tx_hash} is not a request to OutLayer"
    );
    let request: Value = serde_json::from_slice(&BASE64.decode(text(call, "args")?)?)?;
    let input = text(&request, "input_data")?;
    let output = BASE64.decode(text(&tx["status"], "SuccessValue").context("the run failed")?)?;
    ensure!(
        request["source"]["WasmUrl"]["hash"] == wasm_hash.as_str(),
        "the request ran another wasm than {wasm}"
    );

    // What the worker attested, which must be the same.
    let record: Value = client
        .get(format!("{API}/attestations/by-tx/{tx_hash}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    ensure!(
        record["wasm_hash"] == wasm_hash.as_str()
            && record["executed_wasm_sha256"] == wasm_hash.as_str(),
        "the attestation names another wasm"
    );
    ensure!(
        record["input_hash"] == sha256(input).as_str(),
        "the attestation names another input"
    );
    ensure!(
        record["output_hash"] == sha256(&output).as_str(),
        "the attestation names another output"
    );
    ensure!(
        record["caller_account_id"] == signer.as_str()
            && tx["transaction"]["signer_id"] == signer.as_str(),
        "the attestation names another caller"
    );
    println!("wasm    {wasm_hash}");
    println!("input   {input}");
    println!("output  {}", String::from_utf8_lossy(&output));

    // The quote: signed up to Intel's root, on a current platform.
    let quote = BASE64.decode(text(&record, "tdx_quote")?)?;
    let collateral = get_collateral_from_pcs(&quote)
        .await
        .context("collateral from Intel")?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let verified = verify(&quote, &collateral, now).map_err(|e| anyhow::anyhow!("quote: {e:?}"))?;
    ensure!(
        verified.status == "UpToDate" && verified.advisory_ids.is_empty(),
        "platform is {} with advisories {:?}",
        verified.status,
        verified.advisory_ids
    );
    let Report::TD10(td) = &verified.report else {
        bail!("not a TDX report");
    };
    ensure!(td.td_attributes[0] & 1 == 0, "the TD is in debug mode");
    println!("quote   verifies to Intel's root; platform UpToDate, no advisories, not debug");

    // The quote is over this task, and nothing else.
    ensure!(
        hex::encode(&td.report_data[..32]) == task_hash(&record)?
            && td.report_data[32..] == [0; 32],
        "the quote is not over this task"
    );
    println!("task    the quote's report data is the hash of this wasm, input and output");

    // The worker's build is one the register contract approves.
    let measurements = json!({
        "mrtd": hex::encode(td.mr_td),
        "rtmr0": hex::encode(td.rt_mr0),
        "rtmr1": hex::encode(td.rt_mr1),
        "rtmr2": hex::encode(td.rt_mr2),
        "rtmr3": hex::encode(td.rt_mr3),
    });
    let approved = rpc(
        &client,
        "query",
        json!({
            "request_type": "call_function",
            "finality": "final",
            "account_id": REGISTER,
            "method_name": "is_measurements_approved",
            "args_base64": BASE64.encode(json!({ "measurements": measurements }).to_string()),
        }),
    )
    .await?;
    ensure!(
        approved["result"] == json!(b"true"),
        "the worker's build is not approved by {REGISTER}"
    );
    println!(
        "build   rtmr3 {}… is approved by {REGISTER}",
        &hex::encode(td.rt_mr3)[..16]
    );
    println!("VERIFIED");
    Ok(())
}
