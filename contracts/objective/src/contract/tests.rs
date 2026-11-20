use std::{collections::BTreeMap, time::Duration};

use defuse_auth_call::AuthCallee;
use defuse_fees::Pips;
use defuse_nep245::receiver::MultiTokenReceiver;
use defuse_time::Timestamp;
use defuse_token_id::nep245::Nep245TokenId;
use near_primitives_core::{account::AccountContract, hash::CryptoHash};
use near_sdk::{
    AccountId, GlobalContractId, PromiseOrValue, PromiseResult, borsh,
    json_types::U128,
    serde_json,
    state_init::{StateInit, StateInitV1},
    test_utils::VMContextBuilder,
    testing_env,
};

use super::{Contract, settle::Sent};
use crate::{
    Attestation, ContractStorage, Delivery, Error, Objective, Outcome, Params, Recipient, State,
    Verdict,
    action::{TransferAction, TransferMessage},
    auth_call::{Action, Message},
};

const HALF: u32 = 500_000;

const VERIFIER: &str = "intents.test";
const SELF: &str = "0s0000000000000000000000000000000000000000";

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn params(shares: &[u32], deadline_in: i64) -> Params {
    let now = Timestamp::now();
    let offset = Duration::from_secs(deadline_in.unsigned_abs());
    Params {
        sponsor: id("sponsor.test"),
        token: Nep245TokenId::new(id(VERIFIER), "nep141:usdc.test").into(),
        evaluator: id("evaluator.test"),
        contributors: shares
            .iter()
            .enumerate()
            .map(|(i, &pips)| (id(&format!("c{i}.test")), Pips::from_pips(pips).unwrap()))
            .collect(),
        backups: BTreeMap::new(),
        deadline: if deadline_in >= 0 {
            now + offset
        } else {
            now - offset
        },
        commit_by: None,
        acceptance_window_secs: None,
        spec_hash: [7; 32],
        auth_caller: Some(id(VERIFIER)),
        salt: [0; 32],
    }
}

fn call_from(predecessor: &str, promise_results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id(SELF))
            .predecessor_account_id(id(predecessor))
            .signer_account_id(id("relayer.test"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        promise_results,
    );
}

/// The code hash these tests deploy under.
const CODE_HASH: [u8; 32] = [9; 32];

/// The account `params` derive under [`CODE_HASH`].
fn derived(params: &Params) -> AccountId {
    StateInit::V1(StateInitV1 {
        code: GlobalContractId::CodeHash(CODE_HASH),
        data: ContractStorage::init_state(params).unwrap(),
    })
    .derive_account_id()
}

/// A call from `predecessor` to the instance `params` derive, as deployed by
/// `StateInit` under fixed code.
fn as_deployed(params: &Params, predecessor: &str) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(derived(params))
            .account_contract(AccountContract::Global(CryptoHash(CODE_HASH)))
            .predecessor_account_id(id(predecessor))
            .signer_account_id(id("relayer.test"))
            .build()
    );
}

fn deploy(params: &Params) -> Contract {
    call_from(SELF, vec![]);
    Contract(ContractStorage::init(params).unwrap())
}

fn fund(contract: &mut Contract, params: &Params, sender: &str, amount: u128) {
    as_deployed(params, VERIFIER);
    let msg = serde_json::to_string(&TransferMessage {
        params: params.clone(),
        action: TransferAction::Fund,
    })
    .unwrap();
    let refund = contract.mt_on_transfer(
        id(sender),
        vec![id(sender)],
        vec!["nep141:usdc.test".into()],
        vec![U128(amount)],
        msg,
    );
    assert!(matches!(refund, PromiseOrValue::Value(r) if r == [U128(0)]));
}

/// Delivers a balance reading to `ob_resolve_balance`.
fn read(contract: &mut Contract, balance: u128) -> PromiseOrValue<bool> {
    call_from(SELF, vec![balance_reply(balance)]);
    state(contract).in_flight += 1;
    contract.ob_resolve_balance()
}

/// The Verifier's `mt_balance_of` reply.
fn balance_reply(balance: u128) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&U128(balance)).unwrap())
}

fn commit_all(contract: &mut Contract, params: &Params) {
    for contributor in params.contributors.keys() {
        call_from(contributor.as_str(), vec![]);
        contract.ob_commit(params.clone());
    }
}

fn deliver_all(contract: &mut Contract, params: &Params) {
    for contributor in params.contributors.keys() {
        call_from(contributor.as_str(), vec![]);
        contract.ob_deliver(params.clone(), Delivery { hash: [1; 32] });
    }
}

/// Lets a test stand where only time could put it: past a deadline, with
/// commitments, deliveries or funds already recorded.
fn state(contract: &mut Contract) -> &mut State {
    contract.0.0.as_mut().unwrap().no_verify_mut()
}

fn windowed(shares: &[u32], deadline_in: i64, secs: u32) -> Params {
    Params {
        acceptance_window_secs: Some(secs),
        ..params(shares, deadline_in)
    }
}

fn owed(contract: &Contract) -> BTreeMap<Recipient, u128> {
    contract.ob_view().no_verify().owed.clone()
}

#[test]
fn split_rounds_down_and_gives_remainder_to_sponsor() {
    let p = params(&[333_334, 333_333, 333_333], 60);
    assert_eq!(
        p.split(100),
        vec![
            (Recipient::Contributor(0), 33),
            (Recipient::Contributor(1), 33),
            (Recipient::Contributor(2), 33),
            (Recipient::Sponsor, 1),
        ]
    );
    assert_eq!(
        p.split(u128::MAX).iter().map(|(_, a)| a).sum::<u128>(),
        u128::MAX
    );
}

/// NEP-448: 770 bytes, less ~100 for the account record, 40 per storage
/// entry and up to 64 for the global contract id.
#[test]
fn worst_case_state_fits_zero_balance_account() {
    const BUDGET: usize = 770 - 100 - 40 - 64;

    let p = params(&[100_000; Params::MAX_CONTRIBUTORS], 60);
    let mut contract = deploy(&p);
    let state = contract.0.0.as_mut().unwrap().no_verify_mut();
    state.funded = u128::MAX;
    state.committed = u16::MAX;
    state.delivered = u16::MAX;
    state.taken = u16::MAX;
    state.outcome = Some(Outcome::Expired);
    state.in_flight = u32::MAX;
    state.owed = p.split(u128::MAX).into_iter().collect();

    let size = borsh::to_vec(&contract.0).unwrap().len();
    assert!(size <= BUDGET, "{size} > {BUDGET}");
}

