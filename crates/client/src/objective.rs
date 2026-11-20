//! Every call to an objective, built from its `Params`.
//!
//! Pure, with no I/O and no signing. Each [`Call`] leaves the signer to the caller, so who acts
//! stays explicit where the call is sent. Nothing here refuses what the
//! contract would refuse: a call the contract rejects is still built, so
//! negative tests can send it.

use std::time::Duration;

use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use extents_objective::{
    Attestation, ContractStorage, Delivery, Params,
    action::{TransferAction, TransferMessage},
    auth_call::{Action, Message},
};
use near_kit::{
    AccountId, CryptoHash, Gas, NearToken,
    protocol::{StateInit, StateInitExt},
};
use serde_json::{Value, json};

use crate::{AuthCall, transfer};

/// Gas a caller attaches, as near-kit [`Gas`].
pub mod gas {
    use near_kit::Gas;

    /// `mt_transfer_call` into an objective, including its `mt_on_transfer`.
    pub const FUND: Gas = Gas::from_tgas(100);
    /// `ob_commit` and `ob_deliver`: about 6× the most either burns
    /// (1.7 Tgas, measured at the largest valid state), leaving room for long
    /// account ids. Unused gas is refunded.
    pub const CALL: Gas = Gas::from_tgas(10);
    /// `add_public_key` on the Verifier.
    pub const ADD_PUBLIC_KEY: Gas = Gas::from_tgas(30);
    /// `add_proposal` on a Sputnik DAO.
    pub const ADD_PROPOSAL: Gas = Gas::from_tgas(100);
    /// `execute_intents` on the Verifier.
    pub const EXECUTE_INTENTS: Gas = Gas::from_tgas(300);
    /// `act_proposal`: the approving vote executes the proposal inside it.
    pub const VOTE: Gas = Gas::from_tgas(300);
}

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// One function call to make, with everything but who signs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub receiver: AccountId,
    pub method: &'static str,
    pub args: Value,
    pub gas: Gas,
    pub deposit: NearToken,
}

impl Call {
    /// The Sputnik `FunctionCall` proposal kind that makes a DAO send this
    /// call. Its gas is fixed here, when the proposal is filed.
    pub fn proposal_kind(&self) -> Value {
        json!({ "FunctionCall": {
            "receiver_id": self.receiver,
            "actions": [{
                "method_name": self.method,
                "args": BASE64.encode(self.args.to_string()),
                "deposit": self.deposit.as_yoctonear().to_string(),
                "gas": self.gas.as_gas().to_string(),
            }],
        } })
    }
}

/// One objective, known by its `Params`: its address and every call to it.
#[derive(Debug, Clone)]
pub struct Objective {
    params: Params,
    account: AccountId,
    state_init: StateInit,
    verifier: AccountId,
    token: String,
}

impl Objective {
    /// The objective deployed with `params` under the global contract
    /// `code_hash`. Fails for `Params` the contract would refuse: the initial
    /// state, and so the address, exist only for valid `Params`.
    pub fn new(params: Params, code_hash: [u8; 32]) -> Result<Self> {
        let data = ContractStorage::init_state(&params).map_err(|e| anyhow::anyhow!("{e}"))?;
        let state_init = StateInit::by_hash(CryptoHash::from(code_hash), data);
        let account = state_init.derive_account_id();
        let token = params.nep245_token().map_err(|e| anyhow::anyhow!("{e}"))?;
        let verifier = token
            .contract_id
            .as_str()
            .parse()
            .context("Verifier account id")?;
        let token = token.mt_token_id.clone();
        Ok(Self {
            params,
            account,
            state_init,
            verifier,
            token,
        })
    }

    /// The same objective, addressed with `params` that may not be its own,
    /// for tests of what the contract refuses: tampered terms, or terms it
    /// would never have accepted. The address, Verifier and token stay this
    /// objective's; `params` is not validated.
    #[must_use]
    pub fn with_params(&self, params: Params) -> Self {
        Self {
            params,
            ..self.clone()
        }
    }

