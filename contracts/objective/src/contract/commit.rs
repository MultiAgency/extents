use std::{borrow::Cow, time::Duration};

use defuse_time::Timestamp;
use near_sdk::AccountIdRef;

use crate::{
    Delivery, Error, Params, Result, Slot, State,
    event::{CommittedEvent, DeliveredEvent, Event},
};

use super::Contract;

impl Contract {
    pub(super) fn commit(&mut self, signer_id: &AccountIdRef, params: &Params) -> Result<()> {
        let storage = &mut self.0;
        storage
            .try_as_alive_mut()?
            .verify_mut(params)?
            .commit(signer_id, params)
    }

    pub(super) fn withdraw(&mut self, signer_id: &AccountIdRef, params: &Params) -> Result<()> {
        let storage = &mut self.0;
        storage
            .try_as_alive_mut()?
            .verify_mut(params)?
            .withdraw(signer_id, params)
    }

    pub(super) fn deliver(
        &mut self,
        signer_id: &AccountIdRef,
        params: &Params,
        delivery: Delivery,
    ) -> Result<()> {
        let storage = &mut self.0;
        storage
            .try_as_alive_mut()?
            .verify_mut(params)?
            .deliver(signer_id, params, delivery)
    }
}

impl State {
    /// Commits to the signer's slot: as its listed contributor any time
    /// before the deadline, or as its backup once `commit_by` passed, if the
    /// slot is still empty.
    fn commit(&mut self, signer_id: &AccountIdRef, params: &Params) -> Result<()> {
        let Slot { bit, backup } = self.open_for(signer_id, params)?;
        if self.committed & bit != 0 {
            return Err(Error::AlreadyCommitted);
        }
        if backup && params.commit_by.is_none_or(|t| Timestamp::now() <= t) {
            return Err(Error::BackupTooEarly);
        }
        self.committed |= bit;
        if backup {
            self.taken |= bit;
        }

        Event::Committed(CommittedEvent {
            contributor: Cow::Borrowed(signer_id),
        })
        .emit();
        Ok(())
    }

    /// Records a committed contributor's delivery. Once every contributor
    /// has delivered, an acceptance window extends the last moment to
    /// attest to at least `acceptance_window_secs` from now.
    fn deliver(
        &mut self,
        signer_id: &AccountIdRef,
        params: &Params,
        Delivery { hash }: Delivery,
    ) -> Result<()> {
        let bit = self.held_undelivered(signer_id, params, Error::NotCommittedYet)?;
        self.delivered |= bit;

        if self.delivered == params.all_contributors()
            && let Some(secs) = params.acceptance_window_secs
        {
            let window_end = Timestamp::now()
                .checked_add_unsigned(Duration::from_secs(secs.into()))
                .ok_or(Error::IntegerOverflow)?;
            self.deadline = self.deadline.max(window_end);
        }

        Event::Delivered(DeliveredEvent {
            contributor: Cow::Borrowed(signer_id),
            hash,
            attest_by: self.deadline,
        })
        .emit();
        Ok(())
    }

    /// Gives the signer's slot back before it delivers. The slot is empty
    /// again, as if nobody had committed to it: its listed contributor may
    /// commit, or its backup once `commit_by` passed.
    fn withdraw(&mut self, signer_id: &AccountIdRef, params: &Params) -> Result<()> {
        let bit = self.held_undelivered(signer_id, params, Error::NothingToWithdraw)?;
        self.committed &= !bit;
        self.taken &= !bit;

        Event::Withdrawn(CommittedEvent {
            contributor: Cow::Borrowed(signer_id),
        })
        .emit();
        Ok(())
    }

    /// The bit of the slot the signer holds and has not delivered for, while
    /// contributors can still act. `uncommitted` is the refusal when nobody
    /// holds the slot yet.
    fn held_undelivered(
        &self,
        signer_id: &AccountIdRef,
        params: &Params,
        uncommitted: Error,
    ) -> Result<u16> {
        let Slot { bit, backup } = self.open_for(signer_id, params)?;
        if self.committed & bit == 0 {
            return Err(uncommitted);
        }
        // only whoever holds the slot acts for it
        if (self.taken & bit != 0) != backup {
            return Err(Error::Unauthorized);
        }
        if self.delivered & bit != 0 {
            return Err(Error::AlreadyDelivered);
        }
        Ok(bit)
    }

    /// The signer's slot, while contributors can still act: before a verdict
    /// and `Params::deadline`.
    fn open_for(&self, signer_id: &AccountIdRef, params: &Params) -> Result<Slot> {
        let slot = params.slot_of(signer_id).ok_or(Error::Unauthorized)?;
        if self.outcome.is_some() {
            return Err(Error::AlreadyResolved);
        }
        if params.deadline < Timestamp::now() {
            return Err(Error::DeadlineExpired);
        }
        Ok(slot)
    }
}
