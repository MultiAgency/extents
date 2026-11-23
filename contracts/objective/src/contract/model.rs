//! Replays runs of the formal model (`model/objective.qnt`) against the
//! contract, with `quint-connect`: every call the model makes, refused or
//! not, is made on the contract under `near-sdk` mocking, and after each step
//! the contract's state must be the model's. A call the contract refuses
//! panics, and its state is put back as the chain would revert it.
//!
//! Opt-in, as it needs Quint on `PATH` and the `near` cfg (see
//! `model/README.md`): `scripts/check --model-replay`.

use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
    panic::{self, AssertUnwindSafe},
    time::Duration,
};

use defuse_fees::Pips;
use defuse_nep245::receiver::MultiTokenReceiver;
use defuse_time::Timestamp;
use defuse_token_id::nep245::Nep245TokenId;
use near_primitives_core::{account::AccountContract, hash::CryptoHash};
use near_sdk::{
    AccountId, GlobalContractId, PromiseOrValue, PromiseResult,
    json_types::U128,
    mock::MockAction,
    serde_json,
    state_init::{StateInit, StateInitV1},
    test_utils::{VMContextBuilder, get_created_receipts},
    testing_env,
};
use quint_connect::{Config, Driver, Result, State, Step, quint_run, switch};
use serde::Deserialize;

use super::{Contract, settle::Sent};
use crate::{
    ContractStorage, Delivery, Objective, Outcome, Params, Recipient, Verdict,
    action::{TransferAction, TransferMessage},
};

/// The model's clock starts here, one second per tick.
const T0: i64 = 1_700_000_000;
const CODE_HASH: [u8; 32] = [9; 32];
const VERIFIER: &str = "intents.test";
const TOKEN: &str = "nep141:usdc.test";

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// The model's actor names, as accounts.
fn account(actor: &str) -> AccountId {
    id(&format!("{actor}.test"))
}

/// A model recipient: a slot's index, or -1 for the sponsor.
fn recipient(r: Recipient) -> i64 {
    match r {
        Recipient::Sponsor => -1,
        Recipient::Contributor(idx) => idx.into(),
    }
}

thread_local! {
    /// Whether a panic is a refusal the driver expects and catches, so the hook keeps quiet.
    static REFUSING: Cell<bool> = const { Cell::new(false) };
}

/// The model's state, as far as the contract can show it (`st` in `objective.qnt`).
#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelState {
    funded: u128,
    committed: BTreeSet<i64>,
    taken: BTreeSet<i64>,
    delivered: BTreeSet<i64>,
    attest_by: i64,
    outcome: String,
    owed: BTreeMap<i64, u128>,
    sending: BTreeMap<i64, u128>,
    in_flight: i64,
    balance: u128,
    deleted: bool,
}

struct ObjectiveDriver {
    contract: Option<Contract>,
    params: Option<Params>,
    tick: i64,
    /// The objective's balance on the Verifier, as the driver moves it.
    balance: u128,
    /// The batch of transfers the contract sent, from its callback's arguments.
    batch: Vec<Sent>,
    /// What the contract showed just before deleting itself.
    last_view: Option<ModelState>,
}

impl Default for ObjectiveDriver {
    fn default() -> Self {
        // the contract panics on every refusal; only unexpected panics are worth printing
        let report = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            if !REFUSING.with(Cell::get) {
                report(info);
            }
        }));
        Self {
            contract: None,
            params: None,
            tick: 0,
            balance: 0,
            batch: vec![],
            last_view: None,
        }
    }
}

impl State<ObjectiveDriver> for ModelState {
    fn from_driver(driver: &ObjectiveDriver) -> Result<Self> {
        let contract = driver.contract.as_ref().expect("initialised");
        let Some(storage) = contract.0.0.as_ref() else {
            return Ok(driver
                .last_view
                .as_ref()
                .expect("viewed before deletion")
                .deleted());
        };
        let state = storage.no_verify();
        let slots = |mask: u16| {
            (0..2)
                .filter(|i| mask >> i & 1 == 1)
                .collect::<BTreeSet<i64>>()
        };
        let all = |amounts: &mut dyn Iterator<Item = (Recipient, u128)>| {
            let mut map: BTreeMap<i64, u128> = [(-1, 0), (0, 0), (1, 0)].into();
            for (r, amount) in amounts {
                *map.get_mut(&recipient(r)).unwrap() += amount;
            }
            map
        };
        Ok(Self {
            funded: state.funded,
            committed: slots(state.committed),
            taken: slots(state.taken),
            delivered: slots(state.delivered),
            attest_by: state.deadline.as_secs() - T0,
            outcome: match state.outcome {
                None => "",
                Some(Outcome::Achieved) => "achieved",
                Some(Outcome::Failed) => "failed",
                Some(Outcome::Expired) => "expired",
                Some(Outcome::Accepted) => "accepted",
                Some(Outcome::Released) => "released",
                Some(Outcome::Cancelled) => "cancelled",
            }
            .to_owned(),
            owed: all(&mut state.owed.iter().map(|(r, a)| (*r, *a))),
            sending: all(&mut driver.batch.iter().map(|s| (s.recipient, s.amount.0))),
            in_flight: state.in_flight.into(),
            balance: driver.balance,
            deleted: false,
        })
    }
}

