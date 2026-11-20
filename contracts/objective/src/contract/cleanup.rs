use defuse_time::Timestamp;
use near_sdk::{Promise, env};

use crate::{ContractStorage, Error, Result, State, Storage, event::Event};

use super::{Contract, ContractExt};

impl ContractStorage {
    #[inline]
    pub(super) fn try_as_alive_mut(&mut self) -> Result<&mut Storage> {
        self.0.as_mut().ok_or(Error::CleanupInProgress)
    }

    #[inline]
    pub(super) fn on_callback(&mut self) -> Result<&mut State> {
        let state = self
            .try_as_alive_mut()?
            // callbacks are only scheduled after verifying params
            .no_verify_mut();
        state.in_flight = state
            .in_flight
            .checked_sub(1)
            .ok_or("unregistered callback")
            .unwrap();
        Ok(state)
    }

    /// Deletes the account, reimbursing whoever paid for the transaction.
    /// Only called once the objective is settled and its Verifier balance
    /// was read as zero.
    pub(super) fn delete(&mut self) {
        self.0 = None;
        Event::Cleanup.emit();
        Promise::new(env::current_account_id())
            .delete_account(env::signer_account_id())
            .detach();
    }
}

impl State {
    #[inline]
    pub(super) fn callback(&mut self) -> ContractExt {
        self.in_flight = self
            .in_flight
            .checked_add(1)
            .ok_or("too many callbacks in flight")
            .unwrap();
        Contract::ext(env::current_account_id())
    }

    /// Resolved, with nothing funded, owed or in flight, so any Verifier
    /// balance left is stray. Waits for the last moment to attest so that
    /// re-deploying the same `StateInit` cannot reopen a settled objective
    /// for funding.
    pub(super) fn is_settled(&self) -> bool {
        self.outcome.is_some()
            && self.funded == 0
            && self.owed.is_empty()
            && self.in_flight == 0
            && self.deadline < Timestamp::now()
    }
}