#[test]
fn recipient_json_round_trips() {
    for r in [Recipient::Sponsor, Recipient::Contributor(9)] {
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<Recipient>(&json).unwrap(), r);
    }
    assert_eq!(
        serde_json::to_string(&Recipient::Contributor(3)).unwrap(),
        r#""contributor:3""#
    );
}

#[test]
fn achieved_pays_contributors_and_retries_failures() {
    let p = params(&[700_000, 300_000], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 1_000);
    fund(&mut contract, &p, "sponsor.test", 1);
    assert_eq!(contract.ob_view().no_verify().funded, 1_001);
    commit_all(&mut contract, &p);
    deliver_all(&mut contract, &p);

    call_from("evaluator.test", vec![]);
    let attestation = Attestation {
        verdict: Verdict::Achieved,
        review_hash: Some([0xab; 32]),
    };
    assert!(matches!(
        contract.ob_attest(p.clone(), attestation),
        PromiseOrValue::Promise(_)
    ));
    assert_eq!(
        event("resolved"),
        serde_json::json!({
            "outcome": "achieved",
            "review_hash": "ab".repeat(32),
            "amounts": {"c0.test": "700", "c1.test": "300", "sponsor.test": "1"}
        })
    );
    let state = contract.ob_view().no_verify();
    assert_eq!(state.outcome, Some(Outcome::Achieved));
    assert_eq!((state.funded, state.in_flight), (0, 1));
    assert!(state.owed.is_empty(), "owed moves into the in-flight batch");

    let batch = vec![
        sent(Recipient::Contributor(0), "c0.test", 700),
        sent(Recipient::Contributor(1), "c1.test", 300),
        sent(Recipient::Sponsor, "sponsor.test", 1),
    ];
    call_from(
        SELF,
        vec![
            PromiseResult::Successful(vec![]),
            PromiseResult::Failed,
            PromiseResult::Successful(vec![]),
        ],
    );
    contract.ob_resolve_transfers(batch);
    assert_eq!(contract.ob_view().no_verify().in_flight, 0);
    assert_eq!(owed(&contract), [(Recipient::Contributor(1), 300)].into());

    // anyone may retry; the objective survives until its deadline
    call_from("anyone.test", vec![]);
    assert!(matches!(
        contract.ob_close(p.clone()),
        PromiseOrValue::Value(false)
    ));
    call_from(SELF, vec![PromiseResult::Successful(vec![])]);
    contract.ob_resolve_transfers(vec![sent(Recipient::Contributor(1), "c1.test", 300)]);
    assert!(owed(&contract).is_empty());
}

#[test]
fn failed_verdict_returns_everything_to_sponsor() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 50);

    call_from("evaluator.test", vec![]);
    contract.ob_attest(p, Verdict::Failed.into()).detach();
    assert_eq!(
        event("resolved"),
        serde_json::json!({"outcome": "failed", "amounts": {"sponsor.test": "50"}})
    );
}

/// `data` of the last `name` event in this call's logs.
fn event(name: &str) -> serde_json::Value {
    near_sdk::test_utils::get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
        .rfind(|e| e["event"] == name)
        .unwrap_or_else(|| panic!("no {name} event"))["data"]
        .clone()
}

#[test]
fn contributors_commit_once_before_verdict_and_deadline() {
    let p = params(&[HALF, HALF], 3600);
    let mut contract = deploy(&p);

    call_from("sponsor.test", vec![]);
    assert!(matches!(
        contract.commit(&id("sponsor.test"), &p),
        Err(Error::Unauthorized)
    ));

    call_from("c1.test", vec![]);
    contract.ob_commit(p.clone());
    assert_eq!(
        event("committed"),
        serde_json::json!({"contributor": "c1.test"})
    );
    assert_eq!(contract.ob_view().no_verify().committed, 0b10);
    assert!(matches!(
        contract.commit(&id("c1.test"), &p),
        Err(Error::AlreadyCommitted)
    ));

    call_from("evaluator.test", vec![]);
    contract
        .attest(&id("evaluator.test"), &p, Verdict::Failed.into())
        .unwrap()
        .detach();
    call_from("c0.test", vec![]);
    assert!(matches!(
        contract.commit(&id("c0.test"), &p),
        Err(Error::AlreadyResolved)
    ));

    let late = params(&[1_000_000], -1);
    let mut contract = deploy(&late);
    call_from("c0.test", vec![]);
    assert!(matches!(
        contract.commit(&id("c0.test"), &late),
        Err(Error::DeadlineExpired)
    ));
}

#[test]
fn achieved_requires_every_delivery() {
    let p = params(&[HALF, HALF], 3600);
    let mut contract = deploy(&p);
    commit_all(&mut contract, &p);
    call_from("c0.test", vec![]);
    contract.ob_deliver(p.clone(), Delivery { hash: [1; 32] });

    // everyone committed, one delivered
    call_from("evaluator.test", vec![]);
    assert!(matches!(
        contract.attest(&id("evaluator.test"), &p, Verdict::Achieved.into()),
        Err(Error::NotDelivered)
    ));
    // failing needs no agreement from anyone
    contract
        .attest(&id("evaluator.test"), &p, Verdict::Failed.into())
        .unwrap()
        .detach();
}

#[test]
fn commits_and_attests_through_auth_call() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    let msg = |action| {
        serde_json::to_string(&Message {
            params: p.clone(),
            action,
        })
        .unwrap()
    };

    call_from("mallory.test", vec![]);
    assert!(matches!(
        contract.internal_on_auth(&id("c0.test"), &msg(Action::Commit)),
        Err(Error::Unauthorized)
    ));

    call_from(VERIFIER, vec![]);
    contract
        .on_auth(id("c0.test"), msg(Action::Commit))
        .detach();
    assert_eq!(contract.ob_view().no_verify().committed, 1);

    contract
        .on_auth(
            id("c0.test"),
            msg(Action::Deliver(Delivery { hash: [2; 32] })),
        )
        .detach();
    assert_eq!(contract.ob_view().no_verify().delivered, 1);

    contract
        .on_auth(
            id("evaluator.test"),
            msg(Action::Attest(Verdict::Achieved.into())),
        )
        .detach();
    assert_eq!(event("resolved")["outcome"], "achieved");
}

