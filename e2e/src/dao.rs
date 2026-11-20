//! A Sputnik DAO that signs NEAR Intents by vote.
//!
//! The DAO acts on the Verifier as the implicit account of an Ed25519 key that
//! the MPC signer derives for it (path `agent-owner`). Only the DAO can ask
//! for a signature with that key: a `FunctionCall` proposal to the signer's
//! `sign`, which runs once the council approves it. No key is delegated to
//! anyone, so every intent the DAO signs is a vote.
//!
//! A vote approves a hash, so each proposal also carries the payload it
//! hashes, in its `intent` argument (the signer ignores it). `verify`
//! recomputes the hash from that payload and checks everything else a voter
//! should know before approving.

use std::{collections::BTreeMap, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use extents_client::{
    Payload,
    objective::{self as client, Call, Vote},
    transfer,
};
use extents_objective::Timestamp;
use near_kit::{
    AccountId, Gas, NearToken,
    signer::{PublicKey, Signature},
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    Config,
    accounts::Accounts,
    chain::{Chain, Tx},
    report,
    scenarios::{Balances, Check, Run, Step},
};

/// The Sputnik DAO v2 factory on testnet.
const FACTORY: &str = "sputnikv2.testnet";
/// NEAR's MPC signer (chain signatures) on testnet; `v1.signer` on mainnet.
pub const MPC_SIGNER: &str = "v1.signer-prod.testnet";
/// The derivation path of the DAO's account: the one the `multiagency`
/// platform uses for a DAO's owner account, so both name the same account.
pub const PATH: &str = "agent-owner";
const ED25519_DOMAIN: u64 = 1;

/// The testnet factory deploys the DAO's code to its account, so the DAO
/// must cover that storage: the factory asks for at least 5.3968 NEAR.
const CREATE_DEPOSIT: NearToken = NearToken::from_millinear(5_500);
const PROPOSAL_BOND: NearToken = NearToken::from_millinear(100);
const SIGN_GAS: Gas = Gas::from_tgas(100);
const MAX_GAS: Gas = Gas::from_tgas(300);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Time to relay a signed intent after the vote that signs it.
const RELAY_MARGIN: Duration = Duration::from_mins(10);
const PROPOSAL_PERIOD: Duration = Duration::from_hours(24 * 7);

#[derive(clap::Subcommand)]
pub enum Command {
    /// Create the DAO (`<prefix>-agency.sputnikv2.testnet`), with `c0` and
    /// `c1` as its council. Skipped if it exists.
    Create,
    /// Print the DAO, its derived account and that account's Verifier balance.
    Show,
    /// Send `amount` of the token from the sponsor to the DAO's account on
    /// the Verifier.
    Fund { amount: u128 },
    /// Have the DAO sign, by vote, an intent that transfers `amount` from its
    /// account back to the sponsor, and execute it.
    Transfer { amount: u128 },
    /// Check what a sign proposal would sign, as a voter would before
    /// approving.
    Verify { id: u64 },
    /// Print the `intent` and `hash` to enter in the Trezu template, for
    /// `intents` (a JSON array) signed by the DAO's account.
    Prepare { intents: String },
}

pub struct Dao<'a> {
    chain: &'a Chain,
    accounts: &'a Accounts,
    pub id: AccountId,
    council: [AccountId; 2],
}

/// The DAO's account on the Verifier.
pub struct Derived {
    pub public_key: String,
    pub account: AccountId,
}

/// What `verify` found, one line per check.
struct Verification {
    checks: Vec<(String, bool)>,
    /// The intents the payload carries, for the voter to read.
    intents: Vec<Value>,
    payload: Option<Payload>,
}

impl Verification {
    fn passed(&self) -> bool {
        self.checks.iter().all(|(_, ok)| *ok)
    }

    fn print(&self) {
        for intent in &self.intents {
            println!("  intent: {intent}");
        }
        for (check, ok) in &self.checks {
            println!("  [{}] {check}", if *ok { "pass" } else { "FAIL" });
        }
    }
}

