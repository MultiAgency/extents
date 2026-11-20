//! A transaction's final outcome, read as the objective's callers check it:
//! each action receipt and how it went, and the `extents-objective` events
//! that took effect.

use std::collections::HashMap;

use near_kit::{
    AccountId, Gas,
    rpc::{ActionView, FinalExecutionOutcome, ReceiptContent},
};
use serde_json::Value;

/// One action receipt of a transaction.
#[derive(Debug, Clone)]
pub struct Receipt {
    pub predecessor: AccountId,
    pub executor: AccountId,
    /// Each action's name: the function called, `transfer`, or the action's
    /// kind.
    pub actions: Vec<String>,
    /// The function called, or `None` if no action is a function call.
    pub method: Option<String>,
    /// NEAR attached to the function call, in yocto.
    pub attached: u128,
    /// Gas attached to the function call.
    pub gas: Gas,
    /// NEAR moved by a `Transfer` action, in yocto.
    pub transfer: Option<u128>,
    pub burnt: Gas,
    pub ok: bool,
    pub error: Option<String>,
    /// The return value, if it is JSON.
    pub value: Option<Value>,
}

/// Every action receipt of `outcome`, which must come from `tx_status`: a
/// plain `send` omits receipt bodies.
pub fn receipts(outcome: &FinalExecutionOutcome) -> Vec<Receipt> {
    let bodies: HashMap<_, _> = outcome.receipts.iter().map(|r| (r.receipt_id, r)).collect();
    outcome
        .receipts_outcome
        .iter()
        .filter_map(|o| {
            let body = bodies.get(&o.id)?;
            let ReceiptContent::Action(action) = &body.receipt else {
                return None;
            };
            let mut receipt = Receipt {
                predecessor: body.predecessor_id.clone(),
                executor: o.outcome.executor_id.clone(),
                actions: Vec::new(),
                method: None,
                attached: 0,
                gas: Gas::from_gas(0),
                transfer: None,
                burnt: o.outcome.gas_burnt,
                ok: o.outcome.status.is_success(),
                error: o.outcome.status.failure().map(|e| format!("{e:?}")),
                value: o
                    .outcome
                    .status
                    .success_value()
                    .and_then(|bytes| serde_json::from_slice(bytes).ok()),
            };
            for a in &action.actions {
                match a {
                    ActionView::FunctionCall {
                        method_name,
                        gas,
                        deposit,
                        ..
                    } => {
                        receipt.actions.push(method_name.clone());
                        receipt.method = Some(method_name.clone());
                        receipt.attached = deposit.as_yoctonear();
                        receipt.gas = *gas;
                    }
                    ActionView::Transfer { deposit } => {
                        receipt.actions.push("transfer".into());
                        receipt.transfer = Some(deposit.as_yoctonear());
                    }
                    other => receipt.actions.push(action_name(other)),
                }
            }
            Some(receipt)
        })
        .collect()
}

/// The `extents-objective` events of `outcome`'s successful receipts. A
/// failed receipt keeps its logs although its state changes are reverted,
/// so its events did not happen.
pub fn events(outcome: &FinalExecutionOutcome) -> Vec<Value> {
    outcome
        .receipts_outcome
        .iter()
        .filter(|r| r.outcome.status.is_success())
        .flat_map(|r| &r.outcome.logs)
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .filter_map(|json| serde_json::from_str::<Value>(json).ok())
        .filter(|e| e["standard"] == "extents-objective")
        .collect()
}

/// The variant name of an action that is neither a call nor a transfer.
fn action_name(action: &ActionView) -> String {
    format!("{action:?}")
        .split(|c: char| !c.is_alphanumeric())
        .next()
        .unwrap_or_default()
        .to_owned()
}
