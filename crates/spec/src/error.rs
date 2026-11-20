use thiserror::Error as ThisError;

pub type Result<T, E = Error> = core::result::Result<T, E>;

#[derive(Debug, ThisError)]
pub enum Error {
    #[error("JSON: {0}")]
    Json(serde_json::Error),
    #[error("not in normal form: an unknown field, or null where a field should be left out")]
    NotNormalForm,
    #[error("unsupported version {0}")]
    Version(u32),
    #[error("{0} is empty")]
    Empty(&'static str),

    #[error("no criteria")]
    NoCriteria,
    #[error("more than {max} criteria")]
    TooManyCriteria { max: usize },
    #[error("more than {max} llm_judge criteria")]
    TooManyJudges { max: usize },
    #[error("a spec with an llm_judge needs a positive max_report_bytes")]
    NoReportLimit,
    #[error("every criterion is llm_judge: at least one must be checked by a script")]
    NoScriptCheck,
    #[error("criterion id {0:?} is not 1 to 32 of a-z, 0-9, '-' or '_'")]
    InvalidId(String),
    #[error("criterion id {0:?} appears twice")]
    DuplicateId(String),
    #[error("criterion {id}: {reason}")]
    InvalidCheck { id: String, reason: String },

    #[error("spec_hash does not match the spec")]
    SpecMismatch,
    #[error("no result for criterion {0}")]
    MissingResult(String),
    #[error("result for criterion {0}, which the spec does not have")]
    UnknownCriterion(String),
    #[error("two results for criterion {0}")]
    DuplicateResult(String),
    #[error("criterion {0} passed by fetching, but its result has no evidence")]
    MissingEvidence(String),
    #[error("evidence url {0:?} is not http(s)")]
    InvalidEvidence(String),
    #[error("llm call for criterion {id}: {reason}")]
    InvalidCall { id: String, reason: &'static str },
    #[error("criterion {0}: its outcome is not the majority of its models' answers")]
    JudgeMismatch(String),
    #[error("evaluator_build does not match the spec's")]
    EvaluatorBuildMismatch,
    #[error("{0} is listed as missing and as delivered, or missing twice")]
    InvalidMissing(String),
    #[error("two deliverables from {0}")]
    DuplicateContributor(String),
    #[error("verdict {verdict} contradicts the results: {reason}")]
    VerdictMismatch {
        verdict: &'static str,
        reason: &'static str,
    },
}
