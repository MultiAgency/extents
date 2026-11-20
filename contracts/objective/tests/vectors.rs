//! Pinned encodings of `Params` and the initial state, for implementations
//! in other languages (the TypeScript mirror in `app/`) to check against
//! the contract itself rather than against testnet deployments.
//!
//! `tests/vectors/params.json` holds, for each case: the params JSON, their
//! borsh bytes and hash, the `StateInit` data entry, and the NEP-616 account
//! id it derives under a fixed code hash, and the Tgas `ob_attest` needs
//! (`Params::attest_gas`) and `ob_close` needs (`Params::close_gas`). `params.schema.bin` and
//! `storage.schema.bin` hold the borsh schema containers of `Params` and
//! `ContractStorage`, from which TypeScript schemas can be generated. The test fails when the code and
//! the file disagree. After a deliberate layout change, rewrite the file
//! with `EXTENTS_WRITE_VECTORS=1 cargo test -p extents-objective --test
//! vectors` and review the diff.
//!
//! `tests/vectors/rejected/` holds one params document per rule the
//! contract enforces, hand-written. Each must be refused, at parsing or by
//! `Params::validate` with the error `rejected_params` expects, and by the
//! TypeScript mirror.

use std::{collections::BTreeMap, fs, path::PathBuf};

use extents_objective::{ContractStorage, Error, Params, Pips, Timestamp, token_id::TokenId};
use near_kit::{
    CryptoHash,
    protocol::{StateInit, StateInitExt},
};
use near_sdk::{AccountId, borsh};
use serde_json::{Value, json};

/// Any 32 bytes would do; this is the code hash of the global contract the
/// e2e results on testnet were produced with.
const CODE_HASH: &str = "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa";

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn case(contributors: &[(&str, u32)], window: Option<u32>, auth_caller: Option<&str>) -> Params {
    Params {
        sponsor: id("sponsor.near"),
        token: "nep245:intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
            .parse::<TokenId>()
            .unwrap(),
        evaluator: id("evaluator.near"),
        contributors: contributors
            .iter()
            .map(|(c, pips)| (id(c), Pips::from_pips(*pips).unwrap()))
            .collect(),
        backups: BTreeMap::new(),
        deadline: Timestamp::from_secs(1_800_000_000).unwrap(),
        commit_by: None,
        acceptance_window_secs: window,
        spec_hash: [0x5a; 32],
        auth_caller: auth_caller.map(id),
        salt: [0x01; 32],
    }
}

fn cases() -> Vec<(&'static str, Params)> {
    let ten: Vec<(String, u32)> = (0..10).map(|i| (format!("c{i}.near"), 100_000)).collect();
    let ten: Vec<(&str, u32)> = ten.iter().map(|(c, p)| (c.as_str(), *p)).collect();
    vec![
        (
            "one-contributor",
            case(&[("alice.near", 1_000_000)], None, None),
        ),
        (
            "windowed-auth-call",
            case(
                &[("alice.near", 700_000), ("bob.near", 300_000)],
                Some(86_400),
                Some("intents.near"),
            ),
        ),
        (
            "ten-contributors",
            case(&ten, Some(1), Some("intents.near")),
        ),
        ("backups", {
            let mut p = case(
                &[("alice.near", 700_000), ("bob.near", 300_000)],
                Some(3_600),
                None,
            );
            p.backups = [(id("bob.near"), id("carol.near"))].into();
            p.commit_by = Timestamp::from_secs(1_799_000_000);
            p
        }),
    ]
}

fn vector(name: &str, params: &Params) -> Value {
    params.validate().unwrap();
    let data = ContractStorage::init_state(params).unwrap();
    let (key, value) = data.iter().next().unwrap();
    let code_hash: CryptoHash = CODE_HASH.parse().unwrap();
    let account_id = StateInit::by_hash(code_hash, data.clone()).derive_account_id();
    json!({
        "name": name,
        "params": params,
        "params_borsh": hex::encode(borsh::to_vec(params).unwrap()),
        "params_hash": hex::encode(params.hash()),
        "state_init": { "key": hex::encode(key), "value": hex::encode(value) },
        "code_hash": CODE_HASH,
        "account_id": account_id.as_str(),
        "attest_tgas": params.attest_gas().as_tgas(),
        "close_tgas": params.close_gas().as_tgas(),
    })
}

/// The contract derives its own address with near-sdk when it checks funding;
/// the pinned account ids come from near-kit. Both must agree.
#[test]
fn near_sdk_derives_the_pinned_accounts() {
    use near_sdk::{
        GlobalContractId,
        state_init::{StateInit as SdkStateInit, StateInitV1},
    };

    let code_hash: CryptoHash = CODE_HASH.parse().unwrap();
    for (name, params) in cases() {
        let pinned = vector(name, &params)["account_id"].clone();
        let derived = SdkStateInit::V1(StateInitV1 {
            code: GlobalContractId::CodeHash(*code_hash.as_bytes()),
            data: ContractStorage::init_state(&params).unwrap(),
        })
        .derive_account_id();
        assert_eq!(derived.as_str(), pinned, "{name}");
    }
}

