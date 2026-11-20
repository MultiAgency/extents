use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_with::{hex::Hex, serde_as};

use crate::{Error, Hash, Result, check_version, non_empty};

/// What an objective asks for, and how its achievement is checked.
///
/// Write it before anyone commits: contributors see `spec_hash` in `Params`
/// and agree to be judged against exactly these criteria.
#[serde_as]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Spec {
    pub v: u32,
    /// The objective in words.
    pub statement: String,
    pub criteria: Vec<Criterion>,
    /// The most UTF-8 bytes one contributor's report may have. Required when
    /// any criterion is an `llm_judge`, whose model can read only so much; a
    /// longer report fails, as contributors agreed by committing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_report_bytes: Option<u32>,
    /// SHA-256 of the evaluator program, for an attested evaluator. A review
    /// of this spec must record the same build.
    #[serde_as(as = "Option<Hex>")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluator_build: Option<Hash>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Criterion {
    /// Referenced by [`crate::CriterionResult::criterion_id`].
    pub id: String,
    /// What the criterion checks, for people.
    pub description: String,
    pub check: Check,
}

/// How a criterion is checked. Every kind but [`Check::LlmJudge`] is meant
/// to be checked by a script, so anyone can repeat the check. A spec has at
/// least one such criterion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Check {
    /// The deliverable contains `phrase`, ignoring case. With `absent`, it
    /// must not. A plain phrase, never a pattern: regular expression
    /// dialects differ between languages.
    Contains { phrase: String, absent: bool },
    /// The deliverable, or a fenced JSON block in it, is valid against this
    /// JSON Schema (draft 2020-12).
    Schema { json_schema: serde_json::Value },
    /// The number on a `<label>: <value>` line is within the bounds. Bounds
    /// are sanity ranges known without the data, never a guess of the
    /// answer.
    NumericMatch {
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
    },
    /// Each path is delivered as a whole, non-empty file.
    Files { paths: Vec<String> },
    /// The deliverable has a `<label>: <url>` line, and the page loads,
    /// showing `must_contain` if set.
    LiveUrl {
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        must_contain: Option<String>,
    },
    /// At least `min` cited links load as public pages. With `figures`,
    /// every `numeric_match` figure appears on a cited page.
    Sources { min: u32, figures: bool },
    /// At least `min` delivered items load as one of `kinds`.
    Media { kinds: Vec<MediaKind>, min: u32 },
    /// Each of `models` answers `question` about the deliverable, with the
    /// request [`crate::judge_request`] builds; the majority answer is the
    /// outcome. One model or three. For qualities a script cannot check; at
    /// most [`Spec::MAX_JUDGES`] per spec.
    LlmJudge {
        question: String,
        models: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Video,
    Audio,
}

impl Spec {
    pub const MAX_CRITERIA: usize = 32;
    pub const MAX_JUDGES: usize = 2;
    pub const MAX_FILES: usize = 60;

    /// Parses a document in normal form and validates it.
    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        let spec: Self = crate::from_json(bytes)?;
        spec.validate()?;
        Ok(spec)
    }

    /// The value for `Params::spec_hash`.
    pub fn hash(&self) -> Result<Hash> {
        crate::hash(self)
    }

    pub fn validate(&self) -> Result<()> {
        check_version(self.v)?;
        non_empty("statement", &self.statement)?;
        if self.criteria.is_empty() {
            return Err(Error::NoCriteria);
        }
        if self.criteria.len() > Self::MAX_CRITERIA {
            return Err(Error::TooManyCriteria {
                max: Self::MAX_CRITERIA,
            });
        }
        let judges = self
            .criteria
            .iter()
            .filter(|c| matches!(c.check, Check::LlmJudge { .. }))
            .count();
        if judges > Self::MAX_JUDGES {
            return Err(Error::TooManyJudges {
                max: Self::MAX_JUDGES,
            });
        }
        // a model's answer is never the only gate: every criterion must pass
        // for `achieved`, so one checked by a script always stands with it
        if judges == self.criteria.len() {
            return Err(Error::NoScriptCheck);
        }
        let mut ids = BTreeSet::new();
        for criterion in &self.criteria {
            if !ids.insert(criterion.id.as_str()) {
                return Err(Error::DuplicateId(criterion.id.clone()));
            }
            criterion.validate()?;
        }
        match self.max_report_bytes {
            Some(0) => Err(Error::NoReportLimit),
            None if judges > 0 => Err(Error::NoReportLimit),
            _ => Ok(()),
        }
    }

    pub fn criterion(&self, id: &str) -> Option<&Criterion> {
        self.criteria.iter().find(|c| c.id == id)
    }
}

