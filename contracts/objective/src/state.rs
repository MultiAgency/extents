use std::{collections::BTreeMap, fmt, str::FromStr};

use borsh::{BorshDeserialize, BorshSerialize};
use defuse_borsh_utils::As as BorshAs;
use defuse_fees::Pips;
use defuse_time::{Timestamp, borsh::TimestampNanoSeconds as BorshTimestampNanoSeconds};
use defuse_token_id::{TokenId, nep245::Nep245TokenId};
use near_sdk::{AccountId, AccountIdRef, CryptoHash, borsh, env};
use serde::{Deserialize, Serialize};
use serde_with::{DeserializeFromStr, DisplayFromStr, SerializeDisplay, hex::Hex, serde_as};

use crate::{Error, Result};

#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema, ::borsh::BorshSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct ContractStorage(
    /// `None` once the objective is settled and the account is being deleted
    pub(crate) Option<Storage>,
);

impl ContractStorage {
    pub(crate) const STATE_KEY: &[u8] = b"";

    #[inline]
    pub fn init(params: &Params) -> Result<Self> {
        Storage::new(params).map(Some).map(Self)
    }

    /// Initial `data` for the NEP-616 `StateInit` that deploys an instance.
    pub fn init_state(params: &Params) -> Result<BTreeMap<Vec<u8>, Vec<u8>>> {
        let state = Self::init(params)?;
        Ok([(
            Self::STATE_KEY.to_vec(),
            borsh::to_vec(&state).map_err(Error::Borsh)?,
        )]
        .into())
    }
}

/// Only the hash of [`Params`] is stored, which keeps every instance within
/// the zero-balance-account limit. Callers pass `Params` in full and the
/// contract checks them against the hash.
#[serde_as]
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema, ::borsh::BorshSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Storage {
    #[serde_as(as = "Hex")]
    params_hash: CryptoHash,

    #[serde(flatten)]
    state: State,
}

impl Storage {
    pub fn new(params: &Params) -> Result<Self> {
        params.validate()?;

        Ok(Self {
            params_hash: params.hash(),
            state: State {
                funded: 0,
                committed: 0,
                delivered: 0,
                taken: 0,
                outcome: None,
                owed: BTreeMap::new(),
                deadline: params.deadline,
                in_flight: 0,
            },
        })
    }

    #[inline]
    pub const fn no_verify(&self) -> &State {
        &self.state
    }

    #[inline]
    pub const fn no_verify_mut(&mut self) -> &mut State {
        &mut self.state
    }

    #[inline]
    pub fn verify(&self, params: &Params) -> Result<&State> {
        if self.params_hash != params.hash() {
            return Err(Error::InvalidData);
        }
        Ok(&self.state)
    }

    #[inline]
    pub fn verify_mut(&mut self, params: &Params) -> Result<&mut State> {
        self.verify(params)?;
        Ok(&mut self.state)
    }
}

#[serde_as]
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema, ::borsh::BorshSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct Params {
    /// The only account allowed to fund the objective, and the recipient of
    /// everything not paid out to contributors.
    pub sponsor: AccountId,

    /// The resource, as a NEP-245 balance on the Verifier, e.g.
    /// `nep245:intents.near:nep141:usdt.tether-token.near`.
    pub token: TokenId,

    /// The authority whose verdict releases or returns the resources.
    pub evaluator: AccountId,

    /// Contributors and their shares of the payout. Shares must sum to
    /// exactly 100%. Each must commit before an achieved verdict.
    pub contributors: BTreeMap<AccountId, Pips>,

    /// A backup for some contributors' slots: after `commit_by`, if the
    /// listed contributor has not committed, its backup may commit instead
    /// and takes the slot (share, delivery and payout). Whoever commits first
    /// holds the slot; a committed slot never changes hands.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub backups: BTreeMap<AccountId, AccountId>,

    /// Last moment to fund, commit and deliver, and, unless an acceptance
    /// window extends it, to attest. After it, anyone can close the
    /// objective.
    #[borsh(
        serialize_with = "BorshAs::<BorshTimestampNanoSeconds<i64>>::serialize",
        deserialize_with = "BorshAs::<BorshTimestampNanoSeconds<i64>>::deserialize"
    )]
    #[cfg_attr(
        feature = "abi",
        borsh(schema(with_funcs(
            declaration = "i64::declaration",
            definitions = "i64::add_definitions_recursively",
        )))
    )]
    pub deadline: Timestamp,

    /// From when a backup may take an uncommitted slot. Required with
    /// backups, and before the deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[borsh(
        serialize_with = "BorshAs::<Option<BorshTimestampNanoSeconds<i64>>>::serialize",
        deserialize_with = "BorshAs::<Option<BorshTimestampNanoSeconds<i64>>>::deserialize"
    )]
    #[cfg_attr(
        feature = "abi",
        borsh(schema(with_funcs(
            declaration = "Option::<i64>::declaration",
            definitions = "Option::<i64>::add_definitions_recursively",
        )))
    )]
    pub commit_by: Option<Timestamp>,

    /// What silence means once every contributor has delivered.
    ///
    /// * `None`: nothing. Without a verdict by the deadline, the objective
    ///   expires and everything returns to the sponsor.
    /// * `Some(secs)`: the evaluator has until the later of the deadline and
    ///   `secs` after the last delivery to attest. Without a verdict by then,
    ///   the objective resolves as [`Outcome::Accepted`] and pays the
    ///   contributors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance_window_secs: Option<u32>,

    /// Commitment to the off-chain statement of the objective that the
    /// evaluator judges against. Not interpreted on-chain.
    #[serde_as(as = "Hex")]
    pub spec_hash: CryptoHash,

    /// Contract allowed to forward `on_auth()`, i.e. the Verifier, so the
    /// evaluator can attest with a signed intent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_caller: Option<AccountId>,

    /// Entropy for address derivation.
    #[serde_as(as = "Hex")]
    pub salt: [u8; 32],
}