    pub const fn params(&self) -> &Params {
        &self.params
    }

    pub const fn account(&self) -> &AccountId {
        &self.account
    }

    pub const fn verifier(&self) -> &AccountId {
        &self.verifier
    }

    /// The token's id on the Verifier, e.g. `nep141:usdc.near`.
    pub fn token(&self) -> &str {
        &self.token
    }

    /// The `StateInit` action that deploys the objective. The signer
    /// attaches its own deposit.
    pub fn state_init(&self) -> StateInit {
        self.state_init.clone()
    }

    /// The sponsor's `mt_transfer_call` of `amount` with the fund message.
    pub fn fund(&self, amount: u128) -> Call {
        Call {
            receiver: self.verifier.clone(),
            method: "mt_transfer_call",
            args: json!({
                "receiver_id": self.account,
                "token_id": self.token,
                "amount": amount.to_string(),
                "msg": self.fund_msg(),
            }),
            gas: gas::FUND,
            deposit: ONE_YOCTO,
        }
    }

    pub fn commit(&self) -> Call {
        self.own("ob_commit", json!({ "params": self.params }), gas::CALL)
    }

    pub fn withdraw(&self) -> Call {
        self.own("ob_withdraw", json!({ "params": self.params }), gas::CALL)
    }

    pub fn deliver(&self, delivery: &Delivery) -> Call {
        self.own(
            "ob_deliver",
            json!({ "params": self.params, "delivery": delivery }),
            gas::CALL,
        )
    }

    /// `ob_attest`, with the gas every verdict's payouts need.
    pub fn attest(&self, attestation: &Attestation) -> Call {
        self.own(
            "ob_attest",
            json!({ "params": self.params, "attestation": attestation }),
            self.attest_gas(),
        )
    }

    /// `ob_cancel`. It sends one payout, the sponsor's, so the attest budget
    /// covers it.
    pub fn cancel(&self) -> Call {
        self.own(
            "ob_cancel",
            json!({ "params": self.params }),
            self.attest_gas(),
        )
    }

    /// `ob_close`, with `Params::close_gas`: enough for its worst case,
    /// retrying every payout and then deleting the objective.
    pub fn close(&self) -> Call {
        self.own(
            "ob_close",
            json!({ "params": self.params }),
            self.close_gas(),
        )
    }

    /// A Verifier `transfer` intent of `amount` to the objective, with the
    /// fund message as its notification.
    pub fn fund_intent(&self, amount: u128) -> Value {
        transfer(&self.account, &self.token, amount, Some(&self.fund_msg()))
    }

    /// An `auth_call` intent carrying `action`. An attestation also asks the
    /// Verifier for the gas its payouts need. Valid `Params` name either no
    /// `auth_caller` or the Verifier, and with none the contract refuses the
    /// intent.
    pub fn auth_call(&self, action: Action) -> Value {
        // the acts that send payouts need the gas for them
        let min_gas =
            matches!(action, Action::Attest(_) | Action::Cancel).then(|| self.attest_gas());
        let msg = serde_json::to_string(&Message {
            params: self.params.clone(),
            action,
        })
        .unwrap_or_else(|e| unreachable!("Message serializes: {e}"));
        AuthCall {
            contract_id: &self.account,
            msg: &msg,
            min_gas,
        }
        .intent()
    }

    fn attest_gas(&self) -> Gas {
        Gas::from_gas(self.params.attest_gas().as_gas())
    }

    fn close_gas(&self) -> Gas {
        Gas::from_gas(self.params.close_gas().as_gas())
    }

    fn fund_msg(&self) -> String {
        serde_json::to_string(&TransferMessage {
            params: self.params.clone(),
            action: TransferAction::Fund,
        })
        .unwrap_or_else(|e| unreachable!("TransferMessage serializes: {e}"))
    }