impl ModelState {
    /// The state the model keeps for an objective deleted from this one: as it was, its read answered.
    fn deleted(&self) -> Self {
        Self {
            committed: self.committed.clone(),
            taken: self.taken.clone(),
            delivered: self.delivered.clone(),
            outcome: self.outcome.clone(),
            owed: self.owed.clone(),
            sending: self.sending.clone(),
            in_flight: self.in_flight - 1,
            deleted: true,
            ..*self
        }
    }
}

impl Driver for ObjectiveDriver {
    type State = ModelState;

    fn config() -> Config {
        Config {
            state: &["st"],
            ..Config::default()
        }
    }

    fn step(&mut self, step: &Step) -> Result {
        switch!(step {
            init(window: i64) => self.init(window),
            fund(actor: String, amount: i64) => self.fund(&actor, amount),
            commit(actor: String) => self.call(&actor, Contract::ob_commit),
            withdraw(actor: String) => self.call(&actor, Contract::ob_withdraw),
            deliver(actor: String) => self.call(&actor, |c, p| c.ob_deliver(p, Delivery { hash: [1; 32] })),
            attest(actor: String, verdict: String) => {
                let verdict = if verdict == "achieved" { Verdict::Achieved } else { Verdict::Failed };
                self.call(&actor, |c, p| c.ob_attest(p, verdict.into()).detach_if_promise());
            },
            cancel(actor: String) => self.call(&actor, |c, p| c.ob_cancel(p).detach_if_promise()),
            close => self.call("anyone", |c, p| { c.ob_close(p).detach_if_promise(); }),
            payouts(failing: BTreeSet<i64>) => self.payouts(&failing),
            balanceRead => self.balance_read(),
            strayDeposit(amount: i64) => self.balance += u128::try_from(amount).unwrap(),
            tick => self.tick += 1,
        })
    }
}

trait Detach {
    fn detach_if_promise(self);
}

impl<T> Detach for PromiseOrValue<T> {
    fn detach_if_promise(self) {
        if let Self::Promise(p) = self {
            p.detach();
        }
    }
}

impl ObjectiveDriver {
    fn params(&self) -> &Params {
        self.params.as_ref().expect("initialised")
    }

    /// The instance these Params derive, under fixed code.
    fn derived(params: &Params) -> AccountId {
        StateInit::V1(StateInitV1 {
            code: GlobalContractId::CodeHash(CODE_HASH),
            data: ContractStorage::init_state(params).unwrap(),
        })
        .derive_account_id()
    }

