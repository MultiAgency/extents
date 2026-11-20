use defuse_auth_call::AuthCallee;
use near_sdk::{AccountId, AccountIdRef, FunctionError, PromiseOrValue, env, near, serde_json};

use crate::{
    Error, Result,
    auth_call::{Action, Message},
};

use super::{Contract, ContractExt};

#[near]
impl AuthCallee for Contract {
    fn on_auth(&mut self, signer_id: AccountId, msg: String) -> PromiseOrValue<()> {
        self.internal_on_auth(&signer_id, &msg)
            .unwrap_or_else(|err| err.panic())
    }
}

impl Contract {
    pub(super) fn internal_on_auth(
        &mut self,
        signer_id: &AccountIdRef,
        msg: &str,
    ) -> Result<PromiseOrValue<()>> {
        let Message { params, action } = serde_json::from_str(msg)?;

        if params
            .auth_caller
            .as_ref()
            .is_none_or(|a| *a != env::predecessor_account_id())
        {
            return Err(Error::Unauthorized);
        }

        Ok(match action {
            Action::Commit => PromiseOrValue::Value(self.commit(signer_id, &params)?),
            Action::Deliver(delivery) => {
                PromiseOrValue::Value(self.deliver(signer_id, &params, delivery)?)
            }
            Action::Attest(attestation) => self.attest(signer_id, &params, attestation)?,
        })
    }
}