    fn own(&self, method: &'static str, args: Value, gas: Gas) -> Call {
        Call {
            receiver: self.account.clone(),
            method,
            args,
            gas,
            deposit: NearToken::ZERO,
        }
    }
}

/// Registers `public_key` on `verifier` for the signer, so it can sign
/// intents.
pub fn add_public_key(verifier: &AccountId, public_key: &str) -> Call {
    Call {
        receiver: verifier.clone(),
        method: "add_public_key",
        args: json!({ "public_key": public_key }),
        gas: gas::ADD_PUBLIC_KEY,
        deposit: ONE_YOCTO,
    }
}

/// Relays signed payloads to `verifier`.
pub fn execute_intents(verifier: &AccountId, signed: &[Value]) -> Call {
    Call {
        receiver: verifier.clone(),
        method: "execute_intents",
        args: json!({ "signed": signed }),
        gas: gas::EXECUTE_INTENTS,
        deposit: NearToken::ZERO,
    }
}

/// Files a proposal of `kind` on `dao`, with the DAO's `bond`.
pub fn add_proposal(dao: &AccountId, description: &str, kind: &Value, bond: NearToken) -> Call {
    Call {
        receiver: dao.clone(),
        method: "add_proposal",
        args: json!({ "proposal": { "description": description, "kind": kind } }),
        gas: gas::ADD_PROPOSAL,
        deposit: bond,
    }
}

/// A Sputnik vote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Vote {
    Approve,
    Reject,
}

/// A council member's `vote` on proposal `id`, which must restate its `kind`.
pub fn vote(dao: &AccountId, id: u64, kind: &Value, vote: Vote) -> Call {
    let action = match vote {
        Vote::Approve => "VoteApprove",
        Vote::Reject => "VoteReject",
    };
    Call {
        receiver: dao.clone(),
        method: "act_proposal",
        args: json!({ "id": id, "action": action, "proposal": kind }),
        gas: gas::VOTE,
        deposit: NearToken::ZERO,
    }
}

