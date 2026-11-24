//! The program as the worker runs it: its input and output, and the host
//! interfaces it reads the chain, fetches pages and signs through.

use std::{
    collections::BTreeMap,
    io::{Read, Write},
    time::Duration,
};

use extents_spec::{Deliverable, Outcome, Review, Spec, VERSION, Verdict};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wasi_http_client::Client;

use crate::judge::{Page, judge};

mod keys_host {
    wit_bindgen::generate!({ world: "signing-keys-host", path: "wit" });
}
mod rpc_host {
    wit_bindgen::generate!({ world: "rpc-test", path: "wit-rpc" });
}
use keys_host::outlayer::signing_keys::api as keys;
use rpc_host::near::rpc::api as rpc;

/// The manifest, in the custom section the worker reads. It is part of the
/// wasm, so of the hash the key is bound to.
#[used]
#[unsafe(link_section = "outlayer.manifest")]
static MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

/// The manifest's key.
const KEY: &str = "evaluator";
/// The objective's event standard.
const STANDARD: &str = "extents-objective";

pub fn main() {
    let mut input = String::new();
    let answer = std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())
        .and_then(|_| run(&input))
        .unwrap_or_else(|error| json!({ "error": error }));
    let mut out = std::io::stdout();
    let _ = write!(out, "{answer}").and_then(|()| out.flush());
}

fn run(input: &str) -> Result<Value, String> {
    let input: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let public_key = keys::public_key(KEY, None)?;
    // An ed25519 key's implicit account is the hex of its public key.
    let account = hex::encode(&public_key);
    match input["operation"].as_str() {
        Some("account") => Ok(json!({ "account_id": account })),
        Some("attest") => attest(&input, &account, &public_key),
        _ => Err("`operation` must be `account` or `attest`".into()),
    }
}

/// `value[name]`, a string.
fn string<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value[name]
        .as_str()
        .ok_or_else(|| format!("`{name}` must be a string"))
}

/// The contributor whose delivery of `delivery.report` to `objective` the
/// finalized transaction `delivery.tx` records, and the report's SHA-256.
///
/// The delivery is a `delivered` event with the report's hash, logged by a
/// receipt that `objective` executed and that succeeded: a failed receipt
/// keeps its logs.
fn delivered(objective: &str, delivery: &Value) -> Result<(String, [u8; 32]), String> {
    let tx = string(delivery, "tx")?;
    let sha256: [u8; 32] = Sha256::digest(string(delivery, "report")?).into();
    let hash = hex::encode(sha256);

    let (status, error) = rpc::tx_status(tx, string(delivery, "signer")?, "FINAL");
    if !error.is_empty() {
        return Err(format!("{tx}: {error}"));
    }
    let status: Value = serde_json::from_str(&status).map_err(|e| e.to_string())?;
    let status = status.get("result").unwrap_or(&status);
    if status["final_execution_status"] != "FINAL" {
        return Err(format!("{tx} is not final"));
    }

    let receipts = status["receipts_outcome"].as_array();
    receipts
        .into_iter()
        .flatten()
        .map(|receipt| &receipt["outcome"])
        .filter(|outcome| {
            outcome["executor_id"] == objective
                && (outcome["status"].get("SuccessValue").is_some()
                    || outcome["status"].get("SuccessReceiptId").is_some())
        })
        .flat_map(|outcome| outcome["logs"].as_array().into_iter().flatten())
        .filter_map(|log| log.as_str()?.strip_prefix("EVENT_JSON:"))
        .filter_map(|event| serde_json::from_str::<Value>(event).ok())
        .find(|event| {
            event["standard"] == STANDARD
                && event["event"] == "delivered"
                && event["data"]["hash"] == hash.as_str()
        })
        .and_then(|event| event["data"]["contributor"].as_str().map(str::to_owned))
        .map(|contributor| (contributor, sha256))
        .ok_or_else(|| format!("{tx} records no delivery of this report to {objective}"))
}

