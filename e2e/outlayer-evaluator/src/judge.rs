//! Judging reports against a spec, with the fetching left to the caller.
//!
//! The checks follow `app/src/server/checks.ts`, with one rule of this
//! evaluator's own: a `live_url` page is fetched only if the spec names its
//! exact URL, as the phrase of a `contains` criterion, on a host this build
//! may reach. The contributor still cites the URL, but cannot choose it.

use extents_spec::{Check, Criterion, CriterionResult, Evidence, Outcome, Spec};
use sha2::{Digest, Sha256};

/// The hosts evidence may come from: the manifest's `capabilities.network`,
/// less the RPC the program reads deliveries from.
pub const HOSTS: &[&str] = &["api.github.com"];

/// What a fetch of a pinned URL returned.
pub enum Page {
    Loaded {
        status: u16,
        body: Vec<u8>,
    },
    /// It could not be fetched, and why.
    Unavailable(String),
}

/// Why no verdict can be given now. Nothing is signed: the objective stays
/// open, and expires unless a later run can judge it.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The spec asks for something this build does not judge.
    Unsupported(String),
    /// The evaluator's side failed: its network, or the host.
    Unavailable(String),
    /// A page loads but does not yet show what it must. Anyone can run this
    /// program at any time, so what may still come true is never failed.
    NotYet(String),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(why) => write!(f, "unsupported: {why}"),
            Self::Unavailable(why) => write!(f, "unavailable: {why}"),
            Self::NotYet(why) => write!(f, "not yet: {why}"),
        }
    }
}

/// One result per criterion of `spec`, each holding for every report, or
/// why they cannot be given now. A `fail` is final: it follows from the
/// reports alone, which cannot change once delivered.
pub fn judge(
    spec: &Spec,
    reports: &[&str],
    fetch: &mut dyn FnMut(&str) -> Page,
) -> Result<Vec<CriterionResult>, Refusal> {
    spec.criteria
        .iter()
        .map(|criterion| {
            let mut result = pass(criterion);
            for report in reports {
                let one = check(spec, criterion, report, fetch)?;
                result.evidence.extend(one.evidence);
                if one.outcome != Outcome::Pass {
                    result.outcome = one.outcome;
                    result.detail = one.detail;
                    break;
                }
                result.detail = one.detail;
            }
            Ok(result)
        })
        .collect()
}

fn pass(criterion: &Criterion) -> CriterionResult {
    CriterionResult {
        criterion_id: criterion.id.clone(),
        outcome: Outcome::Pass,
        detail: String::new(),
        evidence: Vec::new(),
    }
}

fn check(
    spec: &Spec,
    criterion: &Criterion,
    report: &str,
    fetch: &mut dyn FnMut(&str) -> Page,
) -> Result<CriterionResult, Refusal> {
    let result = |outcome, detail: String, evidence| CriterionResult {
        criterion_id: criterion.id.clone(),
        outcome,
        detail,
        evidence,
    };
    let fail = |detail| Ok(result(Outcome::Fail, detail, Vec::new()));
    match &criterion.check {
        Check::Contains { phrase, absent } => {
            let found = contains(report, phrase);
            let outcome = if found == *absent {
                Outcome::Fail
            } else {
                Outcome::Pass
            };
            let found = if found { "found" } else { "not found" };
            Ok(result(outcome, format!("\"{phrase}\" {found}"), Vec::new()))
        }
        Check::LiveUrl {
            label,
            must_contain,
        } => {
            let Some(url) = labelled(report, label).and_then(link) else {
                return fail(format!("no \"{label}: <url>\" line"));
            };
            if !pinned(spec, url) {
                return fail(format!("{url} is not a URL the spec names"));
            }
            if !HOSTS
                .iter()
                .any(|host| url.starts_with(&format!("https://{host}/")))
            {
                return Err(Refusal::Unsupported(format!(
                    "{url} is not on a host this evaluator fetches from"
                )));
            }
            let body = match fetch(url) {
                Page::Loaded { status, body } if (200..300).contains(&status) => body,
                Page::Loaded { status, .. } => {
                    return Err(Refusal::Unavailable(format!(
                        "{url} could not be checked (HTTP {status})"
                    )));
                }
                Page::Unavailable(why) => {
                    return Err(Refusal::Unavailable(format!("{url} did not load ({why})")));
                }
            };
            let shows = must_contain.as_ref().is_none_or(|text| shows(&body, text));
            if !shows {
                return Err(Refusal::NotYet(format!(
                    "{url} loads but does not show \"{}\"",
                    must_contain.as_deref().unwrap_or_default()
                )));
            }
            let evidence = vec![Evidence {
                url: url.to_owned(),
                sha256: Sha256::digest(&body).into(),
                status: None,
                content_type: None,
                final_url: None,
            }];
            let shows = must_contain
                .as_ref()
                .map(|text| format!(" and shows \"{text}\""))
                .unwrap_or_default();
            Ok(result(
                Outcome::Pass,
                format!("{url} loads{shows}"),
                evidence,
            ))
        }
        _ => Err(Refusal::Unsupported(format!(
            "criterion {}: only `contains` and `live_url` are judged",
            criterion.id
        ))),
    }
}

