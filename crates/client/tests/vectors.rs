//! Every call [`Objective`] builds, for each case of the contract's pinned
//! `Params` vectors, pinned in `tests/vectors/calls.json` so other
//! implementations can match it byte for byte. Regenerate with
//! `EXTENTS_WRITE_VECTORS=1 cargo test -p extents-client --test vectors`.

use std::{fs, path::PathBuf};

use extents_client::objective::{Call, Objective};
use extents_objective::{Attestation, Delivery, Params, Verdict, auth_call::Action};
use near_kit::CryptoHash;
use serde_json::{Value, json};

const FUND: u128 = 1_000;
const DELIVERY: Delivery = Delivery { hash: [1; 32] };

fn path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn call(call: &Call) -> Value {
    json!({
        "receiver": call.receiver,
        "method": call.method,
        "args": call.args,
        "gas": call.gas.as_gas().to_string(),
        "deposit": call.deposit.as_yoctonear().to_string(),
    })
}

fn case(vector: &Value) -> Value {
    let params: Params = serde_json::from_value(vector["params"].clone()).unwrap();
    let code_hash: CryptoHash = vector["code_hash"].as_str().unwrap().parse().unwrap();
    let ob = Objective::new(params, *code_hash.as_bytes()).unwrap();
    let achieved = Attestation::from(Verdict::Achieved);
    json!({
        "name": vector["name"],
        "code_hash": vector["code_hash"],
        "account": ob.account(),
        "calls": {
            "fund": call(&ob.fund(FUND)),
            "commit": call(&ob.commit()),
            "deliver": call(&ob.deliver(&DELIVERY)),
            "attest": call(&ob.attest(&achieved)),
            "close": call(&ob.close()),
        },
        "attest_proposal_kind": ob.attest(&achieved).proposal_kind(),
        "intents": {
            "fund": ob.fund_intent(FUND),
            "commit": ob.auth_call(Action::Commit),
            "deliver": ob.auth_call(Action::Deliver(DELIVERY)),
            "attest": ob.auth_call(Action::Attest(achieved)),
        },
    })
}

#[test]
fn calls_match_the_pinned_vectors() {
    let params: Vec<Value> = serde_json::from_slice(
        &fs::read(path("../../contracts/objective/tests/vectors/params.json")).unwrap(),
    )
    .unwrap();
    let cases: Vec<Value> = params.iter().map(case).collect();
    let pinned = path("tests/vectors/calls.json");
    if std::env::var_os("EXTENTS_WRITE_VECTORS").is_some() {
        fs::create_dir_all(pinned.parent().unwrap()).unwrap();
        fs::write(
            &pinned,
            serde_json::to_string_pretty(&cases).unwrap() + "\n",
        )
        .unwrap();
    }
    let expected: Vec<Value> = serde_json::from_slice(&fs::read(&pinned).unwrap()).unwrap();
    assert_eq!(
        cases,
        expected,
        "{} is stale; see the module docs",
        pinned.display()
    );
}
