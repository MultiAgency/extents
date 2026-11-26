use std::collections::{BTreeMap, BTreeSet};

use near_account_id::AccountId;
use serde::{Deserialize, Serialize};
use serde_with::{hex::Hex, serde_as};

use crate::{Check, Error, Hash, Result, Spec, check_version};

/// The evaluator's record of a verdict: what was judged, each criterion's
/// result, and the model calls behind any judgement. Anyone holding the
/// spec and the deliverables can repeat the checks against it.
///
/// An evaluator that could not check anything (its model or the network
/// was down) writes no review and does not attest. The objective then
/// expires, and an outage is never recorded as a failure.
#[serde_as]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Review {
    pub v: u32,
    /// The objective judged: the account the verdict is attested on. A
    /// consumer checks it against that account, so a review cannot be
    /// reused for another objective with the same spec and contributors.
    pub objective: AccountId,
    #[serde_as(as = "Hex")]
    pub spec_hash: Hash,
    /// What each contributor delivered, by hash. The deliverables stay off
    /// chain.
    pub deliverables: Vec<Deliverable>,
    /// Contributors whose delivery is on chain but whose report was never
    /// published, so it could not be judged. Any supports `failed`; `achieved`
    /// needs none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<AccountId>,
    /// One per criterion of the spec.
    pub results: Vec<CriterionResult>,
    pub llm_calls: Vec<LlmCall>,
    pub verdict: Verdict,
    /// SHA-256 of the evaluator program that wrote this review, for an
    /// attested evaluator. Required, and equal, when the spec pins one.
    #[serde_as(as = "Option<Hex>")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluator_build: Option<Hash>,
}

#[serde_as]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deliverable {
    pub contributor: AccountId,
    #[serde_as(as = "Hex")]
    pub sha256: Hash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CriterionResult {
    pub criterion_id: String,
    pub outcome: Outcome,
    /// Why, for people: the quote found, the figure read, the error met.
    pub detail: String,
    /// What was fetched to reach the outcome, by hash, so a later check
    /// runs against the same bytes rather than a page that may have
    /// changed. Required for a checked `live_url`, `sources` or `media`
    /// criterion.
    pub evidence: Vec<Evidence>,
}

/// One fetched resource, as the evaluator received it.
#[serde_as]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    pub url: String,
    /// SHA-256 of the response body.
    #[serde_as(as = "Hex")]
    pub sha256: Hash,
    /// The HTTP status of the final response. Absent when not recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// The final response's `Content-Type` header, verbatim. Absent when the
    /// response had none: there is no encodable default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// Where the fetch ended, when a redirect was followed; `url` stays the
    /// cited one. Absent when the cited page answered itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Pass,
    /// Failed, including when the contributor's side made it uncheckable: a
    /// report over `max_report_bytes`, or a cited host answering with an
    /// error. An evaluator records those as fail after a retry.
    Fail,
    /// Could not be checked because of the evaluator's side: its model or its
    /// network was unavailable, or a host never answered. Never part of an
    /// `achieved` verdict, which needs every criterion to pass.
    Skipped,
}

/// One `llm_judge` call, by hashes of its exact request and response
/// bodies. The request is the one [`crate::judge_request`] builds, so anyone
/// holding the deliverables can check `request_sha256`.
#[serde_as]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LlmCall {
    /// The `llm_judge` criterion it judged.
    pub criterion_id: String,
    /// One of that criterion's `models`.
    pub model: String,
    /// The answer read from the response: `true` for yes.
    pub answer: bool,
    #[serde_as(as = "Hex")]
    pub request_sha256: Hash,
    #[serde_as(as = "Hex")]
    pub response_sha256: Hash,
    /// The provider's signature over the call, where it signs one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<LlmSignature>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LlmSignature {
    pub algo: String,
    pub address: String,
    pub value: String,
}

/// Same JSON as `extents_objective::Verdict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Achieved,
    Failed,
}

impl Review {
    /// Parses a document in normal form and validates it against `spec`.
    pub fn from_json(bytes: &[u8], spec: &Spec) -> Result<Self> {
        let review: Self = crate::from_json(bytes)?;
        review.validate(spec)?;
        Ok(review)
    }

    /// The value for `Attestation::review_hash`.
    pub fn hash(&self) -> Result<Hash> {
        crate::hash(self)
    }