const _: () = assert!(
    Params::MAX_CONTRIBUTORS <= 16,
    "every contributor needs a bit in State::committed"
);

impl Params {
    /// Bounded so that a worst-case `owed` map fits the zero-balance-account
    /// limit and one settlement fits in a single transaction's gas.
    pub const MAX_CONTRIBUTORS: usize = 10;

    #[inline]
    pub fn hash(&self) -> CryptoHash {
        env::keccak256_array(borsh::to_vec(self).unwrap_or_else(|_| unreachable!()))
    }

    pub fn validate(&self) -> Result<()> {
        let token = self.nep245_token()?;
        // `on_auth` trusts the signer its caller names, so only the Verifier,
        // which checks signatures, may be that caller.
        if self
            .auth_caller
            .as_ref()
            .is_some_and(|caller| *caller != token.contract_id)
        {
            return Err(Error::InvalidAuthCaller);
        }
        if self.acceptance_window_secs == Some(0) {
            return Err(Error::InvalidAcceptanceWindow);
        }
        self.validate_contributors()?;
        self.validate_backups()
    }

    pub const fn nep245_token(&self) -> Result<&Nep245TokenId> {
        match &self.token {
            TokenId::Nep245(token) => Ok(token),
            _ => Err(Error::WrongToken),
        }
    }

    fn validate_contributors(&self) -> Result<()> {
        if !(1..=Self::MAX_CONTRIBUTORS).contains(&self.contributors.len())
            || self.contributors.values().any(Pips::is_zero)
            || self
                .contributors
                .values()
                .copied()
                .try_fold(Pips::ZERO, Pips::checked_add)
                != Some(Pips::MAX)
        {
            return Err(Error::InvalidShares);
        }
        // An evaluator cannot judge work it is paid for.
        if self.contributors.contains_key(&self.evaluator) {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    fn validate_backups(&self) -> Result<()> {
        let timed = self.commit_by.map_or(self.backups.is_empty(), |commit_by| {
            !self.backups.is_empty() && commit_by < self.deadline
        });
        let mut seen = std::collections::BTreeSet::new();
        let distinct = self.backups.iter().all(|(contributor, backup)| {
            self.contributors.contains_key(contributor)
                && !self.contributors.contains_key(backup)
                && seen.insert(backup)
        });
        if !timed || !distinct {
            return Err(Error::InvalidBackups);
        }
        // Like a contributor, a backup cannot be the evaluator.
        if self.backups.values().any(|b| *b == self.evaluator) {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    /// The slot `account` can act for, as its listed contributor or as its
    /// backup, with its bit in [`State::committed`].
    pub fn slot_of(&self, account: &AccountIdRef) -> Option<Slot> {
        if let Some(bit) = self.contributor_bit(account) {
            return Some(Slot { bit, backup: false });
        }
        let (contributor, _) = self.backups.iter().find(|(_, b)| *b == account)?;
        self.contributor_bit(contributor)
            .map(|bit| Slot { bit, backup: true })
    }

    /// Splits `amount` by contributor shares, rounding down. The remainder
    /// is owed to the sponsor.
    pub fn split(&self, amount: u128) -> Vec<(Recipient, u128)> {
        let mut allocation: Vec<_> = (0u8..)
            .zip(self.contributors.values())
            .map(|(idx, share)| (Recipient::Contributor(idx), share.fee(amount)))
            .collect();
        let paid: u128 = allocation.iter().map(|(_, a)| a).sum();
        allocation.push((Recipient::Sponsor, amount - paid));
        allocation
    }

    /// The contributor's bit in [`State::committed`] and [`State::delivered`].
    pub fn contributor_bit(&self, contributor: &AccountIdRef) -> Option<u16> {
        self.contributors
            .keys()
            .position(|c| c == contributor)
            .map(|idx| 1 << idx)
    }

    /// [`State::committed`] or [`State::delivered`] once every contributor
    /// has committed or delivered.
    pub fn all_contributors(&self) -> u16 {
        (0..self.contributors.len()).fold(0, |bits, idx| bits | 1 << idx)
    }

    /// The account paid as `recipient`: a contributor's slot goes to its
    /// backup if the backup holds it (bit set in `taken`).
    pub fn holder_id(&self, recipient: Recipient, taken: u16) -> Result<&AccountIdRef> {
        let id = match recipient {
            Recipient::Sponsor => return Ok(&self.sponsor),
            Recipient::Contributor(idx) => self
                .contributors
                .keys()
                .nth(idx.into())
                .map(AsRef::as_ref)
                .ok_or(Error::InvalidData)?,
        };
        match recipient {
            Recipient::Contributor(idx) if taken & (1 << idx) != 0 => self
                .backups
                .get(id)
                .map(AsRef::as_ref)
                .ok_or(Error::InvalidData),
            _ => Ok(id),
        }
    }
}

/// A contributor slot an account can act for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    pub bit: u16,
    /// Acting as the slot's backup rather than its listed contributor.
    pub backup: bool,
}

/// A payee, stored by position so that `owed` stays small whatever the
/// length of account ids. In JSON: `"sponsor"` or `"contributor:<index>"`.
#[cfg_attr(
    feature = "abi",
    derive(::schemars::JsonSchema, ::borsh::BorshSchema),
    schemars(with = "String")
)]
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    SerializeDisplay,
    DeserializeFromStr,
    BorshSerialize,
    BorshDeserialize,
)]
pub enum Recipient {
    Sponsor,
    /// Index into `Params::contributors` in key order.
    Contributor(u8),
}

