//! A single objective: a sponsor's resources, held as a NEP-245 balance on the
//! Verifier, released to committed contributors only when an evaluator attests
//! that the objective was achieved, and returned to the sponsor otherwise.
//!
//! Every instance lives at a [NEP-616] deterministic account derived from its
//! [`Params`], so its address is known before it exists.
//!
//! [NEP-616]: https://github.com/near/NEPs/blob/master/neps/nep-0616.md

#[cfg(feature = "contract")]
mod contract;

pub mod action;
pub mod auth_call;
mod error;
pub mod event;
pub mod gas;
mod state;

pub use self::{error::*, state::*};

pub use defuse_fees::Pips;
pub use defuse_time::Timestamp;
pub use defuse_token_id as token_id;

use near_sdk::{PromiseOrValue, ext_contract};

#[ext_contract(ext_objective)]
pub trait Objective {
    fn ob_view(&self) -> &Storage;

    /// Records the caller's agreement to deliver its part. Only a listed
    /// contributor, only before a verdict and the deadline, only once.
    fn ob_commit(&mut self, params: Params);

    /// Records a committed contributor's delivery, by hash. Only once,
    /// before a verdict and the deadline. Once every contributor has
    /// delivered, `Params::acceptance_window_secs` extends the last moment
    /// to attest.
    fn ob_deliver(&mut self, params: Params, delivery: Delivery);

    /// Records the evaluator's verdict and allocates the funded balance:
    /// * [`Verdict::Achieved`]: to contributors by their shares, rounding
    ///   remainder to the sponsor. Requires every contributor to have
    ///   committed.
    /// * [`Verdict::Failed`]: entirely to the sponsor
    ///
    /// Only `params.evaluator`, only once, only before the deadline or the
    /// end of the acceptance window, whichever is later.
    fn ob_attest(&mut self, params: Params, attestation: Attestation) -> PromiseOrValue<()>;

    /// Permissionless. Once the last moment to attest passed without a
    /// verdict, resolves the objective as [`Outcome::Accepted`] if it has an
    /// acceptance window and every contributor delivered, or as
    /// [`Outcome::Expired`] otherwise. Then retries any allocation that has
    /// not been sent yet.
    ///
    /// Once settled, after the last moment to attest, it reads the
    /// objective's own Verifier balance. Zero deletes the account. Anything
    /// else is unattributed (e.g. a plain `mt_transfer`, or a pending refund)
    /// and is retained. Balance readings and elapsed blocks cannot establish
    /// ownership. A later call deletes only once the balance is zero.
    ///
    /// Returns whether the contract was deleted, so indexers can stop
    /// following it.
    fn ob_close(&mut self, params: Params) -> PromiseOrValue<bool>;
}
