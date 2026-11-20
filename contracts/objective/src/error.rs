use near_sdk::{FunctionError, borsh::io, serde_json};
use thiserror::Error as ThisError;

pub type Result<T, E = Error> = ::core::result::Result<T, E>;

#[derive(Debug, ThisError, FunctionError)]
pub enum Error {
    #[error("already committed")]
    AlreadyCommitted,
    #[error("already delivered")]
    AlreadyDelivered,
    #[error("already resolved")]
    AlreadyResolved,
    #[error("borsh: {0}")]
    Borsh(io::Error),
    #[error("cleanup in progress")]
    CleanupInProgress,
    #[error("deadline has expired")]
    DeadlineExpired,
    #[error("deadline has not expired yet")]
    DeadlineNotExpired,
    #[error("insufficient amount")]
    InsufficientAmount,
    #[error("acceptance window must be at least one second")]
    InvalidAcceptanceWindow,
    #[error(
        "backups need a commit_by before the deadline, each for a listed contributor and distinct from every contributor and other backup"
    )]
    InvalidBackups,
    #[error("this account is not the one its Params and immutable code derive")]
    NotDerived,
    #[error("deadline and commit_by must be between 1677 and 2262 (i64 nanoseconds)")]
    InvalidTimestamp,
    #[error("auth_caller must be the Verifier that holds the token")]
    InvalidAuthCaller,
    #[error("a backup can take a slot only after commit_by")]
    BackupTooEarly,
    #[error("integer overflow")]
    IntegerOverflow,
    #[error("invalid data")]
    InvalidData,
    #[error("invalid shares: contributors must be 1..={max} with shares summing to 100%", max = crate::Params::MAX_CONTRIBUTORS)]
    InvalidShares,
    #[error("JSON: {0}")]
    JSON(#[from] serde_json::Error),
    #[error("not all contributors have committed")]
    NotCommitted,
    #[error("commit before delivering")]
    NotCommittedYet,
    #[error("unauthorized")]
    Unauthorized,
    #[error("wrong token")]
    WrongToken,
}
