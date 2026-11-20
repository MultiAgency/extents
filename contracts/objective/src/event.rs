use std::{borrow::Cow, collections::BTreeMap};

use near_sdk::{AccountIdRef, CryptoHash, near};
use serde::{Deserialize, Serialize};
use serde_with::{DisplayFromStr, hex::Hex, serde_as};

use crate::{Error, Outcome, Params, Result, Timestamp};

#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[near(event_json(standard = "extents-objective"))]
#[derive(Debug, Clone)]
pub enum Event<'a> {
    #[event_version("0.1.0")]
    Funded(Box<FundedEvent<'a>>),

    #[event_version("0.1.0")]
    Committed(CommittedEvent<'a>),

    /// The slot's holder gave it back; it is empty again.
    #[event_version("0.1.0")]
    Withdrawn(CommittedEvent<'a>),

    #[event_version("0.1.0")]
    Delivered(DeliveredEvent<'a>),

    #[event_version("0.1.0")]
    Resolved(ResolvedEvent<'a>),

    #[event_version("0.1.0")]
    Paid(Payouts<'a>),

    /// Transfers that failed; the amounts are back in `owed`.
    #[event_version("0.1.0")]
    Lost(Payouts<'a>),

    #[event_version("0.1.0")]
    Cleanup,
}

#[serde_as]
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FundedEvent<'a> {
    pub params: Cow<'a, Params>,

    #[serde_as(as = "DisplayFromStr")]
    pub added: u128,
    #[serde_as(as = "DisplayFromStr")]
    pub funded: u128,
}

#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommittedEvent<'a> {
    pub contributor: Cow<'a, AccountIdRef>,
}

#[serde_as]
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveredEvent<'a> {
    pub contributor: Cow<'a, AccountIdRef>,
    #[serde_as(as = "Hex")]
    pub hash: CryptoHash,
    /// Last moment to attest, after this delivery.
    pub attest_by: Timestamp,
}

#[serde_as]
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedEvent<'a> {
    pub outcome: Outcome,
    /// The evaluator's written review, if one was attached to the verdict.
    #[serde_as(as = "Option<Hex>")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_hash: Option<CryptoHash>,
    #[serde(flatten)]
    pub allocated: Payouts<'a>,
}

#[serde_as]
#[cfg_attr(feature = "abi", derive(::schemars::JsonSchema))]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Payouts<'a> {
    #[serde_as(as = "BTreeMap<_, DisplayFromStr>")]
    pub amounts: BTreeMap<Cow<'a, AccountIdRef>, u128>,
}

impl<'a> Payouts<'a> {
    /// Adds `amount` for `account`. One account can be owed under several
    /// recipients (the sponsor holding a slot gets its share and the
    /// remainder), and is reported their sum.
    pub fn add(&mut self, account: Cow<'a, AccountIdRef>, amount: u128) -> Result<()> {
        let total = self.amounts.entry(account).or_default();
        *total = total.checked_add(amount).ok_or(Error::IntegerOverflow)?;
        Ok(())
    }
}