    /// Checks the review against the spec it claims to judge, each judged
    /// outcome against its models' answers, and the verdict against the
    /// results: `achieved` only when every criterion passed, `failed` only
    /// when one failed. Skipped with nothing failed supports neither.
    pub fn validate(&self, spec: &Spec) -> Result<()> {
        check_version(self.v)?;
        if self.spec_hash != spec.hash()? {
            return Err(Error::SpecMismatch);
        }
        if spec.evaluator_build.is_some() && self.evaluator_build != spec.evaluator_build {
            return Err(Error::EvaluatorBuildMismatch);
        }

        let mut contributors = BTreeSet::new();
        for d in &self.deliverables {
            if !contributors.insert(&d.contributor) {
                return Err(Error::DuplicateContributor(d.contributor.to_string()));
            }
        }
        for m in &self.missing {
            if !contributors.insert(m) {
                return Err(Error::InvalidMissing(m.to_string()));
            }
        }

        let mut outcomes = BTreeMap::new();
        for r in &self.results {
            let criterion = spec
                .criterion(&r.criterion_id)
                .ok_or_else(|| Error::UnknownCriterion(r.criterion_id.clone()))?;
            if outcomes
                .insert(r.criterion_id.as_str(), r.outcome)
                .is_some()
            {
                return Err(Error::DuplicateResult(r.criterion_id.clone()));
            }
            for e in &r.evidence {
                if !(e.url.starts_with("https://") || e.url.starts_with("http://")) {
                    return Err(Error::InvalidEvidence(e.url.clone()));
                }
                if let Some(f) = &e.final_url
                    && !(f.starts_with("https://") || f.starts_with("http://"))
                {
                    return Err(Error::InvalidEvidence(f.clone()));
                }
            }
            let fetches = matches!(
                criterion.check,
                Check::LiveUrl { .. } | Check::Sources { .. } | Check::Media { .. }
            );
            // a pass shows what it fetched; a fail may have found nothing to
            // fetch, and its detail says why
            if fetches && r.outcome == Outcome::Pass && r.evidence.is_empty() {
                return Err(Error::MissingEvidence(r.criterion_id.clone()));
            }
        }
        if let Some(missing) = spec
            .criteria
            .iter()
            .find(|c| !outcomes.contains_key(c.id.as_str()))
        {
            return Err(Error::MissingResult(missing.id.clone()));
        }

        self.validate_calls(spec, &outcomes)?;

        let unjudged = !self.missing.is_empty();
        let failed = unjudged || outcomes.values().any(|o| *o == Outcome::Fail);
        let passed = outcomes.values().all(|o| *o == Outcome::Pass);
        match self.verdict {
            Verdict::Achieved if unjudged => Err(Error::VerdictMismatch {
                verdict: "achieved",
                reason: "a contributor's report is missing",
            }),
            Verdict::Achieved if !passed => Err(Error::VerdictMismatch {
                verdict: "achieved",
                reason: "not every criterion passed",
            }),
            Verdict::Failed if !failed => Err(Error::VerdictMismatch {
                verdict: "failed",
                reason: "no criterion failed and no report is missing",
            }),
            _ => Ok(()),
        }
    }

    /// Every call judged an `llm_judge` criterion with one of its models,
    /// once per model; a judged outcome has every model's answer and
    /// follows their majority. A skipped one may have some. A fail may also
    /// have none: no model is asked about a report over `max_report_bytes`.
    /// It can only fail work that way, never pass it.
    fn validate_calls(&self, spec: &Spec, outcomes: &BTreeMap<&str, Outcome>) -> Result<()> {
        let mut answers: BTreeMap<&str, BTreeMap<&str, bool>> = BTreeMap::new();
        for call in &self.llm_calls {
            let invalid = |reason| Error::InvalidCall {
                id: call.criterion_id.clone(),
                reason,
            };
            let Some(Check::LlmJudge { models, .. }) =
                spec.criterion(&call.criterion_id).map(|c| &c.check)
            else {
                return Err(invalid("not an llm_judge criterion"));
            };
            if !models.contains(&call.model) {
                return Err(invalid("a model the spec does not name"));
            }
            if answers
                .entry(&call.criterion_id)
                .or_default()
                .insert(&call.model, call.answer)
                .is_some()
            {
                return Err(invalid("two calls to one model"));
            }
        }
        for criterion in &spec.criteria {
            let Check::LlmJudge { models, .. } = &criterion.check else {
                continue;
            };
            let id = criterion.id.as_str();
            let judged = match outcomes.get(id) {
                Some(Outcome::Pass) => true,
                Some(Outcome::Fail) => false,
                _ => continue,
            };
            if !judged && !answers.contains_key(id) {
                continue;
            }
            let Some(by_model) = answers.get(id).filter(|a| a.len() == models.len()) else {
                return Err(Error::InvalidCall {
                    id: id.to_owned(),
                    reason: "a judged outcome needs every model's answer",
                });
            };
            let yes = by_model.values().filter(|a| **a).count();
            if (yes * 2 > models.len()) != judged {
                return Err(Error::JudgeMismatch(id.to_owned()));
            }
        }
        Ok(())
    }
}