#[test]
fn contributors_deliver_once_after_committing() {
    let p = params(&[HALF, HALF], 3600);
    let mut contract = deploy(&p);
    let delivery = Delivery { hash: [0xcd; 32] };

    call_from("sponsor.test", vec![]);
    assert!(matches!(
        contract.deliver(&id("sponsor.test"), &p, delivery),
        Err(Error::Unauthorized)
    ));
    call_from("c0.test", vec![]);
    assert!(matches!(
        contract.deliver(&id("c0.test"), &p, delivery),
        Err(Error::NotCommittedYet)
    ));

    contract.ob_commit(p.clone());
    contract.ob_deliver(p.clone(), delivery);
    let delivered = event("delivered");
    assert_eq!(delivered["contributor"], "c0.test");
    assert_eq!(delivered["hash"], "cd".repeat(32));
    assert_eq!(contract.ob_view().no_verify().delivered, 0b01);
    assert!(matches!(
        contract.deliver(&id("c0.test"), &p, delivery),
        Err(Error::AlreadyDelivered)
    ));

    // without a window, full delivery leaves the deadline alone
    call_from("c1.test", vec![]);
    contract.ob_commit(p.clone());
    contract.ob_deliver(p.clone(), delivery);
    assert_eq!(contract.ob_view().no_verify().deadline, p.deadline);

    call_from("evaluator.test", vec![]);
    contract
        .ob_attest(p.clone(), Verdict::Failed.into())
        .detach();
    call_from("c0.test", vec![]);
    assert!(matches!(
        contract.deliver(&id("c0.test"), &p, delivery),
        Err(Error::AlreadyResolved)
    ));

    let late = params(&[1_000_000], -1);
    let mut contract = deploy(&late);
    state(&mut contract).committed = 1;
    call_from("c0.test", vec![]);
    assert!(matches!(
        contract.deliver(&id("c0.test"), &late, delivery),
        Err(Error::DeadlineExpired)
    ));
}

#[test]
fn full_delivery_opens_the_acceptance_window() {
    let p = windowed(&[HALF, HALF], 60, 3600);
    let mut contract = deploy(&p);
    commit_all(&mut contract, &p);

    call_from("c0.test", vec![]);
    contract.ob_deliver(p.clone(), Delivery { hash: [1; 32] });
    assert_eq!(contract.ob_view().no_verify().deadline, p.deadline);

    call_from("c1.test", vec![]);
    contract.ob_deliver(p.clone(), Delivery { hash: [1; 32] });
    let attest_by = contract.ob_view().no_verify().deadline;
    assert!(attest_by > p.deadline + Duration::from_mins(50));
    assert_eq!(
        event("delivered")["attest_by"],
        serde_json::to_value(attest_by).unwrap()
    );
}

#[test]
fn evaluator_attests_within_the_window_after_the_deadline() {
    let p = windowed(&[1_000_000], -1, 3600);
    let mut contract = deploy(&p);
    let s = state(&mut contract);
    (s.committed, s.delivered, s.funded) = (1, 1, 80);
    s.deadline = Timestamp::now() + Duration::from_hours(1);

    call_from("anyone.test", vec![]);
    assert!(matches!(contract.close(&p), Err(Error::DeadlineNotExpired)));

    call_from("evaluator.test", vec![]);
    contract.ob_attest(p, Verdict::Failed.into()).detach();
    assert_eq!(
        event("resolved"),
        serde_json::json!({"outcome": "failed", "amounts": {"sponsor.test": "80"}})
    );
}

#[test]
fn silence_after_full_delivery_is_accepted() {
    let p = windowed(&[700_000, 300_000], -1, 3600);
    let mut contract = deploy(&p);
    let s = state(&mut contract);
    (s.committed, s.delivered, s.funded) = (0b11, 0b11, 1_001);

    call_from("evaluator.test", vec![]);
    assert!(matches!(
        contract.attest(&id("evaluator.test"), &p, Verdict::Failed.into()),
        Err(Error::DeadlineExpired)
    ));

    call_from("anyone.test", vec![]);
    assert!(matches!(contract.close(&p), Ok(PromiseOrValue::Promise(_))));
    assert_eq!(
        event("resolved"),
        serde_json::json!({
            "outcome": "accepted",
            "amounts": {"c0.test": "700", "c1.test": "300", "sponsor.test": "1"}
        })
    );
    assert_eq!(
        contract.ob_view().no_verify().outcome,
        Some(Outcome::Accepted)
    );
}

#[test]
fn silence_expires_unless_every_contributor_delivered_under_a_window() {
    for (p, delivered) in [
        (windowed(&[HALF, HALF], -1, 3600), 0b01),
        (params(&[HALF, HALF], -1), 0b11),
    ] {
        let mut contract = deploy(&p);
        let s = state(&mut contract);
        (s.committed, s.delivered, s.funded) = (0b11, delivered, 10);

        call_from("anyone.test", vec![]);
        assert!(matches!(contract.close(&p), Ok(PromiseOrValue::Promise(_))));
        assert_eq!(
            event("resolved"),
            serde_json::json!({"outcome": "expired", "amounts": {"sponsor.test": "10"}})
        );
    }
}

#[test]
fn deliver_all_then_attest() {
    let p = windowed(&[HALF, HALF], 3600, 60);
    let mut contract = deploy(&p);
    commit_all(&mut contract, &p);
    deliver_all(&mut contract, &p);
    assert_eq!(contract.ob_view().no_verify().delivered, 0b11);

    call_from("evaluator.test", vec![]);
    contract.ob_attest(p, Verdict::Achieved.into()).detach();
    assert_eq!(event("resolved")["outcome"], "achieved");
}

