//! The spec every e2e objective commits to, and the reviews its evaluator
//! attests with. Both are synthetic: nothing is delivered, and each result
//! is scripted to give the verdict a scenario needs. What the e2e
//! establishes is that the hashes on-chain are the hashes of these
//! documents, not that any check ran.

use anyhow::Result;
use extents_objective::{Params, Verdict};
use extents_spec::{
    Check, Criterion, CriterionResult, Deliverable, Outcome, Review, Spec, VERSION,
};
use sha2::{Digest, Sha256};

pub fn spec() -> Spec {
    Spec {
        v: VERSION,
        statement: "Synthetic e2e objective: each contributor delivers a report. \
                    Nothing is delivered; the evaluator's results are scripted."
            .into(),
        criteria: vec![
            Criterion {
                id: "report".into(),
                description: "Each contributor's report is delivered".into(),
                check: Check::Files {
                    paths: vec!["report.md".into()],
                },
            },
            Criterion {
                id: "summary".into(),
                description: "The report has a Summary section".into(),
                check: Check::Contains {
                    phrase: "## Summary".into(),
                    absent: false,
                },
            },
        ],
        max_report_bytes: None,
        evaluator_build: None,
    }
}

/// A merged pull request of this repository, by GitHub's API URL: the
/// evidence of the `outlayer-evaluator` scenario.
pub const MERGED_PULL: &str = "https://api.github.com/repos/MultiAgency/extents/pulls/13";
/// The label of the report's line that cites it.
pub const PULL_LABEL: &str = "Pull request API";

/// The spec of the `outlayer-evaluator` scenario, and the sha256 of the
/// program that judges it: `pull` is merged.
///
/// `pull-request` names the evidence in the terms. The program fetches the
/// page a report cites for `merged` only if it is that exact URL.
pub fn outlayer_spec(evaluator_build: [u8; 32], pull: &str) -> Spec {
    let criterion = |id: &str, description: &str, check| Criterion {
        id: id.into(),
        description: description.into(),
        check,
    };
    let contains = |phrase: &str| Check::Contains {
        phrase: phrase.into(),
        absent: false,
    };
    Spec {
        v: VERSION,
        statement: format!(
            "The pull request at {pull} is merged. The contributor's report cites that URL \
             on a `{PULL_LABEL}:` line."
        ),
        criteria: vec![
            criterion(
                "pull-request",
                "The report cites the pull request's GitHub API URL",
                contains(pull),
            ),
            criterion(
                "merged",
                "GitHub's API reports the cited pull request as merged",
                Check::LiveUrl {
                    label: PULL_LABEL.into(),
                    // GitHub serves compact JSON: no space after the colon.
                    must_contain: Some("\"merged\":true".into()),
                },
            ),
            criterion(
                "summary",
                "The report has a Summary section",
                contains("## Summary"),
            ),
        ],
        max_report_bytes: None,
        evaluator_build: Some(evaluator_build),
    }
}

/// The hash a contributor delivers with `ob_deliver`, and the review lists
/// as its deliverable.
pub fn deliverable(contributor: &str) -> [u8; 32] {
    Sha256::digest(format!("synthetic deliverable from {contributor}")).into()
}

/// A review of the objective at `objective`, with `params`' contributors,
/// against [`spec`], whose results give `verdict`: every criterion passes
/// for an achieved verdict, the first fails for a failed one.
pub fn review(objective: &str, params: &Params, verdict: Verdict) -> Result<Review> {
    let spec = spec();
    let deliverables = params
        .contributors
        .keys()
        .map(|c| {
            Ok(Deliverable {
                contributor: c.as_str().parse()?,
                sha256: deliverable(c.as_str()),
            })
        })
        .collect::<Result<_>>()?;
    let results = (0..)
        .zip(&spec.criteria)
        .map(|(idx, c)| {
            let outcome = match verdict {
                Verdict::Failed if idx == 0 => Outcome::Fail,
                _ => Outcome::Pass,
            };
            CriterionResult {
                criterion_id: c.id.clone(),
                outcome,
                detail: "scripted by the e2e".into(),
                evidence: Vec::new(),
            }
        })
        .collect();
    let review = Review {
        v: VERSION,
        objective: objective.parse()?,
        spec_hash: spec.hash()?,
        deliverables,
        missing: Vec::new(),
        results,
        llm_calls: Vec::new(),
        verdict: match verdict {
            Verdict::Achieved => extents_spec::Verdict::Achieved,
            Verdict::Failed => extents_spec::Verdict::Failed,
        },
        evaluator_build: None,
    };
    review.validate(&spec)?;
    Ok(review)
}
