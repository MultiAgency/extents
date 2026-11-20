use std::{borrow::Cow, mem};

use defuse_nep245::ext_mt_core;
use defuse_time::Timestamp;
use near_sdk::{
    AccountId, AccountIdRef, CryptoHash, FunctionError, NearToken, Promise, PromiseError,
    PromiseOrValue, env, json_types::U128, near, serde_json,
};
use serde::{Deserialize, Serialize};

use crate::{
    Attestation, Error, Outcome, Params, Recipient, Result, State, Verdict,
    event::{Event, Payouts, ResolvedEvent},
    gas,
};

use super::{Contract, ContractExt};

/// A `U128` balance in JSON is at most 41 bytes.
const MAX_BALANCE_REPLY: usize = 64;

/// One transfer in a settlement batch, echoed back to the callback.
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sent {
    pub recipient: Recipient,
    pub receiver_id: AccountId,
    pub amount: U128,
}

#[near]
impl Contract {
    #[private]
    pub fn ob_resolve_transfers(&mut self, sent: Vec<Sent>) {
        self.0
            .on_callback()
            .and_then(|state| state.resolve_transfers(sent))
            .unwrap_or_else(|err| err.panic());
    }

    /// Acts on a reading of a settled objective's own Verifier balance, where
    /// anything left is unattributed. Zero deletes the account; anything else
    /// is retained.
    /// The reply is read by hand: one that fails to decode is treated as
    /// unreadable, rather than panicking before the callback is accounted.
    #[private]
    pub fn ob_resolve_balance(&mut self) -> PromiseOrValue<bool> {
        let balance = env::promise_result_checked(0, MAX_BALANCE_REPLY)
            .ok()
            .and_then(|reply| serde_json::from_slice::<U128>(&reply).ok());
        self.resolve_balance(balance)
            .unwrap_or_else(|err| err.panic())
    }
}

impl Contract {
    pub(super) fn attest(
        &mut self,
        signer_id: &AccountIdRef,
        params: &Params,
        attestation: Attestation,
    ) -> Result<PromiseOrValue<()>> {
        let storage = &mut self.0;
        let state = storage.try_as_alive_mut()?.verify_mut(params)?;
        Ok(state
            .attest(signer_id, params, attestation)?
            .map_or(PromiseOrValue::Value(()), PromiseOrValue::Promise))
    }

    /// Resolves the objective if the last moment to attest passed without a
    /// verdict, sends whatever is owed, and once it is settled reads its
    /// Verifier balance before deleting it.
    pub(super) fn close(&mut self, params: &Params) -> Result<PromiseOrValue<bool>> {
        let storage = &mut self.0;
        let state = storage.try_as_alive_mut()?.verify_mut(params)?;
        let transfers = state.close(params)?;
        let settling = state.deadline < Timestamp::now();
        Ok(match transfers {
            Some(transfers) if settling => {
                PromiseOrValue::Promise(state.check_balance(params, Some(transfers))?)
            }
            // only retrying payouts: nothing can be deleted yet, so the
            // answer is already known, and the payouts and their callback
            // run on their own
            Some(transfers) => {
                transfers.detach();
                PromiseOrValue::Value(false)
            }
            None if state.is_settled() => {
                PromiseOrValue::Promise(state.check_balance(params, None)?)
            }
            None => PromiseOrValue::Value(false),
        })
    }

    fn resolve_balance(&mut self, balance: Option<U128>) -> Result<PromiseOrValue<bool>> {
        let storage = &mut self.0;
        let state = storage.on_callback()?;
        let Some(U128(balance)) = balance else {
            return Ok(PromiseOrValue::Value(false));
        };
        // A transfer still in flight to a deleted account fails, and the
        // Verifier refunds it in full, so deletion needs no confirmation.
        if state.is_settled() && balance == 0 {
            storage.delete();
            return Ok(PromiseOrValue::Value(true));
        }
        // Anything else is retained: a balance is not provenance, and even an
        // old one may be a refused deposit whose refund has not executed.
        Ok(PromiseOrValue::Value(false))
    }
}

impl State {
    pub(super) fn attest(
        &mut self,
        signer_id: &AccountIdRef,
        params: &Params,
        Attestation {
            verdict,
            review_hash,
        }: Attestation,
    ) -> Result<Option<Promise>> {
        if signer_id != params.evaluator {
            return Err(Error::Unauthorized);
        }
        if self.deadline < Timestamp::now() {
            return Err(Error::DeadlineExpired);
        }
        if verdict == Verdict::Achieved && self.committed != params.all_contributors() {
            return Err(Error::NotCommitted);
        }
        self.resolve(params, verdict.into(), review_hash)?;
        self.dispatch(params)
    }

