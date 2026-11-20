//! Signed intents for testnet, built by `extents-client`.

use std::time::Duration;

use anyhow::Result;
use extents_client::Payload;
use near_kit::AccountId;
use serde_json::{Value, json};

use crate::chain::Chain;

/// How long a signed intent, and its nonce, remain valid, in block time.
const INTENT_TTL: Duration = Duration::from_mins(5);

/// Signs `intents` as `signer`, expiring [`INTENT_TTL`] after the latest
/// block's time: the Verifier checks deadlines against block time, not
/// this machine's clock.
pub async fn sign(chain: &Chain, signer: &AccountId, intents: &[Value]) -> Result<Value> {
    let salt: String = chain
        .view(&chain.verifier, "current_salt", &json!({}))
        .await?;
    Payload::new(
        signer,
        &chain.verifier,
        &salt,
        chain.block_time().await? + INTENT_TTL,
        intents,
    )?
    .sign(&chain.signer(signer)?)
    .await
}