/// Fetches `url`, which `judge` has found the spec to name on a host of the
/// manifest. A redirect is not followed: its status is the answer.
fn fetch(url: &str) -> Page {
    let response = Client::new()
        .get(url)
        .header("User-Agent", "extents-evaluator")
        .header("Accept", "application/vnd.github+json")
        .connect_timeout(Duration::from_secs(10))
        .send();
    match response {
        Ok(response) => {
            let status = response.status();
            match response.body() {
                Ok(body) => Page::Loaded { status, body },
                Err(e) => Page::Unavailable(e.to_string()),
            }
        }
        Err(e) => Page::Unavailable(e.to_string()),
    }
}

/// Judges the reports of `input.deliveries`, each checked against the chain,
/// by `input.spec`, which must be the one the terms commit to. Signs the
/// verdict as an `auth_call` intent to `input.objective`, in the Verifier's
/// `raw_ed25519` form: the signature covers the payload's bytes.
///
/// The deliveries are read from the account the intent is addressed to, so a
/// verdict cannot be obtained from one contract's events and spent on another.
fn attest(input: &Value, account: &str, public_key: &[u8]) -> Result<Value, String> {
    let objective = string(input, "objective")?;
    let params = &input["params"];

    let spec = serde_json::to_vec(&input["spec"]).map_err(|e| e.to_string())?;
    let spec = Spec::from_json(&spec).map_err(|e| format!("`spec`: {e}"))?;
    let spec_hash = spec.hash().map_err(|e| e.to_string())?;
    if params["spec_hash"] != hex::encode(spec_hash).as_str() {
        return Err("`spec` is not the one `params.spec_hash` commits to".into());
    }

    let slots = params["contributors"]
        .as_object()
        .ok_or("`params.contributors` must be an object")?
        .len();
    let mut reports = Vec::new();
    let mut deliveries = BTreeMap::new();
    for delivery in input["deliveries"].as_array().into_iter().flatten() {
        let (contributor, sha256) = delivered(objective, delivery)?;
        reports.push(string(delivery, "report")?);
        deliveries.insert(contributor, sha256);
    }
    if deliveries.len() != slots {
        return Err(format!(
            "{} of {slots} slots have a delivery to judge",
            deliveries.len()
        ));
    }

    let results = judge(&spec, &reports, &mut fetch).map_err(|refusal| refusal.to_string())?;
    let verdict = if results.iter().all(|r| r.outcome == Outcome::Pass) {
        Verdict::Achieved
    } else {
        Verdict::Failed
    };
    let review = Review {
        v: VERSION,
        objective: objective.parse().map_err(|e| format!("`objective`: {e}"))?,
        spec_hash,
        deliverables: deliveries
            .into_iter()
            .map(|(contributor, sha256)| {
                Ok(Deliverable {
                    contributor: contributor.parse().map_err(|e| format!("{e}"))?,
                    sha256,
                })
            })
            .collect::<Result<_, String>>()?,
        missing: Vec::new(),
        results,
        llm_calls: Vec::new(),
        verdict,
        // This build cannot read its own hash: it records the one the spec
        // pins, and only this build's key signs for the account in the terms.
        evaluator_build: spec.evaluator_build,
    };
    review.validate(&spec).map_err(|e| e.to_string())?;
    let review_hash = hex::encode(review.hash().map_err(|e| e.to_string())?);
    let review = serde_json::to_value(&review).map_err(|e| e.to_string())?;

    let msg = json!({
        "params": params,
        "action": {
            "action": "attest",
            "data": { "verdict": review["verdict"], "review_hash": review_hash },
        },
    });
    let payload = json!({
        "signer_id": account,
        "verifying_contract": string(input, "verifier")?,
        "deadline": string(input, "deadline")?,
        "nonce": string(input, "nonce")?,
        "intents": [{
            "intent": "auth_call",
            "contract_id": objective,
            "msg": msg.to_string(),
            "min_gas": string(input, "min_gas")?,
        }],
    })
    .to_string();
    let signature = keys::sign(KEY, None, payload.as_bytes())?;

    let ed25519 = |bytes: &[u8]| format!("ed25519:{}", bs58::encode(bytes).into_string());
    Ok(json!({
        "review": review,
        "signed": {
            "standard": "raw_ed25519",
            "payload": payload,
            "public_key": ed25519(public_key),
            "signature": ed25519(&signature),
        },
    }))
}
