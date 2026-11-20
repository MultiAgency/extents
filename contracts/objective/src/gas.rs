//! Gas the objective schedules, and what a caller must attach for it.
//!
//! A DAO proposal fixes its gas when it is filed, so callers compute it from
//! here rather than restating the rule.

use near_sdk::Gas;

use crate::Params;

/// One payout: an `mt_transfer` on the Verifier, at least. Payouts also
/// share any gas the caller attaches beyond what is reserved.
pub const MT_TRANSFER: Gas = Gas::from_tgas(15);
/// The callback that records which payouts of a batch succeeded.
pub const RESOLVE_TRANSFERS: Gas = Gas::from_tgas(10);
/// Reading the objective's own Verifier balance before deletion, at least.
/// It also shares any gas the caller attaches beyond what is reserved.
pub const MT_BALANCE_OF: Gas = Gas::from_tgas(5);
/// Enough to act on that reading and, at zero, delete the account.
pub const RESOLVE_BALANCE: Gas = Gas::from_tgas(35);
/// `ob_attest`'s own execution, around what it reserves for the payouts:
/// 6.7 Tgas measured with ten contributors, with margin for `on_auth`.
pub const ATTEST_EXECUTION: Gas = Gas::from_tgas(35);

impl Params {
    /// Gas to attach to `ob_attest`, directly, by DAO proposal, or as an
    /// `auth_call`'s `min_gas`: a transfer for each contributor and the
    /// sponsor's remainder, their callback, and the call itself. An upper
    /// bound for every verdict; unused gas is refunded.
    #[must_use]
    pub fn attest_gas(&self) -> Gas {
        let payouts = u64::try_from(self.contributors.len())
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        MT_TRANSFER
            .saturating_mul(payouts)
            .saturating_add(RESOLVE_TRANSFERS)
            .saturating_add(ATTEST_EXECUTION)
    }
}