impl Criterion {
    fn validate(&self) -> Result<()> {
        let valid_id = (1..=32).contains(&self.id.len())
            && self
                .id
                .bytes()
                .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'));
        if !valid_id {
            return Err(Error::InvalidId(self.id.clone()));
        }
        non_empty("description", &self.description)?;
        self.check.validate().map_err(|reason| Error::InvalidCheck {
            id: self.id.clone(),
            reason,
        })
    }
}

impl Check {
    fn validate(&self) -> Result<(), String> {
        fn text(field: &str, value: &str) -> Result<(), String> {
            if value.trim().is_empty() {
                Err(format!("{field} is empty"))
            } else {
                Ok(())
            }
        }

        match self {
            Self::Contains { phrase, .. } => text("phrase", phrase),
            Self::Schema { json_schema } => {
                if !json_schema.is_object() {
                    return Err("json_schema is not an object".into());
                }
                jsonschema::draft202012::new(json_schema)
                    .map(drop)
                    .map_err(|e| format!("json_schema does not compile: {e}"))
            }
            Self::NumericMatch { label, min, max } => {
                text("label", label)?;
                match (min, max) {
                    (None, None) => Err("neither min nor max is set".into()),
                    (Some(min), Some(max)) if min > max => Err("min is above max".into()),
                    _ => Ok(()),
                }
            }
            Self::Files { paths } => {
                if !(1..=Spec::MAX_FILES).contains(&paths.len()) {
                    return Err(format!("needs 1 to {} paths", Spec::MAX_FILES));
                }
                let mut seen = BTreeSet::new();
                for path in paths {
                    let relative = !path.is_empty()
                        && !path.starts_with('/')
                        && !path.contains('\\')
                        && path
                            .split('/')
                            .all(|s| !s.is_empty() && s != "." && s != "..");
                    if !relative {
                        return Err(format!("{path:?} is not a relative path"));
                    }
                    if !seen.insert(path) {
                        return Err(format!("{path:?} appears twice"));
                    }
                }
                Ok(())
            }
            Self::LiveUrl {
                label,
                must_contain,
            } => {
                text("label", label)?;
                must_contain
                    .as_deref()
                    .map_or(Ok(()), |m| text("must_contain", m))
            }
            Self::Sources { min, .. } => {
                if *min == 0 {
                    Err("min is 0".into())
                } else {
                    Ok(())
                }
            }
            Self::Media { kinds, min } => {
                if kinds.is_empty() {
                    return Err("kinds is empty".into());
                }
                if kinds.iter().collect::<BTreeSet<_>>().len() != kinds.len() {
                    return Err("kinds repeats a kind".into());
                }
                if *min == 0 {
                    return Err("min is 0".into());
                }
                Ok(())
            }
            Self::LlmJudge { question, models } => {
                text("question", question)?;
                if !matches!(models.len(), 1 | 3) {
                    return Err("needs one model or three".into());
                }
                for model in models {
                    text("model", model)?;
                }
                if models.iter().collect::<BTreeSet<_>>().len() != models.len() {
                    return Err("models repeats a model".into());
                }
                Ok(())
            }
        }
    }
}