/// A Sputnik policy with `council` as the voting group (half plus one), and
/// the DAO's proposal `bond` and `period`.
pub fn council_policy(council: &[AccountId], bond: NearToken, period: Duration) -> Value {
    json!({
        "roles": [
            { "name": "all", "kind": "Everyone", "permissions": ["*:AddProposal"], "vote_policy": {} },
            {
                "name": "council",
                "kind": { "Group": council },
                "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
                "vote_policy": {},
            },
        ],
        "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
        "proposal_bond": bond.as_yoctonear().to_string(),
        "proposal_period": period.as_nanos().to_string(),
        "bounty_bond": NearToken::from_near(1).as_yoctonear().to_string(),
        "bounty_forgiveness_period": Duration::from_hours(24).as_nanos().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use extents_objective::Verdict;
    use near_kit::CryptoHash;

    use super::*;

    /// The pinned contract vectors: `Params`, code hash, account and attest gas.
    fn vectors() -> Vec<Value> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/objective/tests/vectors/params.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn objective(case: &Value) -> Objective {
        let params: Params = serde_json::from_value(case["params"].clone()).unwrap();
        let code_hash: CryptoHash = case["code_hash"].as_str().unwrap().parse().unwrap();
        Objective::new(params, *code_hash.as_bytes()).unwrap()
    }

    #[test]
    fn addresses_and_attest_gas_match_the_contract_vectors() {
        for case in vectors() {
            let ob = objective(&case);
            assert_eq!(
                ob.account().as_str(),
                case["account_id"],
                "{}",
                case["name"]
            );
            let attest = ob.attest(&Attestation::from(Verdict::Achieved));
            assert_eq!(
                attest.gas,
                Gas::from_tgas(case["attest_tgas"].as_u64().unwrap())
            );
        }
    }

    #[test]
    fn calls_carry_the_wire_format_the_harnesses_send() {
        let ob = objective(&vectors()[1]);
        let params = serde_json::to_value(ob.params()).unwrap();

        let fund = ob.fund(1_000);
        assert_eq!(
            (fund.method, fund.gas, fund.deposit),
            ("mt_transfer_call", gas::FUND, ONE_YOCTO)
        );
        assert_eq!(fund.receiver, *ob.verifier());
        assert_eq!(fund.args["receiver_id"], ob.account().as_str());
        assert_eq!(fund.args["token_id"], ob.token());
        assert_eq!(fund.args["amount"], "1000");
        let msg: Value = serde_json::from_str(fund.args["msg"].as_str().unwrap()).unwrap();
        assert_eq!(
            msg,
            json!({ "params": params, "action": { "action": "fund" } })
        );

        let commit = ob.commit();
        assert_eq!(
            (commit.method, commit.deposit),
            ("ob_commit", NearToken::ZERO)
        );
        assert_eq!(commit.args, json!({ "params": params }));

        let deliver = ob.deliver(&Delivery { hash: [7; 32] });
        assert_eq!(
            deliver.args["delivery"],
            json!({ "hash": hex::encode([7; 32]) })
        );

        let close = ob.close();
        assert_eq!(close.method, "ob_close");
        assert_eq!(close.gas.as_gas(), ob.params().close_gas().as_gas());
    }

    #[test]
    fn intents_carry_the_same_acts() {
        let ob = objective(&vectors()[1]);
        let fund = ob.fund_intent(5);
        assert_eq!(fund["intent"], "transfer");
        assert_eq!(fund["tokens"][ob.token()], "5");
        assert_eq!(fund["msg"], ob.fund(5).args["msg"]);

        let attest = ob.auth_call(Action::Attest(Verdict::Achieved.into()));
        assert_eq!(attest["intent"], "auth_call");
        assert_eq!(attest["contract_id"], ob.account().as_str());
        assert_eq!(
            attest["min_gas"],
            ob.attest(&Verdict::Achieved.into())
                .gas
                .as_gas()
                .to_string()
        );
        let commit = ob.auth_call(Action::Commit);
        assert!(commit.get("min_gas").is_none());
        let msg: Value = serde_json::from_str(commit["msg"].as_str().unwrap()).unwrap();
        assert_eq!(msg["action"], json!({ "action": "commit" }));
    }

    /// Negative tests can still address the objective with `Params` it would
    /// refuse.
    #[test]
    fn with_params_skips_validation() {
        let ob = objective(&vectors()[1]);
        let mut tampered = ob.params().clone();
        tampered.contributors.clear();
        let bad = ob.with_params(tampered);
        assert_eq!(bad.account(), ob.account());
        assert_eq!(bad.commit().args["params"]["contributors"], json!({}));
    }

    #[test]
    fn a_dao_files_and_votes_on_the_exact_call() {
        let ob = objective(&vectors()[1]);
        let call = ob.attest(&Verdict::Failed.into());
        let kind = call.proposal_kind();
        let action = &kind["FunctionCall"]["actions"][0];
        assert_eq!(kind["FunctionCall"]["receiver_id"], ob.account().as_str());
        assert_eq!(action["gas"], call.gas.as_gas().to_string());
        assert_eq!(
            BASE64.decode(action["args"].as_str().unwrap()).unwrap(),
            call.args.to_string().into_bytes()
        );

        let dao: AccountId = "dao.testnet".parse().unwrap();
        let file = add_proposal(&dao, "attest", &kind, NearToken::from_millinear(100));
        assert_eq!(file.args["proposal"]["kind"], kind);
        let approve = vote(&dao, 3, &kind, Vote::Approve);
        assert_eq!(
            approve.args,
            json!({ "id": 3, "action": "VoteApprove", "proposal": kind })
        );
        assert_eq!(approve.gas, gas::VOTE);
    }
}
