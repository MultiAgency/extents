//! Reading a delivery from the chain, through the one RPC this build names.
//!
//! The endpoint is a constant of the program, so of the hash its key is bound
//! to: the worker's operator cannot choose who answers. The answer is still
//! that provider's word; nothing here checks a proof.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The RPC the program asks, on testnet. A build for another network is
/// another build, with another key.
pub const RPC: &str = "https://rpc.testnet.fastnear.com";
/// The objective's event standard.
const STANDARD: &str = "extents-objective";

/// The JSON-RPC request for the finalized transaction `tx`, with its receipts.
pub fn request(tx: &str, signer: &str) -> Vec<u8> {
    json!({
        "jsonrpc": "2.0",
        "id": "extents",
        "method": "EXPERIMENTAL_tx_status",
        "params": { "tx_hash": tx, "sender_account_id": signer, "wait_until": "FINAL" },
    })
    .to_string()
    .into_bytes()
}

/// The contributor whose delivery of `report` to `objective` the RPC's answer
/// for `tx` records, and the report's SHA-256.
///
/// The delivery is a `delivered` event with the report's hash, logged by a
/// receipt that `objective` executed and that succeeded: a failed receipt
/// keeps its logs.
pub fn delivered(
    tx: &str,
    status: u16,
    body: &[u8],
    objective: &str,
    report: &str,
) -> Result<(String, [u8; 32]), String> {
    if status != 200 {
        return Err(format!("{tx}: the RPC answered {status}"));
    }
    let answer: Value = serde_json::from_slice(body).map_err(|e| format!("{tx}: {e}"))?;
    if let Some(error) = answer.get("error") {
        return Err(format!("{tx}: {error}"));
    }
    let result = &answer["result"];
    if result["final_execution_status"] != "FINAL" {
        return Err(format!("{tx} is not final"));
    }

    let sha256: [u8; 32] = Sha256::digest(report).into();
    let hash = hex::encode(sha256);
    result["receipts_outcome"]
        .as_array()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::judge::HOSTS;

    const TX: &str = "GbbyvH1X6TUYAFSk3reze9esesqRiTrwgF7tV8WAzS18";
    const OBJECTIVE: &str = "0sobjective";
    const REPORT: &str = "## Summary\n";

    /// An RPC answer whose one receipt, run by `executor` with `status`,
    /// logged a delivery of `report` by `alice.testnet`.
    fn answer(executor: &str, status: Value, report: &str) -> Vec<u8> {
        let event = json!({
            "standard": STANDARD,
            "event": "delivered",
            "data": { "contributor": "alice.testnet", "hash": hex::encode(Sha256::digest(report)) },
        });
        json!({
            "jsonrpc": "2.0",
            "id": "extents",
            "result": {
                "final_execution_status": "FINAL",
                "receipts_outcome": [{ "outcome": {
                    "executor_id": executor,
                    "status": status,
                    "logs": [format!("EVENT_JSON:{event}")],
                }}],
            },
        })
        .to_string()
        .into_bytes()
    }

    fn succeeded() -> Value {
        json!({ "SuccessValue": "" })
    }

    #[test]
    fn a_delivery_logged_by_the_objective_names_its_contributor() {
        let body = answer(OBJECTIVE, succeeded(), REPORT);
        let (contributor, sha256) = delivered(TX, 200, &body, OBJECTIVE, REPORT).unwrap();
        assert_eq!(contributor, "alice.testnet");
        assert_eq!(sha256, <[u8; 32]>::from(Sha256::digest(REPORT)));
    }

    #[test]
    fn another_report_another_objective_or_a_failed_receipt_is_no_delivery() {
        let failed = json!({ "Failure": {} });
        for (body, report) in [
            (answer(OBJECTIVE, succeeded(), "another report"), REPORT),
            (answer("0sother", succeeded(), REPORT), REPORT),
            (answer(OBJECTIVE, failed, REPORT), REPORT),
        ] {
            let error = delivered(TX, 200, &body, OBJECTIVE, report).unwrap_err();
            assert!(error.contains("records no delivery"), "{error}");
        }
    }

    #[test]
    fn an_rpc_error_a_bad_status_or_an_unfinished_transaction_is_refused() {
        let error = json!({ "error": { "name": "HANDLER_ERROR" } }).to_string();
        assert!(
            delivered(TX, 200, error.as_bytes(), OBJECTIVE, REPORT)
                .unwrap_err()
                .contains("HANDLER_ERROR")
        );
        assert!(
            delivered(TX, 429, b"", OBJECTIVE, REPORT)
                .unwrap_err()
                .contains("429")
        );
        let pending = json!({ "result": { "final_execution_status": "EXECUTED" } }).to_string();
        assert!(
            delivered(TX, 200, pending.as_bytes(), OBJECTIVE, REPORT)
                .unwrap_err()
                .contains("not final")
        );
    }

    /// The query waits for the transaction to be final and asks for its
    /// receipts, which hold the logs.
    #[test]
    fn the_request_asks_for_the_final_transaction_with_its_receipts() {
        let request: Value = serde_json::from_slice(&request(TX, "alice.testnet")).unwrap();
        assert_eq!(request["method"], "EXPERIMENTAL_tx_status");
        assert_eq!(
            request["params"],
            json!({ "tx_hash": TX, "sender_account_id": "alice.testnet", "wait_until": "FINAL" })
        );
    }

    /// The manifest lets the program reach the evidence hosts and this RPC,
    /// and nothing else.
    #[test]
    fn the_manifest_names_the_evidence_hosts_and_the_rpc() {
        let manifest: Value = serde_json::from_str(include_str!("../manifest.json")).unwrap();
        let mut expected: Vec<&str> = HOSTS.to_vec();
        expected.push(RPC.strip_prefix("https://").unwrap());
        assert_eq!(manifest["capabilities"]["network"], json!(expected));
    }
}