    /// Without a verdict by the last moment to attest, the objective is
    /// accepted if it has an acceptance window and every contributor
    /// delivered, and expires otherwise.
    fn close(&mut self, params: &Params) -> Result<Option<Promise>> {
        if self.outcome.is_none() {
            if self.deadline >= Timestamp::now() {
                return Err(Error::DeadlineNotExpired);
            }
            let accepted = params.acceptance_window_secs.is_some()
                && self.delivered == params.all_contributors();
            let outcome = if accepted {
                Outcome::Accepted
            } else {
                Outcome::Expired
            };
            self.resolve(params, outcome, None)?;
        }
        self.dispatch(params)
    }

    /// Fixes the outcome and moves the funded balance into `owed`.
    fn resolve(
        &mut self,
        params: &Params,
        outcome: Outcome,
        review_hash: Option<CryptoHash>,
    ) -> Result<()> {
        if self.outcome.replace(outcome).is_some() {
            return Err(Error::AlreadyResolved);
        }

        let funded = mem::take(&mut self.funded);
        let allocation = match outcome {
            Outcome::Achieved | Outcome::Accepted => params.split(funded),
            Outcome::Failed | Outcome::Expired => vec![(Recipient::Sponsor, funded)],
        };

        let mut allocated = Payouts::default();
        for (recipient, amount) in allocation.into_iter().filter(|(_, amount)| *amount > 0) {
            let owed = self.owed.entry(recipient).or_default();
            *owed = owed.checked_add(amount).ok_or(Error::IntegerOverflow)?;
            allocated.add(
                Cow::Owned(params.holder_id(recipient, self.taken)?.to_owned()),
                amount,
            )?;
        }

        Event::Resolved(ResolvedEvent {
            outcome,
            review_hash,
            allocated,
        })
        .emit();
        Ok(())
    }

    /// Reads the objective's own balance on the Verifier, `after` any
    /// pending transfers, for `ob_resolve_balance`.
    fn check_balance(&mut self, params: &Params, after: Option<Promise>) -> Result<Promise> {
        let token = params.nep245_token()?;
        let read = ext_mt_core::ext(token.contract_id.clone())
            .with_static_gas(gas::MT_BALANCE_OF)
            // like the payouts, it can be given more gas by its caller
            .with_unused_gas_weight(1)
            .mt_balance_of(env::current_account_id(), token.mt_token_id.clone());
        let read = match after {
            Some(transfers) => transfers.then(read),
            None => read,
        };
        Ok(read.then(
            self.callback()
                .with_static_gas(gas::RESOLVE_BALANCE)
                .with_unused_gas_weight(0)
                .ob_resolve_balance(),
        ))
    }

    /// Sends everything owed as transfers on the Verifier, batched under a
    /// single callback that puts failed amounts back into `owed`.
    fn dispatch(&mut self, params: &Params) -> Result<Option<Promise>> {
        let token = params.nep245_token()?;

        let sent = mem::take(&mut self.owed)
            .into_iter()
            .map(|(recipient, amount)| {
                Ok(Sent {
                    recipient,
                    receiver_id: params.holder_id(recipient, self.taken)?.to_owned(),
                    amount: U128(amount),
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let Some(transfers) = sent
            .iter()
            .map(|s| {
                ext_mt_core::ext(token.contract_id.clone())
                    .with_attached_deposit(NearToken::from_yoctonear(1))
                    .with_static_gas(gas::MT_TRANSFER)
                    // Gas the caller attaches beyond what is reserved goes to
                    // the transfers, so a costlier `mt_transfer` can still be
                    // retried with more gas.
                    .with_unused_gas_weight(1)
                    .mt_transfer(
                        s.receiver_id.clone(),
                        token.mt_token_id.clone(),
                        s.amount,
                        None,
                        None,
                    )
            })
            .reduce(Promise::and)
        else {
            return Ok(None);
        };

        Ok(Some(
            transfers.then(
                self.callback()
                    .with_static_gas(gas::RESOLVE_TRANSFERS)
                    .with_unused_gas_weight(0)
                    .ob_resolve_transfers(sent),
            ),
        ))
    }

    fn resolve_transfers(&mut self, sent: Vec<Sent>) -> Result<()> {
        let (mut paid, mut lost) = (Payouts::default(), Payouts::default());

        for (result_idx, s) in (0u64..).zip(sent) {
            // a transfer failed only if it failed, whatever a success returned
            if matches!(
                env::promise_result_checked(result_idx, 0),
                Err(PromiseError::Failed)
            ) {
                let owed = self.owed.entry(s.recipient).or_default();
                *owed = owed.checked_add(s.amount.0).ok_or(Error::IntegerOverflow)?;
                lost.add(Cow::Owned(s.receiver_id), s.amount.0)?;
            } else {
                paid.add(Cow::Owned(s.receiver_id), s.amount.0)?;
            }
        }

        if !paid.amounts.is_empty() {
            Event::Paid(paid).emit();
        }
        if !lost.amounts.is_empty() {
            Event::Lost(lost).emit();
        }
        Ok(())
    }
}
