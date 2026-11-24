//! An evaluator that is one exact program, run by OutLayer in a TEE.
//!
//! Its manifest declares an ed25519 key bound to this build and to no caller,
//! so the key's implicit account, the `evaluator` of an objective's terms,
//! can sign only what this code composes: one `auth_call` intent attesting
//! the verdict of a review it wrote, of reports it checked against the
//! objective's deliveries, by the spec the terms commit to.
//!
//! A probe, not a product: it judges two kinds of criterion (see `judge`),
//! and it trusts the worker's RPC.

#[cfg(any(target_arch = "wasm32", test))]
mod judge;
#[cfg(target_arch = "wasm32")]
mod program;

fn main() {
    #[cfg(target_arch = "wasm32")]
    program::main();
}