#[test]
fn only_evaluator_attests_once_before_deadline() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    commit_all(&mut contract, &p);
    deliver_all(&mut contract, &p);

    call_from("c0.test", vec![]);
    assert!(matches!(
        contract.attest(&id("c0.test"), &p, Verdict::Achieved.into()),
        Err(Error::Unauthorized)
    ));

    call_from("evaluator.test", vec![]);
    contract
        .attest(&id("evaluator.test"), &p, Verdict::Achieved.into())
        .unwrap()
        .detach();
    assert!(matches!(
        contract.attest(&id("evaluator.test"), &p, Verdict::Failed.into()),
        Err(Error::AlreadyResolved)
    ));

    let late = params(&[1_000_000], -1);
    let mut contract = deploy(&late);
    call_from("evaluator.test", vec![]);
    assert!(matches!(
        contract.attest(&id("evaluator.test"), &late, Verdict::Achieved.into()),
        Err(Error::DeadlineExpired)
    ));
}

/// The sponsor may concede: once every slot has delivered, it releases its
/// own funding to the contributors without the evaluator. It is recorded as
/// `released`, never as the evaluator's verdict.
#[test]
fn sponsor_releases_once_every_slot_delivered() {
    let p = params(&[700_000, 300_000], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 1_001);
    commit_all(&mut contract, &p);

    call_from("sponsor.test", vec![]);
    assert!(matches!(
        contract.attest(&id("sponsor.test"), &p, Verdict::Achieved.into()),
        Err(Error::NotDelivered)
    ));

    deliver_all(&mut contract, &p);
    call_from("sponsor.test", vec![]);
    assert!(matches!(
        contract.ob_attest(p.clone(), Verdict::Achieved.into()),
        PromiseOrValue::Promise(_)
    ));
    assert_eq!(
        event("resolved"),
        serde_json::json!({
            "outcome": "released",
            "amounts": {"c0.test": "700", "c1.test": "300", "sponsor.test": "1"}
        })
    );
    assert_eq!(
        contract.ob_view().no_verify().outcome,
        Some(Outcome::Released)
    );

    // one outcome: the evaluator cannot overturn a release
    call_from("evaluator.test", vec![]);
    assert!(matches!(
        contract.attest(&id("evaluator.test"), &p, Verdict::Failed.into()),
        Err(Error::AlreadyResolved)
    ));
}

/// Releasing pays others out of the sponsor's own funding. Taking it back is
/// a judgement on the contributors' work, which stays the evaluator's.
#[test]
fn sponsor_can_never_attest_failed() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 50);
    commit_all(&mut contract, &p);
    deliver_all(&mut contract, &p);

    call_from("sponsor.test", vec![]);
    assert!(matches!(
        contract.attest(&id("sponsor.test"), &p, Verdict::Failed.into()),
        Err(Error::Unauthorized)
    ));
    assert_eq!(contract.ob_view().no_verify().funded, 50);
}

/// The release ends when the evaluator's time to attest does, and travels
/// through a signed intent like any attestation.
#[test]
fn sponsor_releases_by_auth_call_and_only_in_time() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 50);
    commit_all(&mut contract, &p);
    deliver_all(&mut contract, &p);
    call_from(VERIFIER, vec![]);
    contract
        .on_auth(
            id("sponsor.test"),
            serde_json::to_string(&Message {
                params: p.clone(),
                action: Action::Attest(Verdict::Achieved.into()),
            })
            .unwrap(),
        )
        .detach_if_promise();
    assert_eq!(event("resolved")["outcome"], "released");

    let late = params(&[1_000_000], -1);
    let mut contract = deploy(&late);
    state(&mut contract).delivered = late.all_contributors();
    call_from("sponsor.test", vec![]);
    assert!(matches!(
        contract.attest(&id("sponsor.test"), &late, Verdict::Achieved.into()),
        Err(Error::DeadlineExpired)
    ));
}

/// A sponsor that is also the evaluator judges as the evaluator: its
/// achieved verdict is a verdict.
#[test]
fn a_sponsor_who_evaluates_attests_as_the_evaluator() {
    let p = Params {
        evaluator: id("sponsor.test"),
        ..params(&[1_000_000], 3600)
    };
    let mut contract = deploy(&p);
    commit_all(&mut contract, &p);
    deliver_all(&mut contract, &p);
    call_from("sponsor.test", vec![]);
    contract
        .ob_attest(p, Verdict::Achieved.into())
        .detach_if_promise();
    assert_eq!(event("resolved")["outcome"], "achieved");
}

#[test]
fn close_expires_only_after_deadline() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    call_from("anyone.test", vec![]);
    assert!(matches!(contract.close(&p), Err(Error::DeadlineNotExpired)));

    // unfunded and expired: nothing to send, so it reads its Verifier
    // balance, and deletes itself when that is zero
    let late = params(&[1_000_000], -1);
    let mut contract = deploy(&late);
    call_from("anyone.test", vec![]);
    assert!(matches!(
        contract.close(&late),
        Ok(PromiseOrValue::Promise(_))
    ));
    assert_eq!(contract.ob_view().no_verify().in_flight, 1);

    call_from(SELF, vec![balance_reply(0)]);
    assert!(matches!(
        contract.ob_resolve_balance(),
        PromiseOrValue::Value(true)
    ));
    assert!(contract.0.0.is_none());
    event("cleanup");
}

/// A settled objective with nothing funded, owed or in flight.
fn settled(shares: &[u32]) -> (Contract, Params) {
    let p = params(shares, -1);
    let mut contract = deploy(&p);
    state(&mut contract).outcome = Some(Outcome::Failed);
    (contract, p)
}

#[test]
fn unattributed_balance_is_retained_until_empty() {
    let (mut contract, _) = settled(&[1_000_000]);
    for balance in [9, 7, 8] {
        assert!(matches!(
            read(&mut contract, balance),
            PromiseOrValue::Value(false)
        ));
        let state = contract.ob_view().no_verify();
        assert_eq!(state.in_flight, 0);
        assert!(state.owed.is_empty());
        assert!(
            near_sdk::test_utils::get_created_receipts().is_empty(),
            "no transfer or deletion"
        );
    }
    assert!(matches!(
        read(&mut contract, 0),
        PromiseOrValue::Value(true)
    ));
    assert!(contract.0.0.is_none());
}

