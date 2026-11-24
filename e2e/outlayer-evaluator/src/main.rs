//! An evaluator that is one exact program, run by OutLayer in a TEE.
//!
//! Its manifest declares an ed25519 key bound to this build and to no caller,
//! so the key's implicit account, the `evaluator` of an objective's terms,
//! can sign only what this code composes: one `auth_call` intent attesting a
//! verdict it computed from the report it was given.
//!
//! A probe, not a product. It trusts the caller for the report: nothing
//! here ties the report to what the contributors delivered on chain.

use std::io::{Read, Write};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

mod host {
    wit_bindgen::generate!({ world: "signing-keys-host", path: "wit" });
}
use host::outlayer::signing_keys::api as keys;

/// The manifest, in the custom section the worker reads. It is part of the
/// wasm, so of the hash the key is bound to.
#[cfg(target_arch = "wasm32")]
#[used]
#[unsafe(link_section = "outlayer.manifest")]
static MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

/// The manifest's key.
const KEY: &str = "evaluator";
/// The one criterion: the report contains this phrase.
const PHRASE: &str = "## Agenda";

fn main() {
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

/// Judges `input.report` and signs the verdict as an `auth_call` intent to
/// `input.objective`, in the Verifier's `raw_ed25519` form: the signature
/// covers the payload's bytes.
fn attest(input: &Value, account: &str, public_key: &[u8]) -> Result<Value, String> {
    let string = |name: &str| {
        input[name]
            .as_str()
            .ok_or_else(|| format!("`{name}` must be a string"))
    };
    if !input["params"].is_object() {
        return Err("`params` must be an object".into());
    }
    let report = string("report")?;
    let verdict = if report.contains(PHRASE) {
        "achieved"
    } else {
        "failed"
    };
    let review_hash = hex::encode(Sha256::digest(report));

    let msg = json!({
        "params": input["params"],
        "action": {
            "action": "attest",
            "data": { "verdict": verdict, "review_hash": review_hash },
        },
    });
    let payload = json!({
        "signer_id": account,
        "verifying_contract": string("verifier")?,
        "deadline": string("deadline")?,
        "nonce": string("nonce")?,
        "intents": [{
            "intent": "auth_call",
            "contract_id": string("objective")?,
            "msg": msg.to_string(),
            "min_gas": string("min_gas")?,
        }],
    })
    .to_string();
    let signature = keys::sign(KEY, None, payload.as_bytes())?;

    let ed25519 = |bytes: &[u8]| format!("ed25519:{}", bs58::encode(bytes).into_string());
    Ok(json!({
        "verdict": verdict,
        "review_hash": review_hash,
        "signed": {
            "standard": "raw_ed25519",
            "payload": payload,
            "public_key": ed25519(public_key),
            "signature": ed25519(&signature),
        },
    }))
}
