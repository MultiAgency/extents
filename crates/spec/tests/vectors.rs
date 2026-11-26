//! The vectors in `tests/vectors` are the cross-language contract: an
//! implementation in another language agrees with this crate when it
//! computes the hashes in `expected.json` and rejects every file in
//! `rejected/`. The expected hashes were computed outside this crate, with
//! Python's `json.dumps(sort_keys=True, separators=(",", ":"),
//! ensure_ascii=False)`, which is JCS for these documents (ASCII keys, no
//! number that JCS would write differently).

use std::{collections::BTreeMap, fs, path::PathBuf};

use sha2::Digest;

use extents_spec::{Error, Review, Spec, judge_request, judged_text};
use near_account_id::AccountId;
use serde_json::{Value, json};

fn vector(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/vectors")
        .join(name);
    fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn expected(name: &str) -> String {
    let expected: BTreeMap<String, String> =
        serde_json::from_slice(&vector("expected.json")).unwrap();
    expected[name].clone()
}

fn spec() -> Spec {
    Spec::from_json(&vector("spec.json")).unwrap()
}

#[test]
fn spec_hash() {
    assert_eq!(hex::encode(spec().hash().unwrap()), expected("spec.json"));
}

/// Keys whose UTF-16 order differs from their code point order, non-ASCII
/// text, and floats JCS writes in exponent form. The expected hash comes from
/// Node (ECMAScript serialization plus UTF-16 key order, as RFC 8785
/// specifies), not Python, whose code point order would differ.
#[test]
fn unicode_and_float_spec_hash() {
    let spec = Spec::from_json(&vector("spec-unicode.json")).unwrap();
    assert_eq!(
        hex::encode(spec.hash().unwrap()),
        expected("spec-unicode.json")
    );
}

#[test]
fn review_hash() {
    let review = Review::from_json(&vector("review.json"), &spec()).unwrap();
    assert_eq!(hex::encode(review.hash().unwrap()), expected("review.json"));
}

/// What the evaluator saw of a fetch (status, content type, the address a redirect ended at) is optional:
/// `review.json` without any of it keeps its hash, and a review that has them is a second valid document.
// docs/spec.md, "One meaning has one hash"
#[test]
fn evidence_may_record_how_it_was_fetched() {
    let review = Review::from_json(&vector("review-evidence-fetch.json"), &spec()).unwrap();
    assert_eq!(
        hex::encode(review.hash().unwrap()),
        expected("review-evidence-fetch.json")
    );
    let e = &review.results[0].evidence[0];
    assert_eq!(e.status, Some(200));
    assert_eq!(e.content_type.as_deref(), Some("text/html; charset=utf-8"));
    assert_eq!(e.final_url.as_deref(), Some("https://lu.ma/example/"));
    // a page that recorded none of them leaves them out of the canonical form
    let plain = Review::from_json(&vector("review.json"), &spec()).unwrap();
    assert!(plain.results[0].evidence[0].final_url.is_none());
    assert!(!serde_json::to_string(&plain).unwrap().contains("final_url"));
}

// docs/spec.md, "One meaning has one hash"
#[test]
fn hash_ignores_layout() {
    // The vector is pretty-printed with fields out of order; its compact,
    // reordered serialization must hash the same.
    let spec = spec();
    let compact = serde_json::to_vec(&spec).unwrap();
    assert_eq!(
        Spec::from_json(&compact).unwrap().hash().unwrap(),
        spec.hash().unwrap()
    );
}

fn rejected_spec(name: &str) -> Error {
    Spec::from_json(&vector(&format!("rejected/{name}"))).unwrap_err()
}

fn rejected_review(name: &str) -> Error {
    Review::from_json(&vector(&format!("rejected/{name}")), &spec()).unwrap_err()
}

/// A fetching check that found nothing to fetch fails without evidence,
/// its detail saying why.
#[test]
fn a_fetching_check_fails_without_evidence() {
    let mut review: serde_json::Value = serde_json::from_slice(&vector("review.json")).unwrap();
    let page = &mut review["results"][0];
    assert_eq!(page["criterion_id"], "page");
    page["outcome"] = "fail".into();
    page["detail"] = "no event page url in any deliverable".into();
    page["evidence"] = serde_json::json!([]);
    Review::from_json(&serde_json::to_vec(&review).unwrap(), &spec()).unwrap();
}

// docs/spec.md, "A model is never the only gate"; docs/spec.md, "A judged spec caps the report size"; docs/spec.md, "One meaning has one hash"
#[test]
fn rejected_specs() {
    assert!(matches!(
        rejected_spec("spec-judge-without-report-limit.json"),
        Error::NoReportLimit
    ));
    assert!(matches!(
        rejected_spec("spec-lone-surrogate.json"),
        Error::Json(_)
    ));
    assert!(matches!(
        rejected_spec("spec-only-judges.json"),
        Error::NoScriptCheck
    ));
    assert!(matches!(
        rejected_spec("spec-null-optional.json"),
        Error::NotNormalForm
    ));
    assert!(matches!(
        rejected_spec("spec-unknown-field.json"),
        Error::NotNormalForm
    ));
    assert!(matches!(
        rejected_spec("spec-unsupported-version.json"),
        Error::Version(2)
    ));
    assert!(matches!(
        rejected_spec("spec-schema-draft-07.json"),
        Error::InvalidCheck { id, .. } if id == "attendance-json"
    ));
    assert!(matches!(
        rejected_spec("spec-statement-nel.json"),
        Error::Empty("statement")
    ));
    assert!(matches!(
        rejected_spec("spec-three-judges.json"),
        Error::TooManyJudges { .. }
    ));
    assert!(matches!(
        rejected_spec("spec-unbounded-number.json"),
        Error::InvalidCheck { id, .. } if id == "attendees"
    ));
}

// docs/spec.md, "A verdict follows its results"; docs/spec.md, "An outage is never a failed verdict"; docs/spec.md, "One meaning has one hash"
#[test]
fn rejected_reviews() {
    assert!(matches!(
        rejected_review("review-achieved-with-missing.json"),
        Error::VerdictMismatch {
            verdict: "achieved",
            ..
        }
    ));
    assert!(matches!(
        rejected_review("review-verdict-mismatch.json"),
        Error::VerdictMismatch { .. }
    ));
    assert!(matches!(
        rejected_review("review-missing-result.json"),
        Error::MissingResult(id) if id == "photos"
    ));
    assert!(matches!(
        rejected_review("review-spec-mismatch.json"),
        Error::SpecMismatch
    ));
    assert!(matches!(
        rejected_review("review-achieved-with-skipped.json"),
        Error::VerdictMismatch {
            verdict: "achieved",
            ..
        }
    ));
    assert!(matches!(
        rejected_review("review-missing-empty.json"),
        Error::NotNormalForm
    ));
    assert!(matches!(
        rejected_review("review-evidence-final-url-not-http.json"),
        Error::InvalidEvidence(u) if u.starts_with("ftp://")
    ));
    assert!(matches!(
        rejected_review("review-missing-evidence.json"),
        Error::MissingEvidence(id) if id == "page"
    ));
}

/// The request an `llm_judge` call sends, rebuilt from the deliverables.
/// The expected hash was computed independently with Node.
#[test]
fn judge_request_hash() {
    let v: Value = serde_json::from_slice(&vector("judge-request.json")).unwrap();
    let deliverables: Vec<(AccountId, String)> =
        serde_json::from_value(v["deliverables"].clone()).unwrap();
    let pairs: Vec<_> = deliverables
        .iter()
        .map(|(a, t)| (a.as_ref(), t.as_str()))
        .collect();
    let text = judged_text(&pairs);
    let request = judge_request(
        v["model"].as_str().unwrap(),
        v["question"].as_str().unwrap(),
        &text,
    )
    .unwrap();
    assert_eq!(
        hex::encode(sha2::Sha256::digest(&request)),
        v["request_sha256"].as_str().unwrap()
    );
}

/// `review.json` with the `useful` result and its call changed.
fn judged(outcome: &str, call: &Value) -> Result<Review, Error> {
    let mut review: Value = serde_json::from_slice(&vector("review.json")).unwrap();
    let results = review["results"].as_array_mut().unwrap();
    let useful = results
        .iter_mut()
        .find(|r| r["criterion_id"] == "useful")
        .unwrap();
    useful["outcome"] = outcome.into();
    review["llm_calls"] = json!([call.clone()]);
    Review::from_json(&serde_json::to_vec(&review).unwrap(), &spec())
}

fn call(criterion: &str, model: &str, answer: bool) -> Value {
    json!({
        "criterion_id": criterion,
        "model": model,
        "answer": answer,
        "request_sha256": "33".repeat(32),
        "response_sha256": "44".repeat(32),
    })
}

// docs/spec.md, "A judge is one model or three"
#[test]
fn a_judged_outcome_follows_its_models() {
    judged("pass", &call("useful", "example/model", true)).unwrap();
    judged("fail", &call("useful", "example/model", false)).unwrap();
    judged("skipped", &call("useful", "example/model", true)).unwrap();
    assert!(matches!(
        judged("pass", &call("useful", "example/model", false)),
        Err(Error::JudgeMismatch(id)) if id == "useful"
    ));
    assert!(matches!(
        judged("pass", &call("useful", "other/model", true)),
        Err(Error::InvalidCall { .. })
    ));
    assert!(matches!(
        judged("pass", &call("summary", "example/model", true)),
        Err(Error::InvalidCall { .. })
    ));
}

// docs/spec.md, "A judged spec caps the report size"
#[test]
fn a_judged_outcome_needs_its_calls() {
    let mut review: Value = serde_json::from_slice(&vector("review.json")).unwrap();
    for r in review["results"].as_array_mut().unwrap() {
        if r["criterion_id"] == "useful" {
            r["outcome"] = "pass".into();
        }
    }
    review["llm_calls"] = json!([]);
    assert!(matches!(
        Review::from_json(&serde_json::to_vec(&review).unwrap(), &spec()),
        Err(Error::InvalidCall { .. })
    ));
}

/// A report over `max_report_bytes` fails the judged criterion with no model
/// asked: a fail may have no calls, a pass never.
// docs/spec.md, "A judged spec caps the report size"
#[test]
fn a_judged_fail_may_have_no_calls() {
    let mut review: Value = serde_json::from_slice(&vector("review.json")).unwrap();
    for r in review["results"].as_array_mut().unwrap() {
        if r["criterion_id"] == "useful" {
            r["outcome"] = "fail".into();
        }
    }
    review["llm_calls"] = json!([]);
    Review::from_json(&serde_json::to_vec(&review).unwrap(), &spec()).unwrap();
}

/// Once any model was asked, a judged fail still needs every model's answer.
#[test]
fn a_judged_fail_with_some_calls_needs_them_all() {
    let mut spec: Value = serde_json::from_slice(&vector("spec.json")).unwrap();
    let useful = spec["criteria"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["id"] == "useful")
        .unwrap();
    useful["check"]["models"] = json!(["a/model", "b/model", "c/model"]);
    let three = Spec::from_json(&serde_json::to_vec(&spec).unwrap()).unwrap();
    let mut review: Value = serde_json::from_slice(&vector("review.json")).unwrap();
    review["spec_hash"] = hex::encode(three.hash().unwrap()).into();
    for r in review["results"].as_array_mut().unwrap() {
        if r["criterion_id"] == "useful" {
            r["outcome"] = "fail".into();
        }
    }
    review["llm_calls"] = json!([call("useful", "a/model", false)]);
    assert!(matches!(
        Review::from_json(&serde_json::to_vec(&review).unwrap(), &three),
        Err(Error::InvalidCall { .. })
    ));
}

// docs/spec.md, "A judge is one model or three"
#[test]
fn a_judge_needs_one_model_or_three() {
    let mut spec: Value = serde_json::from_slice(&vector("spec.json")).unwrap();
    let useful = spec["criteria"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["id"] == "useful")
        .unwrap();
    useful["check"]["models"] = json!(["a/model", "b/model"]);
    assert!(matches!(
        Spec::from_json(&serde_json::to_vec(&spec).unwrap()),
        Err(Error::InvalidCheck { .. })
    ));
}

#[test]
fn a_pinned_build_must_be_recorded() {
    let mut spec: Value = serde_json::from_slice(&vector("spec.json")).unwrap();
    spec["evaluator_build"] = "ab".repeat(32).into();
    let pinned = Spec::from_json(&serde_json::to_vec(&spec).unwrap()).unwrap();
    let mut review: Value = serde_json::from_slice(&vector("review.json")).unwrap();
    review["spec_hash"] = hex::encode(pinned.hash().unwrap()).into();
    let without = serde_json::to_vec(&review).unwrap();
    assert!(matches!(
        Review::from_json(&without, &pinned),
        Err(Error::EvaluatorBuildMismatch)
    ));
    review["evaluator_build"] = "ab".repeat(32).into();
    Review::from_json(&serde_json::to_vec(&review).unwrap(), &pinned).unwrap();
}

/// A skipped check is the evaluator's own failure: with nothing failed and no
/// report missing, it cannot support `failed`.
// docs/spec.md, "An outage is never a failed verdict"
#[test]
fn an_outage_never_supports_failed() {
    let mut review: Value = serde_json::from_slice(&vector("review.json")).unwrap();
    assert_eq!(review["verdict"], "failed");
    for r in review["results"].as_array_mut().unwrap() {
        if r["outcome"] == "fail" {
            r["outcome"] = "skipped".into();
        }
    }
    assert!(matches!(
        Review::from_json(&serde_json::to_vec(&review).unwrap(), &spec()),
        Err(Error::VerdictMismatch {
            verdict: "failed",
            ..
        })
    ));
}

/// A contributor whose report was never published supports `failed` on its
/// own, and cannot also be listed as delivered.
// docs/spec.md, "A verdict follows its results"
#[test]
fn a_missing_report_supports_failed() {
    let mut review: Value = serde_json::from_slice(&vector("review.json")).unwrap();
    for r in review["results"].as_array_mut().unwrap() {
        if r["outcome"] == "fail" {
            r["outcome"] = "pass".into();
        }
    }
    review["missing"] = json!(["venue.testnet"]);
    let deliverables = review["deliverables"].as_array_mut().unwrap();
    deliverables.retain(|d| d["contributor"] != "venue.testnet");
    Review::from_json(&serde_json::to_vec(&review).unwrap(), &spec()).unwrap();

    review["deliverables"]
        .as_array_mut()
        .unwrap()
        .push(json!({"contributor": "venue.testnet", "sha256": "22".repeat(32)}));
    assert!(matches!(
        Review::from_json(&serde_json::to_vec(&review).unwrap(), &spec()),
        Err(Error::InvalidMissing(_))
    ));
}

/// "Empty" text means Unicode `White_Space` and nothing else. The TypeScript mirror uses the same set (its `trim()`
/// would differ): U+0085 is blank, U+FEFF is not.
#[test]
fn blank_text_is_unicode_white_space() {
    let with_statement = |statement: &str| {
        let mut spec: Value = serde_json::from_slice(&vector("spec.json")).unwrap();
        spec["statement"] = statement.into();
        Spec::from_json(&serde_json::to_vec(&spec).unwrap())
    };
    for blank in ["\u{85}", "\u{a0}", "\u{2028}", "\u{3000}", " \t\n"] {
        assert!(
            matches!(with_statement(blank), Err(Error::Empty("statement"))),
            "{blank:?}"
        );
    }
    for kept in ["\u{feff}", "\u{200b}", "\u{180e}", "\u{1c}"] {
        assert!(with_statement(kept).is_ok(), "{kept:?}");
    }
}

/// A `schema` criterion is JSON Schema draft 2020-12. A schema may say so, in either spelling of that dialect's
/// identifier; one that names any other dialect is refused, not compiled under rules it was not written for.
// docs/spec.md, "A schema is draft 2020-12"
#[test]
fn a_schema_names_no_dialect_but_2020_12() {
    let with_dialect = |dialect: Value| {
        let mut spec: Value = serde_json::from_slice(&vector("spec.json")).unwrap();
        let schema = spec["criteria"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["check"]["kind"] == "schema")
            .unwrap();
        schema["check"]["json_schema"]["$schema"] = dialect;
        Spec::from_json(&serde_json::to_vec(&spec).unwrap())
    };
    for named in [
        "https://json-schema.org/draft/2020-12/schema",
        "https://json-schema.org/draft/2020-12/schema#",
    ] {
        assert!(with_dialect(named.into()).is_ok(), "{named}");
    }
    for other in [
        json!("http://json-schema.org/draft/2020-12/schema"),
        json!("https://json-schema.org/draft/2020-12/schema##"),
        json!("https://json-schema.org/draft/2019-09/schema"),
        json!("http://json-schema.org/draft-07/schema#"),
        json!("https://example.org/my-dialect"),
        json!(""),
        json!(5),
        json!(null),
    ] {
        assert!(
            matches!(with_dialect(other.clone()), Err(Error::InvalidCheck { id, .. }) if id == "attendance-json"),
            "{other}"
        );
    }
}