#[test]
fn balance_is_not_swept_unless_settled_or_readable() {
    // a payout failed meanwhile: what remains on the Verifier is still owed
    let (mut contract, p) = settled(&[1_000_000]);
    call_from("anyone.test", vec![]);
    contract.close(&p).unwrap().detach_if_promise();
    state(&mut contract)
        .owed
        .insert(Recipient::Contributor(0), 7);
    call_from(SELF, vec![balance_reply(7)]);
    assert!(matches!(
        contract.ob_resolve_balance(),
        PromiseOrValue::Value(false)
    ));
    assert_eq!(owed(&contract), [(Recipient::Contributor(0), 7)].into());

    // the read failed: nothing changes but the callback count
    let (mut contract, p) = settled(&[1_000_000]);
    call_from("anyone.test", vec![]);
    contract.close(&p).unwrap().detach_if_promise();
    call_from(SELF, vec![PromiseResult::Failed]);
    assert!(matches!(
        contract.ob_resolve_balance(),
        PromiseOrValue::Value(false)
    ));
    let s = contract.ob_view().no_verify();
    assert_eq!((s.in_flight, s.owed.is_empty()), (0, true));
}

trait DetachIfPromise {
    fn detach_if_promise(self);
}

impl<T> DetachIfPromise for PromiseOrValue<T> {
    fn detach_if_promise(self) {
        if let Self::Promise(p) = self {
            p.detach();
        }
    }
}

#[test]
fn rejects_tampered_params() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    let forged = Params {
        evaluator: id("mallory.test"),
        ..p
    };
    call_from("mallory.test", vec![]);
    assert!(matches!(
        contract.attest(&id("mallory.test"), &forged, Verdict::Achieved.into()),
        Err(Error::InvalidData)
    ));
}

#[test]
#[should_panic(expected = "deadline has expired")]
fn the_window_does_not_extend_funding() {
    let p = windowed(&[1_000_000], -1, 3600);
    let mut contract = deploy(&p);
    state(&mut contract).deadline = Timestamp::now() + Duration::from_hours(1);
    fund(&mut contract, &p, "sponsor.test", 1);
}

#[test]
#[should_panic(expected = "unauthorized")]
fn only_sponsor_funds() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "c0.test", 10);
}

#[test]
fn an_unsettled_objective_never_deletes() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 10);
    assert!(matches!(
        read(&mut contract, 10),
        PromiseOrValue::Value(false)
    ));
    assert!(near_sdk::test_utils::get_created_receipts().is_empty());
    assert!(contract.0.0.is_some());
}

#[test]
#[should_panic(expected = "wrong token")]
fn rejects_other_tokens() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    call_from(VERIFIER, vec![]);
    let _refund = contract.mt_on_transfer(
        id("sponsor.test"),
        vec![id("sponsor.test")],
        vec!["nep141:usdt.test".into()],
        vec![U128(10)],
        serde_json::to_string(&TransferMessage {
            params: p,
            action: TransferAction::Fund,
        })
        .unwrap(),
    );
}

#[test]
#[should_panic(expected = "already resolved")]
fn rejects_funding_after_verdict() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    call_from("evaluator.test", vec![]);
    contract
        .attest(&id("evaluator.test"), &p, Verdict::Failed.into())
        .unwrap()
        .detach();
    fund(&mut contract, &p, "sponsor.test", 10);
}

fn sent(recipient: Recipient, receiver_id: &str, amount: u128) -> Sent {
    Sent {
        recipient,
        receiver_id: id(receiver_id),
        amount: U128(amount),
    }
}

/// Reproduces a known gap; invert it with the fix. `dispatch` empties
/// `owed` before the transfers and only `ob_resolve_transfers` puts failures
/// back. If that callback never completes (it has a fixed 10 Tgas), nothing
/// records the batch, so nothing can be retried, and `in_flight` never
/// returns to zero, so the objective can never delete itself.
#[test]
fn lost_payout_callback_leaves_no_recovery_path() {
    let p = params(&[HALF, HALF], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 100);
    commit_all(&mut contract, &p);
    deliver_all(&mut contract, &p);

    call_from("evaluator.test", vec![]);
    assert!(matches!(
        contract.ob_attest(p.clone(), Verdict::Achieved.into()),
        PromiseOrValue::Promise(_)
    ));
    // the callback is lost: `ob_resolve_transfers` never runs

    state(&mut contract).deadline = Timestamp::now() - Duration::from_secs(1);
    call_from("anyone.test", vec![]);
    assert!(matches!(
        contract.close(&p),
        Ok(PromiseOrValue::Value(false))
    ));
    let s = contract.ob_view().no_verify();
    assert_eq!((s.funded, s.in_flight), (0, 1));
    assert!(s.owed.is_empty(), "the batch is recorded nowhere");
}

/// Two contributors at 70/30, with `b1.test` backing `c1.test` from
/// `commit_by_in` seconds.
fn backed(commit_by_in: i64) -> Params {
    let p = params(&[700_000, 300_000], 3600);
    let now = Timestamp::now();
    let offset = Duration::from_secs(commit_by_in.unsigned_abs());
    Params {
        backups: [(id("c1.test"), id("b1.test"))].into(),
        commit_by: Some(if commit_by_in >= 0 {
            now + offset
        } else {
            now - offset
        }),
        ..p
    }
}

#[test]
fn backup_takes_an_empty_slot_after_commit_by_and_is_paid() {
    let p = backed(-1);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 1_000);
    call_from("c0.test", vec![]);
    contract.ob_commit(p.clone());

    call_from("b1.test", vec![]);
    contract.ob_commit(p.clone());
    assert_eq!(
        event("committed"),
        serde_json::json!({"contributor": "b1.test"})
    );
    let s = contract.ob_view().no_verify();
    assert_eq!((s.committed, s.taken), (0b11, 0b10));

    // the slot is held: the listed contributor can neither commit nor deliver
    call_from("c1.test", vec![]);
    assert!(matches!(
        contract.commit(&id("c1.test"), &p),
        Err(Error::AlreadyCommitted)
    ));
    assert!(matches!(
        contract.deliver(&id("c1.test"), &p, Delivery { hash: [1; 32] }),
        Err(Error::Unauthorized)
    ));
    call_from("b1.test", vec![]);
    contract.ob_deliver(p.clone(), Delivery { hash: [1; 32] });
    call_from("c0.test", vec![]);
    contract.ob_deliver(p.clone(), Delivery { hash: [2; 32] });

    call_from("evaluator.test", vec![]);
    contract
        .ob_attest(p, Verdict::Achieved.into())
        .detach_if_promise();
    assert_eq!(
        event("resolved")["amounts"],
        serde_json::json!({"c0.test": "700", "b1.test": "300"})
    );
}

