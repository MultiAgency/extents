#![cfg_attr(not(near), allow(dead_code))]

mod auth_call;
mod cleanup;
mod commit;
mod settle;
#[cfg(test)]
mod tests;
mod tokens;

use impl_tools::autoimpl;
use near_sdk::{FunctionError, PanicOnDefault, PromiseOrValue, env, near};

use crate::{Attestation, ContractStorage, Delivery, Error, Objective, Params, Result, Storage};

#[near(contract_state(key = ContractStorage::STATE_KEY))]
#[autoimpl(Deref using self.0)]
#[derive(Debug, PanicOnDefault)]
pub struct Contract(ContractStorage);

#[near]
impl Objective for Contract {
    fn ob_view(&self) -> &Storage {
        self.try_as_alive()
            // the account is about to be deleted, so panicking is fine
            .unwrap_or_else(|err| err.panic())
    }

    fn ob_commit(&mut self, params: Params) {
        self.commit(&env::predecessor_account_id(), &params)
            .unwrap_or_else(|err| err.panic());
    }

    fn ob_withdraw(&mut self, params: Params) {
        self.withdraw(&env::predecessor_account_id(), &params)
            .unwrap_or_else(|err| err.panic());
    }

    fn ob_deliver(&mut self, params: Params, delivery: Delivery) {
        self.deliver(&env::predecessor_account_id(), &params, delivery)
            .unwrap_or_else(|err| err.panic());
    }

    fn ob_attest(&mut self, params: Params, attestation: Attestation) -> PromiseOrValue<()> {
        self.attest(&env::predecessor_account_id(), &params, attestation)
            .unwrap_or_else(|err| err.panic())
    }

    fn ob_cancel(&mut self, params: Params) -> PromiseOrValue<()> {
        self.cancel(&env::predecessor_account_id(), &params)
            .unwrap_or_else(|err| err.panic())
    }

    fn ob_close(&mut self, params: Params) -> PromiseOrValue<bool> {
        self.close(&params).unwrap_or_else(|err| err.panic())
    }
}

impl ContractStorage {
    #[inline]
    fn try_as_alive(&self) -> Result<&Storage> {
        self.0.as_ref().ok_or(Error::CleanupInProgress)
    }
}