/// The record `transfer` writes, in the same shape as a scenario's.
#[derive(Serialize)]
struct Record {
    verifier_sha256: &'static str,
    scenario: &'static str,
    objective: Option<AccountId>,
    dao: AccountId,
    sponsor: AccountId,
    derived: AccountId,
    proposal: Option<u64>,
    steps: Vec<Step>,
    checks: Vec<Check>,
}

/// Where the DAO's signing steps and checks are recorded: its own `Record`,
/// or a scenario's `Run`.
pub trait Recorder {
    /// Accounts whose Verifier balances each step snapshots.
    fn tracked(&self) -> Vec<AccountId>;
    fn steps(&mut self) -> &mut Vec<Step>;
    fn checks(&mut self) -> &mut Vec<Check>;

    fn check(&mut self, name: &str, pass: bool, detail: String) {
        println!(
            "  [{}] {name}: {detail}",
            if pass { "pass" } else { "FAIL" }
        );
        self.checks().push(Check {
            name: name.into(),
            pass,
            detail,
        });
    }
}

impl Recorder for Record {
    fn tracked(&self) -> Vec<AccountId> {
        vec![self.sponsor.clone(), self.derived.clone()]
    }

    fn steps(&mut self) -> &mut Vec<Step> {
        &mut self.steps
    }

    fn checks(&mut self) -> &mut Vec<Check> {
        &mut self.checks
    }
}

