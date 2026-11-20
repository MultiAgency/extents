use serde::{Deserialize, Serialize};

use crate::{Attestation, Delivery, Params};

/// `msg` for an `auth_call` intent targeting an objective, letting a
/// contributor commit or deliver, or the evaluator attest, with a signature
/// verified by the Verifier.
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub params: Params,
    pub action: Action,
}

#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", content = "data", rename_all = "snake_case")]
pub enum Action {
    Commit,
    Deliver(Delivery),
    Attest(Attestation),
}