/// Whether `text` includes `phrase`, ignoring case.
fn contains(text: &str, phrase: &str) -> bool {
    text.to_lowercase().contains(&phrase.to_lowercase())
}

/// Whether the page `body` shows `text`: as served, or, when it is JSON, in
/// its compact form. A host may serve one document with or without
/// whitespace between tokens, as GitHub does from one request to the next,
/// so text written compactly matches either.
fn shows(body: &[u8], text: &str) -> bool {
    contains(&String::from_utf8_lossy(body), text)
        || serde_json::from_slice::<serde_json::Value>(body)
            .is_ok_and(|json| contains(&json.to_string(), text))
}

/// Whether `spec` names exactly `url`: as the phrase a report must contain.
fn pinned(spec: &Spec, url: &str) -> bool {
    spec.criteria
        .iter()
        .any(|c| matches!(&c.check, Check::Contains { phrase, absent: false } if phrase == url))
}

/// The value on a `<label>: <value>` line: the label matched ignoring case,
/// after a list marker and inside emphasis.
fn labelled<'a>(text: &'a str, label: &str) -> Option<&'a str> {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .filter_map(|line| {
            let line = line.trim_start();
            let line = line.strip_prefix(['-', '*']).unwrap_or(line).trim_start();
            let mut rest = line.trim_start_matches('*');
            for expected in label.chars() {
                let mut chars = rest.chars();
                let found = chars.next()?;
                if !found.to_lowercase().eq(expected.to_lowercase()) {
                    return None;
                }
                rest = chars.as_str();
            }
            let value = rest
                .trim_start_matches('*')
                .trim_start()
                .strip_prefix(':')?
                .trim();
            (!value.is_empty()).then_some(value)
        })
        .next()
}

