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

/// `FastData`'s write method, as a no-op: documents are published to the
/// objective's own account by calling `__fastdata_kv` on it, and `FastData`
/// indexes the call's arguments from the transaction. Accepting the call is
/// all the objective does, so the receipt succeeds instead of failing with
/// `MethodNotFound` (`FastData` indexes successful calls too). It never reads
/// its input or the objective's state. Like every other method it refuses an
/// attached deposit, which would otherwise stay on the objective and go to
/// whoever closes it.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn __fastdata_kv() {
    if !env::attached_deposit().is_zero() {
        env::panic_str("__fastdata_kv takes no deposit");
    }
}

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
