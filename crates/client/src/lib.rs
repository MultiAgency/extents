//! Signed NEAR Intents, in the wire format of the Verifier's `defuse`
//! v0.4.5: a NEP-413 `MultiPayload` whose message carries the intents, with a
//! versioned, salted, expirable nonce.
//!
//! A [`Payload`] is built first and signed separately, so the signature can
//! come from a local key ([`Payload::sign`]) or from elsewhere, such as a DAO
//! asking the MPC signer to sign [`Payload::hash`] by vote
//! ([`Payload::signed`]).
//!
//! The payload is written out here rather than built from `defuse-core`,
//! because the sibling `intents` checkout is ahead of the deployed build.

pub mod objective;
pub mod outcome;

use anyhow::{Context, Result, anyhow};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use borsh::BorshSerialize;
use extents_objective::Timestamp;
use near_kit::{
    AccountId, Gas,
    signer::Signer,
    standards::nep413::{SignMessageParams, serialize_message},
};
use serde_json::{Value, json};

/// sha256 of the Verifier build whose wire format this crate writes.
///
/// That is `defuse` v0.4.5, deployed at mainnet `intents.near` and testnet
/// `verifier.tidepool-sandbox.testnet` (NEAR code hash
/// `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`).
pub const VERIFIER_SHA256: &str =
    "a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547";

/// `VersionedNonce::VERSIONED_MAGIC_PREFIX` in `defuse-core` v0.4.5.
const VERSIONED_NONCE_PREFIX: [u8; 4] = [0x56, 0x28, 0xf6, 0xc6];

/// The borsh layout, in `defuse-core` v0.4.5, of
/// `VersionedNonce::V1(SaltedNonce<ExpirableNonce<[u8; 15]>>)`.
#[derive(BorshSerialize)]
struct NonceV1 {
    version: u8,
    salt: [u8; 4],
    deadline_nanos: i64,
    random: [u8; 15],
}

/// An intent that makes the Verifier call `contract_id.on_auth(signer, msg)`
/// with at least `min_gas`.
pub struct AuthCall<'a> {
    pub contract_id: &'a AccountId,
    pub msg: &'a str,
    pub min_gas: Option<Gas>,
}

impl AuthCall<'_> {
    pub fn intent(&self) -> Value {
        let mut intent = json!({
            "intent": "auth_call",
            "contract_id": self.contract_id,
            "msg": self.msg,
        });
        if let Some(gas) = self.min_gas {
            intent["min_gas"] = gas.as_gas().to_string().into();
        }
        intent
    }
}

/// A transfer on the Verifier of `amount` of `token` (a Verifier token id,
/// e.g. `nep141:usdc.near`) to `receiver_id`. With `msg`, the Verifier also
/// calls the receiver's `mt_on_transfer` with it.
pub fn transfer(receiver_id: &AccountId, token: &str, amount: u128, msg: Option<&str>) -> Value {
    let mut intent = json!({
        "intent": "transfer",
        "receiver_id": receiver_id,
        "tokens": { token: amount.to_string() },
    });
    if let Some(msg) = msg {
        intent["msg"] = msg.into();
    }
    intent
}

/// A NEP-413 payload for the Verifier, ready to be signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payload {
    /// JSON with `signer_id`, `deadline` and `intents`.
    pub message: String,
    pub nonce: [u8; 32],
    /// The Verifier's account id.
    pub recipient: String,
}

impl Payload {
    /// `intents` signed by `signer_id`, for `verifier`.
    ///
    /// `salt` is the Verifier's `current_salt` (hex). `deadline` bounds both
    /// the intents and the nonce, and is compared with block time, so it must
    /// come from the target chain's clock.
    pub fn new(
        signer_id: &AccountId,
        verifier: &AccountId,
        salt: &str,
        deadline: Timestamp,
        intents: &[Value],
    ) -> Result<Self> {
        let mut nonce = [0u8; 32];
        let mut writer = &mut nonce[..];
        (
            VERSIONED_NONCE_PREFIX,
            NonceV1 {
                version: 0,
                salt: hex::decode(salt)?
                    .try_into()
                    .map_err(|_| anyhow!("salt is not 4 bytes: {salt}"))?,
                deadline_nanos: i64::try_from(deadline.as_nanos())?,
                random: rand::random(),
            },
        )
            .serialize(&mut writer)?;

        Ok(Self {
            message: json!({
                "signer_id": signer_id,
                "deadline": deadline,
                "intents": intents,
            })
            .to_string(),
            nonce,
            recipient: verifier.to_string(),
        })
    }

    fn params(&self) -> SignMessageParams {
        SignMessageParams {
            message: self.message.clone(),
            recipient: self.recipient.clone(),
            nonce: self.nonce,
            callback_url: None,
            state: None,
        }
    }

    /// The NEP-413 hash an Ed25519 signature covers.
    pub fn hash(&self) -> [u8; 32] {
        *serialize_message(&self.params()).as_bytes()
    }

    /// `{message, nonce, recipient}`, as the Verifier reads it.
    pub fn to_json(&self) -> Value {
        json!({
            "message": self.message,
            "nonce": BASE64.encode(self.nonce),
            "recipient": self.recipient,
        })
    }

    pub fn from_json(value: &Value) -> Result<Self> {
        let field = |name: &str| {
            value[name]
                .as_str()
                .with_context(|| format!("payload has no string `{name}`"))
        };
        Ok(Self {
            message: field("message")?.to_owned(),
            nonce: BASE64
                .decode(field("nonce")?)?
                .try_into()
                .map_err(|_| anyhow!("nonce is not 32 bytes"))?,
            recipient: field("recipient")?.to_owned(),
        })
    }

    /// The `MultiPayload` for `execute_intents`, with a signature made
    /// elsewhere. Both are in NEAR's `ed25519:<base58>` form.
    pub fn signed(&self, public_key: &str, signature: &str) -> Value {
        json!({
            "standard": "nep413",
            "payload": self.to_json(),
            "public_key": public_key,
            "signature": signature,
        })
    }

    /// Signs with `signer`'s key.
    pub async fn sign(&self, signer: &(impl Signer + ?Sized)) -> Result<Value> {
        let signature = signer
            .key()
            .sign_nep413(signer.account_id(), &self.params())
            .await?;
        Ok(self.signed(
            &signature.public_key.to_string(),
            &signature.signature.to_string(),
        ))
    }
}

/// Signs `call` as `signer`, for `verifier`. See [`Payload::new`] for `salt`
/// and `deadline`.
pub async fn sign_auth_call(
    signer: &(impl Signer + ?Sized),
    verifier: &AccountId,
    salt: &str,
    deadline: Timestamp,
    call: &AuthCall<'_>,
) -> Result<Value> {
    Payload::new(
        signer.account_id(),
        verifier,
        salt,
        deadline,
        &[call.intent()],
    )?
    .sign(signer)
    .await
}
