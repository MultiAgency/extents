use serde::{Deserialize, Serialize};

use crate::Params;

/// `msg` for `mt_transfer_call()` into an objective.
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferMessage {
    pub params: Params,
    pub action: TransferAction,
}

#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", content = "data", rename_all = "snake_case")]
pub enum TransferAction {
    Fund,
}