#[test]
fn params_vectors_match_the_contract() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/params.json");
    let actual = Value::Array(cases().iter().map(|(n, p)| vector(n, p)).collect());

    if std::env::var_os("EXTENTS_WRITE_VECTORS").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
        return;
    }
    let pinned: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        pinned,
        actual,
        "{} is stale; see the module docs",
        path.display()
    );
}

/// The borsh schema containers of `Params` and of the initial state, as
/// `zorsh-schema-gen` reads them: `tests/vectors/<name>.schema.bin`.
#[test]
fn borsh_schemas_match_the_contract() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/vectors");
    for (name, container) in [
        ("params", borsh::schema_container_of::<Params>()),
        ("storage", borsh::schema_container_of::<ContractStorage>()),
    ] {
        let path = dir.join(format!("{name}.schema.bin"));
        let actual = borsh::to_vec(&container).unwrap();
        if std::env::var_os("EXTENTS_WRITE_VECTORS").is_some() {
            fs::write(&path, &actual).unwrap();
            continue;
        }
        assert_eq!(
            fs::read(&path).unwrap(),
            actual,
            "{} is stale; see the module docs",
            path.display()
        );
    }
}

/// What refuses a `tests/vectors/rejected/` case.
#[derive(Debug)]
enum Refusal {
    /// `Params` does not deserialize, with an error containing this.
    Parse(&'static str),
    /// `Params::validate`, with this error.
    Invalid(Error),
}

/// One params document per rule the contract enforces, each refused. The
/// TypeScript mirror (`validateParams`) must refuse every one as well.
#[test]
fn rejected_params() {
    use Refusal::{Invalid, Parse};
    let cases = [
        ("params-nep141-token", Invalid(Error::WrongToken)),
        (
            "params-zero-window",
            Invalid(Error::InvalidAcceptanceWindow),
        ),
        ("params-window-overflow", Parse("expected u32")),
        ("params-no-contributors", Invalid(Error::InvalidShares)),
        ("params-eleven-contributors", Invalid(Error::InvalidShares)),
        ("params-zero-share", Invalid(Error::InvalidShares)),
        (
            "params-fractional-share",
            Parse("invalid type: floating point"),
        ),
        ("params-share-over-max", Parse("out of range: 0..=1000000")),
        ("params-shares-under-total", Invalid(Error::InvalidShares)),
        ("params-evaluator-contributor", Invalid(Error::Unauthorized)),
        (
            "params-impossible-deadline",
            Parse("did not include enough information"),
        ),
        (
            "params-backups-without-commit-by",
            Invalid(Error::InvalidBackups),
        ),
        (
            "params-commit-by-without-backups",
            Invalid(Error::InvalidBackups),
        ),
        (
            "params-commit-by-at-deadline",
            Invalid(Error::InvalidBackups),
        ),
        ("params-backup-for-unlisted", Invalid(Error::InvalidBackups)),
        (
            "params-backup-is-contributor",
            Invalid(Error::InvalidBackups),
        ),
        ("params-shared-backup", Invalid(Error::InvalidBackups)),
        ("params-evaluator-backup", Invalid(Error::Unauthorized)),
        (
            "params-foreign-auth-caller",
            Invalid(Error::InvalidAuthCaller),
        ),
        (
            "params-deadline-past-2262",
            Invalid(Error::InvalidTimestamp),
        ),
    ];

    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/rejected");
    let mut files: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort_unstable();
    let mut listed: Vec<String> = cases.iter().map(|(n, _)| format!("{n}.json")).collect();
    listed.sort_unstable();
    assert_eq!(
        files, listed,
        "every rejected vector needs an expected refusal"
    );

    for (name, expected) in cases {
        let json = fs::read(dir.join(format!("{name}.json"))).unwrap();
        match (serde_json::from_slice::<Params>(&json), expected) {
            (Err(err), Parse(reason)) => {
                assert!(err.to_string().contains(reason), "{name}: {err}");
            }
            (Ok(params), Invalid(expected)) => {
                let err = params.validate().expect_err(name);
                assert_eq!(format!("{err:?}"), format!("{expected:?}"), "{name}");
            }
            (actual, expected) => panic!("{name}: expected {expected:?}, got {actual:?}"),
        }
    }
}

#[test]
fn pinned_params_round_trip_through_json() {
    for (_, params) in cases() {
        let json = serde_json::to_string(&params).unwrap();
        assert_eq!(serde_json::from_str::<Params>(&json).unwrap(), params);
    }
}