#[test]
fn before_commit_by_only_the_listed_contributor_commits() {
    let p = backed(3000);
    let mut contract = deploy(&p);
    call_from("b1.test", vec![]);
    assert!(matches!(
        contract.commit(&id("b1.test"), &p),
        Err(Error::BackupTooEarly)
    ));
    call_from("c1.test", vec![]);
    contract.ob_commit(p);
    assert_eq!(contract.ob_view().no_verify().taken, 0);
}

#[test]
fn after_commit_by_the_first_to_commit_holds_the_slot() {
    let p = backed(-1);
    let mut contract = deploy(&p);
    // the listed contributor is late, but the slot is still empty
    call_from("c1.test", vec![]);
    contract.ob_commit(p.clone());
    call_from("b1.test", vec![]);
    assert!(matches!(
        contract.commit(&id("b1.test"), &p),
        Err(Error::AlreadyCommitted)
    ));
    assert!(matches!(
        contract.deliver(&id("b1.test"), &p, Delivery { hash: [1; 32] }),
        Err(Error::Unauthorized)
    ));
    assert_eq!(contract.ob_view().no_verify().taken, 0);
}

/// The sponsor may hold a contributor slot; its share and the rounding
/// remainder go to one account, and the events report their sum.
#[test]
fn a_sponsor_holding_a_slot_is_reported_its_whole_payout() {
    let mut p = params(&[700_000, 300_000], 3600);
    let share = p.contributors.remove(&id("c0.test")).unwrap();
    p.contributors.insert(id("sponsor.test"), share);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 1_001);
    commit_all(&mut contract, &p);
    deliver_all(&mut contract, &p);

    call_from("evaluator.test", vec![]);
    contract
        .ob_attest(p.clone(), Verdict::Achieved.into())
        .detach_if_promise();
    assert_eq!(
        event("resolved")["amounts"],
        serde_json::json!({"c1.test": "300", "sponsor.test": "701"})
    );
    assert_eq!(
        owed(&contract),
        BTreeMap::new(),
        "everything owed was dispatched"
    );

    let sent = vec![
        Sent {
            recipient: Recipient::Sponsor,
            receiver_id: id("sponsor.test"),
            amount: U128(1),
        },
        Sent {
            recipient: Recipient::Contributor(1),
            receiver_id: id("sponsor.test"),
            amount: U128(700),
        },
    ];
    call_from(
        SELF,
        vec![
            PromiseResult::Successful(vec![]),
            PromiseResult::Successful(vec![]),
        ],
    );
    contract.ob_resolve_transfers(sent.clone());
    assert_eq!(
        event("paid")["amounts"],
        serde_json::json!({"sponsor.test": "701"})
    );

    state(&mut contract).in_flight += 1;
    call_from(SELF, vec![PromiseResult::Failed, PromiseResult::Failed]);
    contract.ob_resolve_transfers(sent);
    assert_eq!(
        event("lost")["amounts"],
        serde_json::json!({"sponsor.test": "701"})
    );
}

/// `on_auth` trusts the signer its caller names, so an `auth_caller` other
/// than the Verifier would let that account act as any role, e.g. attest
/// `failed` as the evaluator. Such Params never validate, so they have no
/// initial state and no address.
#[test]
fn auth_caller_must_be_the_verifier() {
    let p = Params {
        auth_caller: Some(id("sponsor.test")),
        ..params(&[HALF, HALF], 3600)
    };
    assert!(matches!(p.validate(), Err(Error::InvalidAuthCaller)));
    assert!(ContractStorage::init(&p).is_err());

    let none = Params {
        auth_caller: None,
        ..params(&[HALF, HALF], 3600)
    };
    assert!(none.validate().is_ok());
}

/// Sends the sponsor's funding to `contract`, running as `account` under
/// `code`, wherever that is.
fn fund_as(contract: &mut Contract, params: &Params, account: AccountId, code: AccountContract) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(account)
            .account_contract(code)
            .predecessor_account_id(id(VERIFIER))
            .build()
    );
    let msg = serde_json::to_string(&TransferMessage {
        params: params.clone(),
        action: TransferAction::Fund,
    })
    .unwrap();
    contract
        .mt_on_transfer(
            id("sponsor.test"),
            vec![id("sponsor.test")],
            vec!["nep141:usdc.test".into()],
            vec![U128(100)],
            msg,
        )
        .detach_if_promise();
}

/// A hand-built initial state: valid Params, but every slot marked delivered
/// and the attest deadline already past, which would let `ob_close` pay out
/// with no commitment or verdict. It cannot sit at the derived address, so
/// funding it is refused.
#[test]
#[should_panic(expected = "this account is not the one")]
fn funding_refuses_a_hand_built_state() {
    let p = windowed(&[HALF, HALF], 3600, 60);
    let mut contract = deploy(&p);
    let s = state(&mut contract);
    s.delivered = p.all_contributors();
    s.deadline = Timestamp::now();
    fund_as(
        &mut contract,
        &p,
        id(SELF),
        AccountContract::Global(CryptoHash(CODE_HASH)),
    );
}

/// Code referenced by account id can be replaced by that account; funding is
/// refused unless the code is fixed by hash.
#[test]
#[should_panic(expected = "this account is not the one")]
fn funding_refuses_code_that_can_be_replaced() {
    let p = params(&[HALF, HALF], 3600);
    let mut contract = deploy(&p);
    fund_as(
        &mut contract,
        &p,
        derived(&p),
        AccountContract::GlobalByAccount(id("publisher.test")),
    );
}