impl Recipient {
    const SPONSOR: &str = "sponsor";
    const CONTRIBUTOR: &str = "contributor:";
}

impl fmt::Display for Recipient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sponsor => f.write_str(Self::SPONSOR),
            Self::Contributor(idx) => write!(f, "{}{idx}", Self::CONTRIBUTOR),
        }
    }
}

impl FromStr for Recipient {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self> {
        if s == Self::SPONSOR {
            return Ok(Self::Sponsor);
        }
        s.strip_prefix(Self::CONTRIBUTOR)
            .and_then(|idx| idx.parse().ok())
            .map(Self::Contributor)
            .ok_or(Error::InvalidData)
    }
}

#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema, ::borsh::BorshSchema))]
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Achieved,
    Failed,
}

/// A contributor's delivery, by the hash of what was delivered. The
/// deliverable itself stays off chain.
#[serde_as]
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delivery {
    #[serde_as(as = "Hex")]
    pub hash: CryptoHash,
}

/// The evaluator's judgement, optionally with a commitment to a written
/// review explaining it.
#[serde_as]
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attestation {
    pub verdict: Verdict,
    #[serde_as(as = "Option<Hex>")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_hash: Option<CryptoHash>,
}

impl From<Verdict> for Attestation {
    fn from(verdict: Verdict) -> Self {
        Self {
            verdict,
            review_hash: None,
        }
    }
}

#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema, ::borsh::BorshSchema))]
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Achieved,
    Failed,
    /// The deadline passed without a verdict.
    Expired,
    /// Every contributor delivered, and the acceptance window passed
    /// without a verdict.
    Accepted,
}

impl From<Verdict> for Outcome {
    fn from(verdict: Verdict) -> Self {
        match verdict {
            Verdict::Achieved => Self::Achieved,
            Verdict::Failed => Self::Failed,
        }
    }
}

#[serde_as]
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema, ::borsh::BorshSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct State {
    /// Balance received from the sponsor and not yet allocated.
    #[serde_as(as = "DisplayFromStr")]
    pub funded: u128,

    /// Bit `i` is set once the `i`-th contributor, in key order, committed.
    #[serde(default, skip_serializing_if = "is_default")]
    pub committed: u16,

    /// Bit `i` is set once the `i`-th contributor, in key order, delivered.
    #[serde(default, skip_serializing_if = "is_default")]
    pub delivered: u16,

    /// Bit `i` is set once the `i`-th contributor's backup took the slot.
    #[serde(default, skip_serializing_if = "is_default")]
    pub taken: u16,

    /// Set once, by verdict or expiry. Allocation happens at the same time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,

    /// Allocated and not yet sent, including amounts returned by failed
    /// transfers, which `ob_close()` retries.
    #[serde_as(as = "BTreeMap<_, DisplayFromStr>")]
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub owed: BTreeMap<Recipient, u128>,

    /// Last moment to attest: `Params::deadline`, extended by the
    /// acceptance window once every contributor has delivered.
    #[borsh(
        serialize_with = "BorshAs::<BorshTimestampNanoSeconds<i64>>::serialize",
        deserialize_with = "BorshAs::<BorshTimestampNanoSeconds<i64>>::deserialize"
    )]
    #[cfg_attr(
        feature = "abi",
        borsh(schema(with_funcs(
            declaration = "i64::declaration",
            definitions = "i64::add_definitions_recursively",
        )))
    )]
    pub deadline: Timestamp,

    #[serde(default, skip_serializing_if = "is_default")]
    pub in_flight: u32,
}

fn is_default<T: Default + PartialEq>(v: &T) -> bool {
    *v == T::default()
}
