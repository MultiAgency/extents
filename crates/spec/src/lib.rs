//! The specification of Extents' off-chain documents: an objective's spec,
//! the evaluator's review, and the exact judge request, with the canonical
//! hashing they share.
//!
//! Off-chain formats for `extents-objective`: the [`Spec`] that
//! `Params::spec_hash` commits to, and the [`Review`] that
//! `Attestation::review_hash` commits to.
//!
//! Both are JSON documents. A document's hash is the SHA-256 of its
//! [RFC 8785] (JCS) canonical form, so any language with a JCS
//! implementation computes the same hash. The vectors in `tests/vectors`
//! pin it.
//!
//! [`Spec::from_json`] and [`Review::from_json`] accept a document only in
//! normal form: re-serializing what was parsed gives the same canonical
//! bytes as the input. An unknown field, or `null` where an optional field
//! should be left out, is rejected, so one meaning has one hash.
//!
//! This crate defines and validates the formats. It runs no checks: that is
//! the evaluator's work.
//!
//! [RFC 8785]: https://www.rfc-editor.org/rfc/rfc8785

mod error;
mod judge;
mod review;
mod spec;

use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

pub use self::{error::*, judge::*, review::*, spec::*};

/// SHA-256 of a document's canonical JSON. The same type as
/// `near_sdk::CryptoHash`, so it can be passed as `spec_hash` or
/// `review_hash` directly.
pub type Hash = [u8; 32];

/// The format version, written as `"v"` in every document.
pub const VERSION: u32 = 1;

fn canonical<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json_canonicalizer::to_vec(value).map_err(Error::Json)
}

fn hash<T: Serialize>(value: &T) -> Result<Hash> {
    Ok(Sha256::digest(canonical(value)?).into())
}

fn from_json<T: Serialize + DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    let raw: serde_json::Value = serde_json::from_slice(bytes).map_err(Error::Json)?;
    let typed: T = serde_json::from_value(raw.clone()).map_err(Error::Json)?;
    if canonical(&typed)? != canonical(&raw)? {
        return Err(Error::NotNormalForm);
    }
    Ok(typed)
}

const fn check_version(v: u32) -> Result<()> {
    if v == VERSION {
        Ok(())
    } else {
        Err(Error::Version(v))
    }
}

fn non_empty(field: &'static str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(Error::Empty(field))
    } else {
        Ok(())
    }
}