    /// A call from `predecessor` at the model's current tick.
    fn context(&self, current: &AccountId, predecessor: &AccountId, results: Vec<PromiseResult>) {
        let nanos = u64::try_from((T0 + self.tick) * 1_000_000_000).unwrap();
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(current.clone())
                .account_contract(AccountContract::Global(CryptoHash(CODE_HASH)))
                .predecessor_account_id(predecessor.clone())
                .signer_account_id(id("relayer.test"))
                .block_timestamp(nanos)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            std::collections::HashMap::default(),
            results,
        );
    }

    /// A new objective: one driver replays every trace, so nothing carries over.
    fn init(&mut self, window: i64) {
        self.tick = 0;
        self.balance = 0;
        self.batch.clear();
        self.last_view = None;
        self.context(&id(VERIFIER), &id(VERIFIER), vec![]);
        let now = Timestamp::now();
        assert_eq!(
            now.as_secs(),
            T0,
            "the contract must read the block time the driver moves, not the system clock: \
             build with RUSTFLAGS=\"--cfg near\""
        );
        let params = Params {
            sponsor: account("sponsor"),
            token: Nep245TokenId::new(id(VERIFIER), TOKEN).into(),
            evaluator: account("evaluator"),
            contributors: [
                (account("c0"), Pips::from_pips(700_000).unwrap()),
                (account("c1"), Pips::from_pips(300_000).unwrap()),
            ]
            .into(),
            backups: [(account("c0"), account("b0"))].into(),
            deadline: now + Duration::from_secs(5),
            commit_by: Some(now + Duration::from_secs(2)),
            acceptance_window_secs: (window > 0).then(|| u32::try_from(window).unwrap()),
            spec_hash: [7; 32],
            auth_caller: Some(id(VERIFIER)),
            salt: [0; 32],
        };
        self.contract = Some(Contract(ContractStorage::init(&params).unwrap()));
        self.params = Some(params);
    }

    /// Runs `f` as the contract would, reverting its state if it panics, and
    /// returns whether it succeeded. Receipts it created are read afterwards.
    fn attempt(
        &mut self,
        predecessor: &AccountId,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut Contract, Params),
    ) -> bool {
        let params = self.params().clone();
        let current = Self::derived(&params);
        self.context(&current, predecessor, results);
        let contract = self.contract.as_mut().expect("initialised");
        let before = contract.0.clone();
        REFUSING.with(|r| r.set(true));
        let ok = panic::catch_unwind(AssertUnwindSafe(|| f(contract, params))).is_ok();
        REFUSING.with(|r| r.set(false));
        if !ok {
            contract.0 = before;
        }
        ok
    }

    /// A call by a model actor; a batch it sends is recorded from the callback's arguments.
    fn call(&mut self, actor: &str, f: impl FnOnce(&mut Contract, Params)) {
        if self.attempt(&account(actor), vec![], f) {
            for receipt in get_created_receipts() {
                for action in receipt.actions {
                    if let MockAction::FunctionCallWeight {
                        method_name, args, ..
                    } = action
                        && method_name == b"ob_resolve_transfers"
                    {
                        #[derive(Deserialize)]
                        struct Args {
                            sent: Vec<Sent>,
                        }
                        self.batch = serde_json::from_slice::<Args>(&args).unwrap().sent;
                    }
                }
            }
        }
    }

    /// `mt_transfer_call` from `actor` on the Verifier: what the objective refuses is refunded.
    fn fund(&mut self, actor: &str, amount: i64) {
        let amount = u128::try_from(amount).unwrap();
        let sender = account(actor);
        let mut refund = vec![U128(amount)];
        let msg = serde_json::to_string(&TransferMessage {
            params: self.params().clone(),
            action: TransferAction::Fund,
        })
        .unwrap();
        self.attempt(&id(VERIFIER), vec![], |c, _| {
            if let PromiseOrValue::Value(r) = c.mt_on_transfer(
                sender.clone(),
                vec![sender],
                vec![TOKEN.into()],
                vec![U128(amount)],
                msg,
            ) {
                refund = r;
            }
        });
        self.balance += amount - refund[0].0;
    }

    /// The batch's callback, each transfer failed or not as the model chose.
    fn payouts(&mut self, failing: &BTreeSet<i64>) {
        let batch = std::mem::take(&mut self.batch);
        let failed = |s: &Sent| failing.contains(&recipient(s.recipient));
        let results = batch
            .iter()
            .map(|s| {
                if failed(s) {
                    PromiseResult::Failed
                } else {
                    PromiseResult::Successful(vec![])
                }
            })
            .collect();
        let paid: u128 = batch
            .iter()
            .filter(|s| !failed(s))
            .map(|s| s.amount.0)
            .sum();
        let current = Self::derived(self.params());
        assert!(
            self.attempt(&current, results, |c, _| c.ob_resolve_transfers(batch)),
            "the batch's callback failed"
        );
        self.balance -= paid;
    }

    /// A balance read's callback, answered with the Verifier balance.
    fn balance_read(&mut self) {
        self.last_view = Some(ModelState::from_driver(self).unwrap());
        let reply = PromiseResult::Successful(serde_json::to_vec(&U128(self.balance)).unwrap());
        let current = Self::derived(self.params());
        assert!(
            self.attempt(&current, vec![reply], |c, _| {
                c.ob_resolve_balance().detach_if_promise();
            }),
            "the balance read's callback failed"
        );
    }
}

#[quint_run(spec = "model/objective.qnt", max_samples = 200, max_steps = 80)]
#[ignore = "needs Quint on PATH: scripts/check --model-replay"]
fn contract_follows_the_model() -> impl Driver {
    ObjectiveDriver::default()
}