impl Recorder for Run {
    /// The accounts the scenario already tracks.
    fn tracked(&self) -> Vec<AccountId> {
        self.steps
            .last()
            .map(|s| s.after.mt.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn steps(&mut self) -> &mut Vec<Step> {
        &mut self.steps
    }

    fn checks(&mut self) -> &mut Vec<Check> {
        &mut self.checks
    }
}

impl<'a> Dao<'a> {
    pub fn new(chain: &'a Chain, accounts: &'a Accounts, config: &Config) -> Result<Self> {
        Ok(Self {
            chain,
            accounts,
            id: format!("{}-agency.{FACTORY}", config.prefix).parse()?,
            council: [
                accounts.contributors[0].clone(),
                accounts.contributors[1].clone(),
            ],
        })
    }

    pub async fn run(&self, command: Command, config: &Config) -> Result<()> {
        match command {
            Command::Create => self.create().await,
            Command::Show => self.show().await,
            Command::Fund { amount } => self.fund(amount).await,
            Command::Transfer { amount } => self.transfer(amount, config).await,
            Command::Verify { id } => {
                let verification = self.verify(id).await?;
                verification.print();
                ensure!(verification.passed(), "proposal {id} does not verify");
                Ok(())
            }
            Command::Prepare { intents } => {
                let intents: Vec<Value> =
                    serde_json::from_str(&intents).context("intents must be a JSON array")?;
                let payload = self.payload(&intents).await?;
                let args = sign_args(&payload);
                println!("intent: {}", args["intent"].as_str().unwrap_or_default());
                println!(
                    "hash: {}",
                    args["request"]["payload_v2"]["Eddsa"]
                        .as_str()
                        .unwrap_or_default()
                );
                Ok(())
            }
        }
    }

    /// `intents` signed by the DAO's account. The deadline is fixed when the
    /// proposal is filed, so it covers the DAO's whole proposal period, read
    /// from its policy now, plus [`RELAY_MARGIN`].
    pub async fn payload(&self, intents: &[Value]) -> Result<Payload> {
        let salt: String = self
            .chain
            .view(&self.chain.verifier, "current_salt", &json!({}))
            .await?;
        let policy: Value = self.chain.view(&self.id, "get_policy", &json!({})).await?;
        let period = policy["proposal_period"]
            .as_str()
            .and_then(|p| p.parse::<u64>().ok())
            .map(Duration::from_nanos)
            .context("DAO policy has no proposal_period")?;
        Payload::new(
            &self.derived().await?.account,
            &self.chain.verifier,
            &salt,
            self.chain.block_time().await? + period + RELAY_MARGIN,
            intents,
        )
    }

    async fn create(&self) -> Result<()> {
        if self.chain.near_balance(&self.id).await?.is_some() {
            println!("{}: exists", self.id);
            return Ok(());
        }
        let name = self
            .id
            .as_str()
            .strip_suffix(&format!(".{FACTORY}"))
            .context("DAO id is not under the factory")?;
        let dao_args = json!({
            "config": { "name": name, "purpose": "extents e2e: signs NEAR Intents by vote", "metadata": "" },
            "policy": self.policy(),
        });
        let factory: AccountId = FACTORY.parse()?;
        let tx = self
            .chain
            .call(
                "create DAO",
                &self.accounts.parent,
                &Call {
                    receiver: factory,
                    method: "create",
                    args: json!({ "name": name, "args": BASE64.encode(dao_args.to_string()) }),
                    gas: MAX_GAS,
                    deposit: CREATE_DEPOSIT,
                },
            )
            .await?;
        ensure!(
            tx.ok && self.chain.near_balance(&self.id).await?.is_some(),
            "creating {}: {:?}",
            self.id,
            tx.error
        );
        println!("{}: created, tx {}", self.id, tx.hash);
        Ok(())
    }

    /// The default Sputnik policy, with `council` as the voting group (both
    /// must approve: half plus one), a 0.1 NEAR proposal bond and a week to
    /// vote.
    fn policy(&self) -> Value {
        client::council_policy(&self.council, PROPOSAL_BOND, PROPOSAL_PERIOD)
    }

    pub async fn derived(&self) -> Result<Derived> {
        let public_key: String = self
            .chain
            .view(
                &MPC_SIGNER.parse()?,
                "derived_public_key",
                &json!({ "path": PATH, "predecessor": self.id, "domain_id": ED25519_DOMAIN }),
            )
            .await?;
        let key: PublicKey = public_key.parse()?;
        let bytes = key
            .as_ed25519_bytes()
            .context("derived key is not ed25519")?;
        Ok(Derived {
            account: hex::encode(bytes).parse()?,
            public_key,
        })
    }

    async fn show(&self) -> Result<()> {
        let derived = self.derived().await?;
        println!("DAO: {}", self.id);
        println!(
            "council: {}, {} (both must approve)",
            self.council[0], self.council[1]
        );
        println!(
            "derived key: {} (path {PATH} on {MPC_SIGNER})",
            derived.public_key
        );
        println!("derived account: {}", derived.account);
        println!(
            "Verifier balance: {} {}",
            self.chain.mt_balance(&derived.account).await?,
            self.chain.token
        );
        Ok(())
    }

    async fn fund(&self, amount: u128) -> Result<()> {
        let derived = self.derived().await?;
        let tx = self
            .chain
            .call(
                "fund DAO account (mt_transfer)",
                &self.accounts.sponsor,
                &Call {
                    receiver: self.chain.verifier.clone(),
                    method: "mt_transfer",
                    args: json!({ "receiver_id": derived.account, "token_id": self.chain.token, "amount": amount.to_string() }),
                    gas: Gas::from_tgas(30),
                    deposit: ONE_YOCTO,
                },
            )
            .await?;
        ensure!(tx.ok, "funding: {:?}", tx.error);
        println!(
            "{}: {} {}",
            derived.account,
            self.chain.mt_balance(&derived.account).await?,
            self.chain.token
        );
        Ok(())
    }

    async fn balances(&self, accounts: &[AccountId]) -> Result<Balances> {
        let mut mt = BTreeMap::new();
        for account in accounts {
            mt.insert(
                account.clone(),
                self.chain.mt_balance(account).await?.to_string(),
            );
        }
        Ok(Balances {
            mt,
            objective_near_yocto: None,
        })
    }

    async fn step(
        &self,
        record: &mut impl Recorder,
        label: &str,
        signer: &AccountId,
        call: &Call,
    ) -> Result<Tx> {
        let tracked = record.tracked();
        let before = self.balances(&tracked).await?;
        let tx = self.chain.call(label, signer, call).await?;
        let after = self.balances(&tracked).await?;
        record.steps().push(Step {
            tx: tx.clone(),
            before,
            after,
        });
        Ok(tx)
    }

    /// Files a `FunctionCall` proposal for `call`. Returns its id and kind.
    async fn file(
        &self,
        record: &mut impl Recorder,
        call: &Call,
        description: String,
    ) -> Result<(u64, Value)> {
        let kind = call.proposal_kind();
        let filed = self
            .step(
                record,
                &format!("file proposal: {} on {}", call.method, call.receiver),
                &self.council[0],
                &client::add_proposal(&self.id, &description, &kind, PROPOSAL_BOND),
            )
            .await?;
        let id = filed
            .value
            .as_ref()
            .and_then(Value::as_u64)
            .with_context(|| format!("add_proposal returned no id: {:?}", filed.error))?;
        Ok((id, kind))
    }

    /// Every council member approves proposal `id`; the last vote executes
    /// it. Returns that executing transaction.
    async fn approve(&self, record: &mut impl Recorder, id: u64, kind: &Value) -> Result<Tx> {
        let mut executing = None;
        for member in &self.council {
            let tx = self
                .step(
                    record,
                    &format!("vote approve by {member}"),
                    member,
                    &client::vote(&self.id, id, kind, Vote::Approve),
                )
                .await?;
            ensure!(tx.ok, "vote by {member}: {:?}", tx.error);
            executing = Some(tx);
        }
        executing.context("the council is empty")
    }

    /// Has the DAO's own account make `call`, as an agency acts: one
    /// `FunctionCall` proposal that the council approves. Returns the
    /// executing transaction, the last vote's.
    pub async fn execute(
        &self,
        record: &mut impl Recorder,
        call: &Call,
        description: String,
    ) -> Result<Tx> {
        let (id, kind) = self.file(record, call, description).await?;
        println!("  proposal {id}");
        let executing = self.approve(record, id, &kind).await?;
        let status: Value = self
            .chain
            .view(&self.id, "get_proposal", &json!({ "id": id }))
            .await?;
        record.check(
            &format!("proposal {id} ({}) approved", call.method),
            status["status"] == "Approved",
            format!("status {}, tx {}", status["status"], executing.hash),
        );
        Ok(executing)
    }

    /// Signs `payload` by vote: files the proposal, verifies it as a voter
    /// would, has the council approve it, and returns the signed payload
    /// for `execute_intents` with the proposal's id.
    pub async fn sign_by_vote(
        &self,
        record: &mut impl Recorder,
        payload: &Payload,
        description: String,
    ) -> Result<(u64, Value)> {
        let sign = Call {
            receiver: MPC_SIGNER.parse()?,
            method: "sign",
            args: sign_args(payload),
            gas: SIGN_GAS,
            deposit: ONE_YOCTO,
        };
        let (id, kind) = self.file(record, &sign, description).await?;
        println!("  proposal {id}");

        let verification = self.verify(id).await?;
        verification.print();
        record.check(
            "proposal verifies",
            verification.passed() && verification.payload.as_ref() == Some(payload),
            format!("proposal {id}: {} checks", verification.checks.len()),
        );
        if !verification.passed() {
            bail!("proposal {id} does not verify; not voting");
        }

        let executing = self.approve(record, id, &kind).await?;
        let status: Value = self
            .chain
            .view(&self.id, "get_proposal", &json!({ "id": id }))
            .await?;
        record.check(
            "approved by the council",
            status["status"] == "Approved",
            format!("status {}", status["status"]),
        );

        // The MPC signer answers within the executing transaction.
        let derived = self.derived().await?;
        let public_key: PublicKey = derived.public_key.parse()?;
        let hash = payload.hash();
        let signature = executing
            .receipts
            .iter()
            .filter_map(|r| r.value.as_ref())
            .find_map(|v| ed25519_signature(v).filter(|s| s.verify(&hash, &public_key)))
            .context("no valid Ed25519 signature in the executing transaction")?;
        record.check(
            "MPC signature",
            true,
            format!(
                "verifies against {} over the payload's NEP-413 hash {}",
                derived.public_key,
                hex::encode(hash)
            ),
        );
        Ok((
            id,
            payload.signed(&derived.public_key, &signature.to_string()),
        ))
    }

    async fn transfer(&self, amount: u128, config: &Config) -> Result<()> {
        println!("== DaoTransfer");
        let derived = self.derived().await?;
        let mut record = Record {
            verifier_sha256: extents_client::VERIFIER_SHA256,
            scenario: "dao-transfer",
            objective: None,
            dao: self.id.clone(),
            sponsor: self.accounts.sponsor.clone(),
            derived: derived.account.clone(),
            proposal: None,
            steps: Vec::new(),
            checks: Vec::new(),
        };

        let payload = self
            .payload(&[transfer(
                &self.accounts.sponsor,
                &self.chain.token,
                amount,
                None,
            )])
            .await?;
        let description = format!(
            "Sign NEAR Intents for {} (this DAO's account on {}): transfer {amount} {} to {}. \
             Check with `extents-e2e dao verify <id>`.",
            derived.account, self.chain.verifier, self.chain.token, self.accounts.sponsor
        );
        let (id, signed) = self
            .sign_by_vote(&mut record, &payload, description)
            .await?;
        record.proposal = Some(id);

        // Anyone can relay the signed intent.
        let signed = vec![signed];
        let simulated: Result<Value> = self
            .chain
            .view(
                &self.chain.verifier,
                "simulate_intents",
                &json!({ "signed": signed }),
            )
            .await;
        record.check(
            "Verifier accepts the signature",
            simulated.is_ok(),
            simulated.map_or_else(|e| format!("{e:#}"), |_| "simulate_intents ok".into()),
        );
        let before = self.balances(&record.tracked()).await?;
        let executed = self
            .step(
                &mut record,
                "execute_intents (relayed)",
                &self.accounts.deployer,
                &client::execute_intents(&self.chain.verifier, &signed),
            )
            .await?;
        let after = self.balances(&record.tracked()).await?;
        let moved = |account: &AccountId| {
            let read = |b: &Balances| -> u128 {
                b.mt.get(account)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_default()
            };
            (read(&before), read(&after))
        };
        let (dao_before, dao_after) = moved(&derived.account);
        let (sponsor_before, sponsor_after) = moved(&self.accounts.sponsor);
        record.check(
            "transfer executed as the DAO",
            executed.ok
                && dao_before.checked_sub(dao_after) == Some(amount)
                && sponsor_after.checked_sub(sponsor_before) == Some(amount),
            format!(
                "tx {}: {} {dao_before} → {dao_after}, {} {sponsor_before} → {sponsor_after}",
                executed.hash, derived.account, self.accounts.sponsor
            ),
        );

        let passed = record.checks.iter().all(|c| c.pass);
        report::write_named(&config.results, "dao-transfer", &record, passed)?;
        ensure!(passed, "DAO transfer checks failed; see the results report");
        Ok(())
    }

    /// Decodes proposal `id` and checks that approving it signs exactly the
    /// payload it carries, for this DAO's account, on the Verifier.
    async fn verify(&self, id: u64) -> Result<Verification> {
        let proposal: Value = self
            .chain
            .view(&self.id, "get_proposal", &json!({ "id": id }))
            .await?;
        let derived = self.derived().await?;
        Ok(check_proposal(
            &proposal,
            &derived.account,
            &self.chain.verifier,
            self.chain.block_time().await?,
        ))
    }
}

/// Checks that approving `proposal` signs exactly the payload it carries,
/// for `account` (the DAO's), on `verifier`, unexpired at `now`.
fn check_proposal(
    proposal: &Value,
    account: &AccountId,
    verifier: &AccountId,
    now: Timestamp,
) -> Verification {
    let mut checks = Vec::new();
    let mut add = |name: String, ok: bool| checks.push((name, ok));

    let call = &proposal["kind"]["FunctionCall"];
    add(
        format!("calls {MPC_SIGNER}: {}", call["receiver_id"]),
        call["receiver_id"] == MPC_SIGNER,
    );
    let actions = call["actions"].as_array().cloned().unwrap_or_default();
    let action = actions.first().cloned().unwrap_or_default();
    add(
        format!(
            "one action, `sign`: {} action(s), {}",
            actions.len(),
            action["method_name"]
        ),
        actions.len() == 1 && action["method_name"] == "sign",
    );
    let args: Value = action["args"]
        .as_str()
        .and_then(|a| BASE64.decode(a).ok())
        .and_then(|a| serde_json::from_slice(&a).ok())
        .unwrap_or_default();
    let request = &args["request"];
    add(
        format!(
            "this DAO's key: path {}, domain {}",
            request["path"], request["domain_id"]
        ),
        request["path"] == PATH && request["domain_id"] == ED25519_DOMAIN,
    );

    let payload = args["intent"]
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .and_then(|intent| Payload::from_json(&intent).ok());
    let signed_hash = request["payload_v2"]["Eddsa"]
        .as_str()
        .and_then(|h| hex::decode(h).ok());
    add(
        "the signed hash is the NEP-413 hash of the attached payload".into(),
        payload
            .as_ref()
            .is_some_and(|p| signed_hash.as_deref() == Some(&p.hash()[..])),
    );

    let message: Value = payload
        .as_ref()
        .and_then(|p| serde_json::from_str(&p.message).ok())
        .unwrap_or_default();
    add(
        format!(
            "signer is this DAO's account {account}: {}",
            message["signer_id"]
        ),
        message["signer_id"] == account.as_str(),
    );
    add(
        format!(
            "for the Verifier {verifier}: {}",
            payload.as_ref().map_or("?", |p| p.recipient.as_str())
        ),
        payload
            .as_ref()
            .is_some_and(|p| p.recipient == verifier.as_str()),
    );
    let deadline = message["deadline"]
        .as_str()
        .and_then(|d| serde_json::from_value::<Timestamp>(json!(d)).ok());
    add(
        format!("not expired: deadline {}", message["deadline"]),
        deadline.is_some_and(|d| d > now),
    );
    Verification {
        checks,
        intents: message["intents"].as_array().cloned().unwrap_or_default(),
        payload,
    }
}

/// The args of a sign proposal: the signer's `request` for `payload`'s hash
/// with the DAO's key, and the payload itself as a JSON string in `intent`.
/// The Trezu template (`trezu/sign-intents.json`) files exactly this.
pub fn sign_args(payload: &Payload) -> Value {
    json!({
        "request": {
            "path": PATH,
            "payload_v2": { "Eddsa": hex::encode(payload.hash()) },
            "domain_id": ED25519_DOMAIN,
        },
        "intent": payload.to_json().to_string(),
    })
}

/// An MPC signer response, `{"scheme": "Ed25519", "signature": [64 bytes]}`.
fn ed25519_signature(value: &Value) -> Option<Signature> {
    if value["scheme"] != "Ed25519" {
        return None;
    }
    let bytes: Vec<u8> = serde_json::from_value(value["signature"].clone()).ok()?;
    Some(Signature::ed25519_from_bytes(bytes.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = include_str!("../trezu/sign-intents.json");
    /// Any future deadline will do for these offline checks.
    const TEST_TTL: Duration = Duration::from_hours(1);

    /// Trezu's substitution: every `{{name}}` inside a string value.
    fn fill(value: &Value, fields: &[(&str, &str)]) -> Value {
        match value {
            Value::String(s) => Value::String(fields.iter().fold(s.clone(), |s, (name, v)| {
                s.replace(&format!("{{{{{name}}}}}"), v)
            })),
            Value::Array(items) => Value::Array(items.iter().map(|v| fill(v, fields)).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), fill(v, fields)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    const DAO_ACCOUNT: &str = "aa59f4f8d95bb6f755c51939c6504e4d9fe9b63cf4594cd31d47b8c1ee9f48f0";
    const VERIFIER: &str = "verifier.tidepool-sandbox.testnet";

    fn payload(signer: &str, amount: u128) -> Result<Payload> {
        Payload::new(
            &signer.parse()?,
            &VERIFIER.parse()?,
            "01020304",
            Timestamp::now() + TEST_TTL,
            &[transfer(&"a.testnet".parse()?, "nep141:t", amount, None)],
        )
    }

    /// A proposal as `get_proposal` returns it, calling `receiver` with
    /// `actions` of `(method, args)`.
    fn proposal(receiver: &str, actions: &[(&str, &Value)]) -> Value {
        let actions: Vec<Value> = actions
            .iter()
            .map(|(method, args)| json!({ "method_name": method, "args": BASE64.encode(args.to_string()), "deposit": "1", "gas": "100000000000000" }))
            .collect();
        json!({ "kind": { "FunctionCall": { "receiver_id": receiver, "actions": actions } } })
    }

    fn failed_checks(proposal: &Value) -> Result<Vec<String>> {
        let verification = check_proposal(
            proposal,
            &DAO_ACCOUNT.parse()?,
            &VERIFIER.parse()?,
            Timestamp::now(),
        );
        Ok(verification
            .checks
            .into_iter()
            .filter(|(_, ok)| !ok)
            .map(|(name, _)| name)
            .collect())
    }

    #[test]
    fn honest_proposal_verifies() -> Result<()> {
        let args = sign_args(&payload(DAO_ACCOUNT, 1)?);
        assert_eq!(
            failed_checks(&proposal(MPC_SIGNER, &[("sign", &args)]))?,
            Vec::<String>::new()
        );
        Ok(())
    }

    #[test]
    fn hash_of_another_payload_is_caught() -> Result<()> {
        // Shows a transfer of 1, signs a transfer of 1,000,000.
        let mut args = sign_args(&payload(DAO_ACCOUNT, 1)?);
        args["request"] = sign_args(&payload(DAO_ACCOUNT, 1_000_000)?)["request"].clone();
        let failed = failed_checks(&proposal(MPC_SIGNER, &[("sign", &args)]))?;
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert!(failed[0].contains("NEP-413 hash"), "{failed:?}");
        Ok(())
    }

    #[test]
    fn another_signer_is_caught() -> Result<()> {
        let args = sign_args(&payload("someone.testnet", 1)?);
        let failed = failed_checks(&proposal(MPC_SIGNER, &[("sign", &args)]))?;
        assert!(
            failed.len() == 1 && failed[0].contains("signer"),
            "{failed:?}"
        );
        Ok(())
    }

    #[test]
    fn another_key_receiver_or_extra_action_is_caught() -> Result<()> {
        let args = sign_args(&payload(DAO_ACCOUNT, 1)?);
        let mut other_path = args.clone();
        other_path["request"]["path"] = "other".into();
        for (proposal, check) in [
            (proposal(MPC_SIGNER, &[("sign", &other_path)]), "key"),
            (proposal("evil.testnet", &[("sign", &args)]), "calls"),
            (
                proposal(MPC_SIGNER, &[("sign", &args), ("sign", &args)]),
                "one action",
            ),
        ] {
            let failed = failed_checks(&proposal)?;
            assert!(
                failed.iter().any(|f| f.contains(check)),
                "{check}: {failed:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn trezu_template_files_the_same_args() -> Result<()> {
        let manifest: Value = serde_json::from_str(MANIFEST)?;
        let binding = &manifest["binding"];
        assert_eq!(binding["receiver_id"], MPC_SIGNER);
        assert_eq!(binding["method_name"], "sign");
        assert_eq!(binding["deposit"], ONE_YOCTO.as_yoctonear().to_string());
        assert_eq!(binding["gas"], SIGN_GAS.as_gas().to_string());

        let payload = Payload::new(
            &"aa59f4f8d95bb6f755c51939c6504e4d9fe9b63cf4594cd31d47b8c1ee9f48f0".parse()?,
            &"verifier.tidepool-sandbox.testnet".parse()?,
            "01020304",
            Timestamp::now() + TEST_TTL,
            &[
                json!({ "intent": "transfer", "receiver_id": "a.testnet", "tokens": { "nep141:t": "1" } }),
            ],
        )?;
        let expected = sign_args(&payload);
        // What `dao prepare` prints, entered in the template's two fields.
        let intent = expected["intent"].as_str().unwrap_or_default();
        let hash = expected["request"]["payload_v2"]["Eddsa"]
            .as_str()
            .unwrap_or_default();
        let pattern = manifest["fields"][1]["validation"]["pattern"].as_str();
        assert_eq!(pattern, Some("^[0-9a-f]{64}$"));
        assert!(
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );

        let filed = fill(&manifest["args"], &[("intent", intent), ("hash", hash)]);
        assert_eq!(filed, expected);
        Ok(())
    }
}