/// Params that never validate have no initial state, so no derived address.
#[test]
#[should_panic(expected = "invalid shares")]
fn funding_refuses_params_that_never_validate() {
    let valid = params(&[HALF, HALF], 3600);
    let state = deploy(&valid).ob_view().no_verify().clone();
    let mut p = valid;
    p.contributors
        .insert(id("c2.test"), Pips::from_pips(HALF).unwrap());
    let bytes = [p.hash().to_vec(), borsh::to_vec(&state).unwrap()].concat();
    let mut contract = Contract(ContractStorage(Some(borsh::from_slice(&bytes).unwrap())));
    fund_as(
        &mut contract,
        &p,
        id(SELF),
        AccountContract::Global(CryptoHash(CODE_HASH)),
    );
}

/// Payouts take a share of gas the caller attaches beyond what is reserved,
/// so a retry can always be given more; their callbacks stay fixed.
#[test]
fn payouts_share_unused_gas() {
    use near_sdk::mock::MockAction;

    let p = params(&[HALF, HALF], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 1_000);
    commit_all(&mut contract, &p);
    deliver_all(&mut contract, &p);
    call_from("evaluator.test", vec![]);
    contract
        .ob_attest(p.clone(), Verdict::Achieved.into())
        .detach_if_promise();
    let weights: Vec<(String, u64)> = near_sdk::test_utils::get_created_receipts()
        .iter()
        .flat_map(|r| &r.actions)
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name,
                gas_weight,
                ..
            } => Some((
                String::from_utf8(method_name.clone()).unwrap(),
                gas_weight.0,
            )),
            _ => None,
        })
        .collect();
    assert_eq!(
        weights,
        [
            ("mt_transfer".to_owned(), 1),
            ("mt_transfer".to_owned(), 1),
            ("ob_resolve_transfers".to_owned(), 0),
        ]
    );
}

/// A payout that succeeded counts as paid whatever it returned.
#[test]
fn a_successful_payout_is_paid_whatever_it_returns() {
    let (mut contract, _) = settled(&[1_000_000]);
    state(&mut contract).in_flight = 1;
    call_from(SELF, vec![PromiseResult::Successful(b"\"ok\"".to_vec())]);
    // returns nothing, as `ob_attest`'s payout chain promises
    let () = contract.ob_resolve_transfers(vec![Sent {
        recipient: Recipient::Contributor(0),
        receiver_id: id("c0.test"),
        amount: U128(5),
    }]);
    assert!(owed(&contract).is_empty());
    assert_eq!(
        event("paid")["amounts"],
        serde_json::json!({"c0.test": "5"})
    );
}

/// A balance reply that doesn't decode counts as unreadable, and its
/// callback is still accounted.
#[test]
fn an_undecodable_balance_reply_changes_nothing() {
    let (mut contract, _) = settled(&[1_000_000]);
    state(&mut contract).in_flight = 1;
    call_from(
        SELF,
        vec![PromiseResult::Successful(b"not a balance".to_vec())],
    );
    assert!(matches!(
        contract.ob_resolve_balance(),
        PromiseOrValue::Value(false)
    ));
    assert_eq!(contract.ob_view().no_verify().in_flight, 0);
    assert!(contract.0.0.is_some());
}

/// Retrying payouts before the last moment to attest answers `false` at once:
/// nothing can be deleted yet, and the payouts run on their own.
#[test]
fn an_early_retry_answers_not_deleted() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 10);
    call_from("evaluator.test", vec![]);
    contract
        .ob_attest(p.clone(), Verdict::Failed.into())
        .detach_if_promise();
    // the payout failed and went back into owed
    state(&mut contract).in_flight = 0;
    state(&mut contract).owed.insert(Recipient::Sponsor, 10);
    call_from("anyone.test", vec![]);
    assert!(matches!(
        contract.close(&p),
        Ok(PromiseOrValue::Value(false))
    ));
    assert_eq!(contract.ob_view().no_verify().in_flight, 1);
    assert!(owed(&contract).is_empty());
}

/// Times are stored and hashed as i64 nanoseconds; one outside that range is
/// refused by validation instead of panicking while hashing.
#[test]
fn times_outside_i64_nanoseconds_are_refused() {
    let mut far = serde_json::to_value(params(&[HALF, HALF], 3600)).unwrap();
    far["deadline"] = "2300-01-01T00:00:00Z".into();
    let far: Params = serde_json::from_value(far).unwrap();
    assert!(matches!(far.validate(), Err(Error::InvalidTimestamp)));
    assert!(matches!(
        ContractStorage::init_state(&far),
        Err(Error::InvalidTimestamp)
    ));
}

/// The sponsor takes its funding back while no slot is committed: nobody has
/// a claim on it yet. It is recorded as `cancelled`, and the objective takes
/// no further funding or commitment.
#[test]
fn sponsor_cancels_while_no_slot_is_committed() {
    let p = params(&[700_000, 300_000], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 1_001);

    for other in ["evaluator.test", "c0.test", "anyone.test"] {
        call_from(other, vec![]);
        assert!(matches!(
            contract.cancel(&id(other), &p),
            Err(Error::Unauthorized)
        ));
    }

    call_from("sponsor.test", vec![]);
    assert!(matches!(
        contract.ob_cancel(p.clone()),
        PromiseOrValue::Promise(_)
    ));
    assert_eq!(
        event("resolved"),
        serde_json::json!({"outcome": "cancelled", "amounts": {"sponsor.test": "1001"}})
    );
    let s = contract.ob_view().no_verify();
    assert_eq!((s.outcome, s.funded), (Some(Outcome::Cancelled), 0));

    assert!(matches!(
        contract.cancel(&id("sponsor.test"), &p),
        Err(Error::AlreadyResolved)
    ));
    call_from("c0.test", vec![]);
    assert!(matches!(
        contract.commit(&id("c0.test"), &p),
        Err(Error::AlreadyResolved)
    ));
}

