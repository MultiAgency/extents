use std::borrow::Cow;

use defuse_nep245::receiver::MultiTokenReceiver;
use defuse_time::Timestamp;
use near_sdk::{
    AccountContract, AccountId, AccountIdRef, FunctionError, GlobalContractId, PromiseOrValue, env,
    json_types::U128,
    near, require, serde_json,
    state_init::{StateInit, StateInitV1},
};

use crate::{
    ContractStorage, Error, Params, Result, State,
    action::{TransferAction, TransferMessage},
    event::{Event, FundedEvent},
};

use super::{Contract, ContractExt};

#[near]
impl MultiTokenReceiver for Contract {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<defuse_nep245::TokenId>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        require!(
            single(previous_owner_ids).as_ref() == Some(&sender_id),
            "approvals are not supported"
        );
        let (token_id, amount) = single(token_ids)
            .zip(single(amounts))
            .ok_or(Error::WrongToken)
            .unwrap_or_else(|err| err.panic());

        self.on_receive(
            &env::predecessor_account_id(),
            &sender_id,
            &token_id,
            amount.0,
            &msg,
        )
        .unwrap_or_else(|err| err.panic());

        PromiseOrValue::Value(vec![U128(0)])
    }
}

impl Contract {
    fn on_receive(
        &mut self,
        token_contract_id: &AccountIdRef,
        sender_id: &AccountIdRef,
        mt_token_id: &str,
        amount: u128,
        msg: &str,
    ) -> Result<()> {
        if amount == 0 {
            return Err(Error::InsufficientAmount);
        }
        let msg: TransferMessage = serde_json::from_str(msg)?;

        let storage = &mut self.0;
        let state = storage.try_as_alive_mut()?.verify_mut(&msg.params)?;

        let token = msg.params.nep245_token()?;
        if token.contract_id != *token_contract_id || token.mt_token_id != mt_token_id {
            return Err(Error::WrongToken);
        }

        match msg.action {
            TransferAction::Fund => state.fund(msg.params, sender_id, amount),
        }
    }
}

impl State {
    fn fund(&mut self, params: Params, sender_id: &AccountIdRef, amount: u128) -> Result<()> {
        if sender_id != params.sponsor {
            return Err(Error::Unauthorized);
        }
        // Code deployed with a hand-built initial state, or by an account id
        // whose code can be replaced, must never hold funds: only the account
        // the fresh state of these Params derives, under fixed code, does.
        let AccountContract::Global(code_hash) = env::current_contract_code() else {
            return Err(Error::NotDerived);
        };
        let derived = StateInit::V1(StateInitV1 {
            code: GlobalContractId::CodeHash(code_hash),
            data: ContractStorage::init_state(&params)?,
        })
        .derive_account_id();
        if derived != env::current_account_id() {
            return Err(Error::NotDerived);
        }
        if self.outcome.is_some() {
            return Err(Error::AlreadyResolved);
        }
        if params.deadline < Timestamp::now() {
            return Err(Error::DeadlineExpired);
        }

        self.funded = self
            .funded
            .checked_add(amount)
            .ok_or(Error::IntegerOverflow)?;

        Event::Funded(Box::new(FundedEvent {
            params: Cow::Owned(params),
            added: amount,
            funded: self.funded,
        }))
        .emit();
        Ok(())
    }
}

fn single<T>(v: Vec<T>) -> Option<T> {
    let [a] = v.try_into().ok()?;
    Some(a)
}