/// The first link in `value`.
fn link(value: &str) -> Option<&str> {
    let start = ["https://", "http://"]
        .iter()
        .filter_map(|scheme| value.find(scheme))
        .min()?;
    let link = &value[start..];
    let end = link
        .find(|c: char| c.is_whitespace() || [')', '<', '>', ']', '"', '\''].contains(&c))
        .unwrap_or(link.len());
    Some(&link[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    const PULL: &str = "https://api.github.com/repos/owner/repo/pulls/7";
    // GitHub serves compact JSON.
    const MERGED: &str = r#"{"state":"closed","merged":true}"#;
    const OPEN: &str = r#"{"state":"open","merged":false}"#;

    /// The spec of `docs/coding-objective.md`, with the pull request named.
    fn spec(pull: &str) -> Spec {
        Spec::from_json(
            serde_json::json!({
                "v": 1,
                "statement": "The named pull request is merged.",
                "criteria": [
                    { "id": "pull-request", "description": "The report cites the pull request",
                      "check": { "kind": "contains", "phrase": pull, "absent": false } },
                    { "id": "merged", "description": "GitHub reports it as merged",
                      "check": { "kind": "live_url", "label": "Pull request API",
                                 "must_contain": "\"merged\":true" } },
                    { "id": "summary", "description": "The report has a Summary section",
                      "check": { "kind": "contains", "phrase": "## Summary", "absent": false } },
                ],
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap()
    }

    fn report(cited: &str) -> String {
        format!("## Summary\n\nDone in {PULL}.\n\n- **Pull request API**: {cited}\n")
    }

    /// Judges `report` against the spec, answering every fetch with `body`.
    fn judged(report: &str, body: &str) -> (Result<Vec<Outcome>, Refusal>, Vec<String>) {
        let mut fetched = Vec::new();
        let outcomes = judge(&spec(PULL), &[report], &mut |url| {
            fetched.push(url.to_owned());
            Page::Loaded {
                status: 200,
                body: body.as_bytes().to_vec(),
            }
        })
        .map(|results| results.into_iter().map(|r| r.outcome).collect());
        (outcomes, fetched)
    }

    #[test]
    fn a_merged_pull_request_passes_with_its_evidence() {
        let results = judge(&spec(PULL), &[&report(PULL)], &mut |_| Page::Loaded {
            status: 200,
            body: MERGED.as_bytes().to_vec(),
        })
        .unwrap();
        assert!(results.iter().all(|r| r.outcome == Outcome::Pass));
        assert_eq!(
            results[1].evidence,
            [Evidence {
                url: PULL.into(),
                sha256: Sha256::digest(MERGED).into(),
                status: None,
                content_type: None,
                final_url: None,
            }]
        );
    }

    #[test]
    fn a_page_served_with_whitespace_shows_the_same() {
        let pretty = "{\n  \"state\": \"closed\",\n  \"merged\": true\n}";
        assert_eq!(judged(&report(PULL), pretty).0.unwrap(), [Outcome::Pass; 3]);
        let open = "{\n  \"merged\": false,\n  \"body\": \"\\\"merged\\\":true\"\n}";
        let (outcomes, _) = judged(&report(PULL), open);
        assert!(matches!(outcomes, Err(Refusal::NotYet(_))), "{outcomes:?}");
    }

    #[test]
    fn an_unmerged_pull_request_is_not_failed() {
        let (outcomes, _) = judged(&report(PULL), OPEN);
        assert!(matches!(outcomes, Err(Refusal::NotYet(_))), "{outcomes:?}");
    }

    #[test]
    fn a_page_the_spec_does_not_name_is_never_fetched() {
        for cited in [
            "https://example.org/merged.json",
            "https://api.github.com/repos/owner/repo/pulls/8",
            "https://api.github.com/repos/owner/repo/pulls/7/",
            "https://API.github.com/repos/owner/repo/pulls/7",
        ] {
            let (outcomes, fetched) = judged(&report(cited), MERGED);
            assert_eq!(
                outcomes.unwrap(),
                [Outcome::Pass, Outcome::Fail, Outcome::Pass],
                "{cited}"
            );
            assert!(fetched.is_empty(), "{cited}");
        }
    }

    #[test]
    fn a_missing_citation_or_section_fails() {
        let (outcomes, fetched) = judged(&format!("## Summary\n\n{PULL}\n"), MERGED);
        assert_eq!(
            outcomes.unwrap(),
            [Outcome::Pass, Outcome::Fail, Outcome::Pass]
        );
        assert!(fetched.is_empty());

        let (outcomes, _) = judged(&format!("Pull request API: {PULL}\n"), MERGED);
        assert_eq!(
            outcomes.unwrap(),
            [Outcome::Pass, Outcome::Pass, Outcome::Fail]
        );
    }

    #[test]
    fn text_a_contributor_wrote_into_the_pull_request_does_not_pass() {
        // GitHub escapes the quotes of a description that says `"merged":true`.
        let body = r#"{"body":"\"merged\":true","merged":false}"#;
        let (outcomes, _) = judged(&report(PULL), body);
        assert!(matches!(outcomes, Err(Refusal::NotYet(_))), "{outcomes:?}");
    }

    #[test]
    fn an_outage_or_an_error_status_is_not_a_verdict() {
        for page in [
            || Page::Unavailable("timed out".into()),
            || Page::Loaded {
                status: 403,
                body: b"rate limit exceeded".to_vec(),
            },
            || Page::Loaded {
                status: 301,
                body: Vec::new(),
            },
        ] {
            let judged = judge(&spec(PULL), &[&report(PULL)], &mut |_| page());
            assert!(matches!(judged, Err(Refusal::Unavailable(_))), "{judged:?}");
        }
    }

    #[test]
    fn a_host_this_build_cannot_reach_is_refused() {
        let pull = "https://gitlab.com/api/v4/projects/1/merge_requests/7";
        let report = format!("## Summary\n\n{pull}\n\nPull request API: {pull}\n");
        let judged = judge(&spec(pull), &[&report], &mut |_| unreachable!());
        assert!(matches!(judged, Err(Refusal::Unsupported(_))), "{judged:?}");
    }

    #[test]
    fn a_criterion_of_another_kind_is_refused() {
        let spec = Spec::from_json(
            br#"{"v":1,"statement":"s","criteria":[{"id":"n","description":"d","check":{"kind":"numeric_match","label":"Attendees","min":1}}]}"#,
        )
        .unwrap();
        let judged = judge(&spec, &["Attendees: 5"], &mut |_| unreachable!());
        assert!(matches!(judged, Err(Refusal::Unsupported(_))), "{judged:?}");
    }

    #[test]
    fn every_report_must_pass() {
        let other = format!("{PULL}\n\nPull request API: {PULL}\n");
        let outcomes: Vec<_> = judge(&spec(PULL), &[&report(PULL), &other], &mut |_| {
            Page::Loaded {
                status: 200,
                body: MERGED.as_bytes().to_vec(),
            }
        })
        .unwrap()
        .into_iter()
        .map(|r| r.outcome)
        .collect();
        assert_eq!(outcomes, [Outcome::Pass, Outcome::Pass, Outcome::Fail]);
    }

    #[test]
    fn labels_are_read_as_the_app_reads_them() {
        for line in [
            "Pull request API: https://a.example/x",
            "  - pull request api:https://a.example/x.",
            "* **Pull request API**: see (https://a.example/x)",
            "**Pull request API:** <https://a.example/x>",
        ] {
            let value = labelled(line, "Pull request API").and_then(link);
            assert!(
                value.is_some_and(|v| v.trim_end_matches('.') == "https://a.example/x"),
                "{line}: {value:?}"
            );
        }
        assert_eq!(
            labelled("Pull request API:\nnext", "Pull request API"),
            None
        );
        assert_eq!(labelled("My Pull request API: x", "Pull request API"), None);
    }
}