/// A commitment locks the funding: from then on the sponsor cannot cancel.
/// Withdrawals that empty every slot unlock it again.
#[test]
fn a_commitment_locks_the_funding_until_it_is_withdrawn() {
    let p = params(&[HALF, HALF], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 100);
    commit_all(&mut contract, &p);

    call_from("sponsor.test", vec![]);
    assert!(matches!(
        contract.cancel(&id("sponsor.test"), &p),
        Err(Error::Committed)
    ));

    call_from("c0.test", vec![]);
    contract.ob_withdraw(p.clone());
    call_from("sponsor.test", vec![]);
    assert!(
        matches!(
            contract.cancel(&id("sponsor.test"), &p),
            Err(Error::Committed)
        ),
        "c1.test is still committed"
    );

    call_from("c1.test", vec![]);
    contract.ob_withdraw(p.clone());
    call_from("sponsor.test", vec![]);
    contract.ob_cancel(p).detach_if_promise();
    assert_eq!(event("resolved")["outcome"], "cancelled");
}

/// An unfunded objective cancels with nothing to send.
#[test]
fn cancelling_an_unfunded_objective_sends_nothing() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    call_from("sponsor.test", vec![]);
    assert!(matches!(contract.ob_cancel(p), PromiseOrValue::Value(())));
    assert_eq!(
        event("resolved"),
        serde_json::json!({"outcome": "cancelled", "amounts": {}})
    );
}

#[test]
#[should_panic(expected = "already resolved")]
fn rejects_funding_after_a_cancel() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    call_from("sponsor.test", vec![]);
    contract.ob_cancel(p.clone()).detach_if_promise();
    fund(&mut contract, &p, "sponsor.test", 10);
}

/// Only whoever holds a slot gives it back, only before delivering. The slot
/// is then empty: the same contributor may commit to it again.
#[test]
fn a_holder_withdraws_before_delivering_and_the_slot_reopens() {
    let p = params(&[HALF, HALF], 3600);
    let mut contract = deploy(&p);

    call_from("c0.test", vec![]);
    assert!(matches!(
        contract.withdraw(&id("c0.test"), &p),
        Err(Error::NothingToWithdraw)
    ));
    call_from("sponsor.test", vec![]);
    assert!(matches!(
        contract.withdraw(&id("sponsor.test"), &p),
        Err(Error::Unauthorized)
    ));

    commit_all(&mut contract, &p);
    call_from("c0.test", vec![]);
    contract.ob_withdraw(p.clone());
    assert_eq!(
        event("withdrawn"),
        serde_json::json!({"contributor": "c0.test"})
    );
    assert_eq!(contract.ob_view().no_verify().committed, 0b10);
    assert!(matches!(
        contract.deliver(&id("c0.test"), &p, Delivery { hash: [1; 32] }),
        Err(Error::NotCommittedYet)
    ));

    contract.ob_commit(p.clone());
    assert_eq!(contract.ob_view().no_verify().committed, 0b11);

    // a delivery is final: it can never be withdrawn
    contract.ob_deliver(p.clone(), Delivery { hash: [1; 32] });
    assert!(matches!(
        contract.withdraw(&id("c0.test"), &p),
        Err(Error::AlreadyDelivered)
    ));
    assert_eq!(contract.ob_view().no_verify().delivered, 0b01);
}

#[test]
fn nobody_withdraws_after_a_verdict_or_the_deadline() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    commit_all(&mut contract, &p);
    call_from("evaluator.test", vec![]);
    contract
        .ob_attest(p.clone(), Verdict::Failed.into())
        .detach_if_promise();
    call_from("c0.test", vec![]);
    assert!(matches!(
        contract.withdraw(&id("c0.test"), &p),
        Err(Error::AlreadyResolved)
    ));

    let late = params(&[1_000_000], -1);
    let mut contract = deploy(&late);
    state(&mut contract).committed = 1;
    call_from("c0.test", vec![]);
    assert!(matches!(
        contract.withdraw(&id("c0.test"), &late),
        Err(Error::DeadlineExpired)
    ));
}

/// A slot's backup can take it once its contributor withdraws, and only the
/// one who holds a slot can give it back. When the backup leaves in turn, the
/// slot is the listed contributor's to take again.
#[test]
fn a_withdrawn_slot_passes_between_contributor_and_backup() {
    let p = backed(-1);
    let mut contract = deploy(&p);
    call_from("c1.test", vec![]);
    contract.ob_commit(p.clone());
    call_from("b1.test", vec![]);
    assert!(matches!(
        contract.withdraw(&id("b1.test"), &p),
        Err(Error::Unauthorized)
    ));

    call_from("c1.test", vec![]);
    contract.ob_withdraw(p.clone());
    call_from("b1.test", vec![]);
    contract.ob_commit(p.clone());
    let s = contract.ob_view().no_verify();
    assert_eq!((s.committed, s.taken), (0b10, 0b10));
    call_from("c1.test", vec![]);
    assert!(matches!(
        contract.withdraw(&id("c1.test"), &p),
        Err(Error::Unauthorized)
    ));

    call_from("b1.test", vec![]);
    contract.ob_withdraw(p.clone());
    let s = contract.ob_view().no_verify();
    assert_eq!((s.committed, s.taken), (0, 0));
    call_from("c1.test", vec![]);
    contract.ob_commit(p);
    let s = contract.ob_view().no_verify();
    assert_eq!((s.committed, s.taken), (0b10, 0));
}

/// Both travel through a signed intent, like every other act.
#[test]
fn withdraws_and_cancels_through_auth_call() {
    let p = params(&[1_000_000], 3600);
    let mut contract = deploy(&p);
    fund(&mut contract, &p, "sponsor.test", 50);
    let msg = |action| {
        serde_json::to_string(&Message {
            params: p.clone(),
            action,
        })
        .unwrap()
    };
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&msg(Action::Withdraw)).unwrap()["action"],
        serde_json::json!({"action": "withdraw"})
    );

    call_from(VERIFIER, vec![]);
    contract
        .on_auth(id("c0.test"), msg(Action::Commit))
        .detach_if_promise();
    assert!(matches!(
        contract.internal_on_auth(&id("sponsor.test"), &msg(Action::Cancel)),
        Err(Error::Committed)
    ));
    contract
        .on_auth(id("c0.test"), msg(Action::Withdraw))
        .detach_if_promise();
    assert_eq!(contract.ob_view().no_verify().committed, 0);
    contract
        .on_auth(id("sponsor.test"), msg(Action::Cancel))
        .detach_if_promise();
    assert_eq!(
        event("resolved"),
        serde_json::json!({"outcome": "cancelled", "amounts": {"sponsor.test": "50"}})
    );
}
