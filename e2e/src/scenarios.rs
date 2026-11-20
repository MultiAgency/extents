use std::{collections::BTreeMap, time::Duration};

use anyhow::{Context, Result, bail};
use clap::ValueEnum;
use extents_client::objective::{self as client, Call, Objective};
use extents_objective::{
    Attestation, Delivery, Params, Pips, Timestamp, Verdict, auth_call::Action, token_id::TokenId,
};
use extents_spec::Review;
use near_kit::{AccountId, Gas, NearToken};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    Config,
    accounts::{Accounts, code_hash},
    chain::{Chain, Tx},
    dao, documents, intent,
};

#[derive(Debug, Clone, Copy, ValueEnum, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scenario {
    /// Deploys with no deposit and pays out from a zero NEAR balance.
    Deposit,
    /// Two contributors at 70/30; an achieved verdict first with one
    /// commitment (must fail), then with both.
    Achieved,
    /// A failed verdict returns everything to the sponsor.
    Failed,
    /// No verdict by the deadline; `ob_close` returns the funds and the
    /// account deletes itself, paying its balance to the closer.
    Expired,
    /// Contributors commit, and the evaluator attests, through signed
    /// `auth_call` intents relayed to the Verifier.
    AuthCall,
    /// Ten contributors: eleven payouts settled in one transaction, with the
    /// gas of every receipt recorded.
    Max,
    /// As `Max`, with the evaluator attesting by a signed `auth_call`
    /// intent.
    MaxAuthCall,
    /// An acceptance window: both contributors commit and deliver, the
    /// window runs past the deadline, `ob_close` is refused until it ends,
    /// and the evaluator's silence then pays the contributors.
    Accepted,
    /// A Sputnik DAO's own account is the sponsor and the evaluator, as an
    /// agency's treasury is: it funds and attests by `FunctionCall`
    /// proposals its council approves.
    DaoObjective,
    /// As `DaoObjective`, for the DAO's MPC-derived account: it funds with a
    /// `transfer` intent and attests with an `auth_call` intent, each signed
    /// by the council's vote through the MPC signer.
    DaoIntentObjective,
}

/// Everything recorded for one scenario.
#[derive(Debug, Serialize)]
pub struct Run {
    pub code_hash: String,
    pub verifier_sha256: &'static str,
    pub scenario: Scenario,
    pub objective: Option<AccountId>,
    pub params: Option<Value>,
    /// The document `params.spec_hash` commits to.
    pub spec: Option<Value>,
    /// Every review attested with, including those the contract rejected.
    pub reviews: Vec<Value>,
    pub deposit_yocto: u128,
    pub steps: Vec<Step>,
    pub checks: Vec<Check>,
}

#[derive(Debug, Serialize)]
pub struct Step {
    #[serde(flatten)]
    pub tx: Tx,
    pub before: Balances,
    pub after: Balances,
}

/// Verifier balances of the tracked accounts, and the objective's NEAR
/// balance (`None` once deleted).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Balances {
    pub mt: BTreeMap<AccountId, String>,
    pub objective_near_yocto: Option<String>,
}

impl Balances {
    const EMPTY: Self = Self {
        mt: BTreeMap::new(),
        objective_near_yocto: None,
    };
}

#[derive(Debug, Serialize)]
pub struct Check {
    pub name: String,
    pub pass: bool,
    pub detail: String,
}

impl Run {
    pub fn passed(&self) -> bool {
        !self.checks.is_empty() && self.checks.iter().all(|c| c.pass)
    }

    fn check(&mut self, name: &str, pass: bool, detail: impl Into<String>) {
        let detail = detail.into();
        println!(
            "  [{}] {name}: {detail}",
            if pass { "pass" } else { "FAIL" }
        );
        self.checks.push(Check {
            name: name.into(),
            pass,
            detail,
        });
    }
}

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Time to deploy, fund, commit and attest before the deadline. Each
/// contributor commits in a separate transaction, awaited to finality, with
/// balance snapshots before and after.
const DEADLINE_BASE: Duration = Duration::from_secs(110);
const DEADLINE_PER_CONTRIBUTOR: Duration = Duration::from_secs(20);
/// Block timestamps lag wall-clock time; wait this long past the deadline.
const DEADLINE_SLACK: Duration = Duration::from_secs(10);

/// Not divisible by 10 or by 70/30, so every split leaves a remainder for
/// the sponsor: 1.000009 USDC.
const AMOUNT: u128 = 1_000_009;

/// Time for a DAO to fund and attest, each by two votes (and, for the
/// intent path, an MPC signature, about 30 s on testnet), around two
/// commits.
const DAO_DEADLINE_IN: Duration = Duration::from_mins(6);

/// NEAR offered as a `StateInit` deposit (which is refunded), then
/// transferred to the expired instance to show where deletion sends it.
const SURPLUS: NearToken = NearToken::from_millinear(1);

impl Scenario {
    pub async fn run(self, chain: &Chain, accounts: &Accounts, config: &Config) -> Result<Run> {
        println!("== {self:?}");
        let code_hash = code_hash(
            &std::fs::read(&config.wasm)
                .with_context(|| format!("reading {}", config.wasm.display()))?,
        );
        let ctx = Ctx {
            chain,
            accounts,
            config,
            code_hash,
        };
        let mut run = Run {
            code_hash: hex::encode(code_hash),
            verifier_sha256: extents_client::VERIFIER_SHA256,
            scenario: self,
            objective: None,
            params: None,
            spec: None,
            reviews: Vec::new(),
            deposit_yocto: 0,
            steps: Vec::new(),
            checks: Vec::new(),
        };
        let result = match self {
            Self::Deposit => deposit(&ctx, &mut run).await,
            Self::Achieved => achieved(&ctx, &mut run).await,
            Self::Failed => failed(&ctx, &mut run).await,
            Self::Expired => expired(&ctx, &mut run).await,
            Self::AuthCall => auth_call(&ctx, &mut run).await,
            Self::Max => max(&ctx, &mut run).await,
            Self::MaxAuthCall => max_auth_call(&ctx, &mut run).await,
            Self::Accepted => accepted(&ctx, &mut run).await,
            Self::DaoObjective => dao_objective(&ctx, &mut run).await,
            Self::DaoIntentObjective => dao_intent_objective(&ctx, &mut run).await,
        };
        if let Err(err) = result {
            run.check("completed", false, format!("{err:#}"));
        }
        Ok(run)
    }
}

struct Ctx<'a> {
    chain: &'a Chain,
    accounts: &'a Accounts,
    config: &'a Config,
    code_hash: [u8; 32],
}

/// A deployed objective, and the run it records into.
struct Instance<'a, 'r> {
    ctx: &'a Ctx<'a>,
    run: &'r mut Run,
    objective: Objective,
}

impl Ctx<'_> {
    fn params(&self, contributors: &[(&AccountId, u32)], auth_call: bool) -> Result<Params> {
        let a = self.accounts;
        Ok(Params {
            sponsor: a.sponsor.as_str().parse()?,
            token: format!("nep245:{}:{}", self.config.verifier, self.config.token)
                .parse::<TokenId>()?,
            evaluator: a.evaluator.as_str().parse()?,
            contributors: contributors
                .iter()
                .map(|(c, pips)| {
                    Ok((
                        c.as_str().parse()?,
                        Pips::from_pips(*pips).context("share out of range")?,
                    ))
                })
                .collect::<Result<_>>()?,
            backups: BTreeMap::new(),
            deadline: Timestamp::now()
                + DEADLINE_BASE
                + DEADLINE_PER_CONTRIBUTOR * u32::try_from(contributors.len())?,
            commit_by: None,
            acceptance_window_secs: None,
            spec_hash: documents::spec().hash()?,
            auth_caller: auth_call
                .then(|| self.config.verifier.parse())
                .transpose()?,
            salt: rand::random(),
        })
    }

    async fn deploy<'a, 'r>(
        &'a self,
        run: &'r mut Run,
        params: Params,
        deposit: NearToken,
    ) -> Result<Instance<'a, 'r>> {
        let objective = Objective::new(params, self.code_hash)?;
        let (account, params) = (objective.account(), objective.params());
        let tx = self
            .chain
            .state_init(
                "deploy (StateInit)",
                &self.accounts.sponsor,
                objective.state_init(),
                deposit,
            )
            .await?;
        // Every call needs the full params; log them before anything can
        // interrupt the run, so an instance can always be closed by hand.
        println!("  objective: {account}");
        println!("  params: {}", serde_json::to_string(&params)?);
        run.objective = Some(account.clone());
        run.params = Some(serde_json::to_value(params)?);
        run.spec = Some(serde_json::to_value(documents::spec())?);
        run.deposit_yocto = deposit.as_yoctonear();

        let instance = Instance {
            ctx: self,
            run,
            objective,
        };
        let before = Balances::EMPTY;
        let after = instance.balances().await?;
        let ok = tx.ok;
        instance.run.steps.push(Step { tx, before, after });
        if !ok {
            bail!("deploy failed");
        }
        Ok(instance)
    }
}

impl Instance<'_, '_> {
    fn tracked(&self) -> Vec<AccountId> {
        std::iter::once(
            self.objective
                .params()
                .sponsor
                .as_str()
                .parse()
                .unwrap_or_else(|_| unreachable!()),
        )
        .chain(
            self.objective
                .params()
                .contributors
                .keys()
                .map(|c| c.as_str().parse().unwrap_or_else(|_| unreachable!())),
        )
        .chain(std::iter::once(self.objective.account().clone()))
        .collect()
    }

    async fn balances(&self) -> Result<Balances> {
        let mut mt = BTreeMap::new();
        for account in self.tracked() {
            mt.insert(
                account.clone(),
                self.ctx.chain.mt_balance(&account).await?.to_string(),
            );
        }
        Ok(Balances {
            mt,
            objective_near_yocto: self
                .ctx
                .chain
                .near_balance(self.objective.account())
                .await?
                .map(|b| b.to_string()),
        })
    }

    fn mt(balances: &Balances, account: &AccountId) -> u128 {
        balances
            .mt
            .get(account)
            .and_then(|b| b.parse().ok())
            .unwrap_or_default()
    }

    async fn call(&mut self, label: &str, signer: &AccountId, call: &Call) -> Result<Tx> {
        let before = self.balances().await?;
        let tx = self.ctx.chain.call(label, signer, call).await?;
        let after = self.balances().await?;
        self.run.steps.push(Step {
            tx: tx.clone(),
            before,
            after,
        });
        Ok(tx)
    }

    async fn transfer(&mut self, label: &str, amount: NearToken) -> Result<Tx> {
        let before = self.balances().await?;
        let tx = self
            .ctx
            .chain
            .transfer(
                label,
                &self.ctx.accounts.sponsor,
                self.objective.account(),
                amount,
            )
            .await?;
        let after = self.balances().await?;
        self.run.steps.push(Step {
            tx: tx.clone(),
            before,
            after,
        });
        Ok(tx)
    }

    async fn fund(&mut self, amount: u128) -> Result<Tx> {
        let (sponsor, call) = (
            self.ctx.accounts.sponsor.clone(),
            self.objective.fund(amount),
        );
        let tx = self
            .call("fund (mt_transfer_call)", &sponsor, &call)
            .await?;
        let funded = tx.events_of("funded").count() == 1;
        self.run.check(
            "funded",
            funded,
            format!("{amount} via mt_transfer_call, tx {}", tx.hash),
        );
        if !funded {
            bail!("funding failed");
        }
        Ok(tx)
    }

    async fn commit(&mut self, contributor: &AccountId) -> Result<Tx> {
        let call = self.objective.commit();
        self.call(&format!("ob_commit by {contributor}"), contributor, &call)
            .await
    }

    async fn deliver(&mut self, contributor: &AccountId) -> Result<Tx> {
        let hash = documents::deliverable(contributor.as_str());
        let call = self.objective.deliver(&Delivery { hash });
        self.call(&format!("ob_deliver by {contributor}"), contributor, &call)
            .await
    }

    /// An attestation of `verdict` with the hash of a review, which is
    /// recorded in the run.
    fn review(&mut self, verdict: Verdict) -> Result<Attestation> {
        let review = documents::review(
            self.objective.account().as_str(),
            self.objective.params(),
            verdict,
        )?;
        self.run.reviews.push(serde_json::to_value(&review)?);
        Ok(Attestation {
            verdict,
            review_hash: Some(review.hash()?),
        })
    }

    /// Recomputes the `resolved` event's `review_hash` from the reviews
    /// recorded in the run, each read back as a document and validated
    /// against the spec; checks that the review names this objective, and
    /// that `params.spec_hash` is the spec's hash.
    fn check_review(&mut self, resolved: &Value) {
        let spec = documents::spec();
        let event_hash = resolved["data"]["review_hash"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let review = self.run.reviews.iter().find_map(|doc| {
            let review = Review::from_json(&serde_json::to_vec(doc).ok()?, &spec).ok()?;
            let hash = review.hash().ok()?;
            (hex::encode(hash) == event_hash).then_some(review)
        });
        let objective = review.as_ref().map(|r| r.objective.to_string());
        let names_objective = objective.as_deref() == Some(self.objective.account().as_str());
        let spec_matches = spec
            .hash()
            .is_ok_and(|h| h == self.objective.params().spec_hash);
        self.run.check(
            "review_hash recomputed",
            names_objective && spec_matches,
            format!(
                "review_hash {event_hash}: {}; review names objective {objective:?}; \
                 params.spec_hash is the spec's hash: {spec_matches}",
                if review.is_some() {
                    "hash of a recorded review that validates against the spec"
                } else {
                    "no recorded review has this hash"
                }
            ),
        );
    }

    async fn attest(&mut self, attestation: Attestation) -> Result<Tx> {
        let evaluator = self.ctx.accounts.evaluator.clone();
        let label = format!("ob_attest {}", serde_json::to_string(&attestation)?);
        let call = self.objective.attest(&attestation);
        self.call(&label, &evaluator, &call).await
    }

    async fn close(&mut self, signer: &AccountId) -> Result<Tx> {
        let call = self.objective.close();
        self.call(&format!("ob_close by {signer}"), signer, &call)
            .await
    }

    /// Relays signed intents to `execute_intents` on the Verifier, from the
    /// deployer.
    async fn execute_intents(&mut self, label: &str, signed: &[Value]) -> Result<Tx> {
        let relayer = self.ctx.accounts.deployer.clone();
        let call = client::execute_intents(&self.ctx.chain.verifier, signed);
        let simulated: Result<Value> = self
            .ctx
            .chain
            .view(&call.receiver, "simulate_intents", &call.args)
            .await;
        if let Err(err) = &simulated {
            println!("  simulate_intents rejected: {err:#}");
        }
        self.call(label, &relayer, &call).await
    }

    async fn wait_for_deadline(&self) {
        let left = self
            .objective
            .params()
            .deadline
            .duration_since(Timestamp::now())
            .unwrap_or_default();
        let wait = left + DEADLINE_SLACK;
        println!("  waiting {}s for the deadline", wait.as_secs());
        tokio::time::sleep(wait).await;
    }

    /// After the deadline, a settled objective deletes itself on `ob_close`,
    /// sending its NEAR balance to the transaction's signer.
    async fn close_after_deadline(&mut self, closer: &AccountId) -> Result<Tx> {
        self.wait_for_deadline().await;
        let near_before = self
            .ctx
            .chain
            .near_balance(self.objective.account())
            .await?;
        let tx = self.close(closer).await?;
        let gone = self
            .ctx
            .chain
            .near_balance(self.objective.account())
            .await?
            .is_none();
        self.run.check(
            "deleted after deadline",
            gone && tx.events_of("cleanup").count() == 1,
            format!(
                "view_account after ob_close: {}; cleanup event: {}",
                if gone {
                    "does not exist"
                } else {
                    "still exists"
                },
                tx.events_of("cleanup").count()
            ),
        );
        self.check_beneficiary(&tx, closer, near_before.unwrap_or_default());
        Ok(tx)
    }

    /// Checks that deletion pays the instance's remaining NEAR, `balance`, to
    /// the signer of the deleting transaction.
    fn check_beneficiary(&mut self, tx: &Tx, closer: &AccountId, balance: u128) {
        let deleting = tx.receipts.iter().find(|r| {
            &r.executor == self.objective.account() && r.action.contains("DeleteAccount")
        });
        let to_closer: Vec<_> = tx
            .receipts
            .iter()
            .filter(|r| &r.executor == closer && r.transfer_yocto.is_some())
            .map(|r| {
                format!(
                    "{} from {}",
                    r.transfer_yocto.as_deref().unwrap_or("?"),
                    r.predecessor
                )
            })
            .collect();
        let matched = balance == 0
            || tx
                .receipts
                .iter()
                .any(|r| &r.executor == closer && r.transfer_yocto == Some(balance.to_string()));
        self.run.check(
            "deletion pays the closer",
            deleting.is_some() && matched,
            format!(
                "objective held {balance} yocto before ob_close; DeleteAccount receipt: {}; \
                 transfers to {closer}: [{}]",
                deleting.map_or_else(|| "none".into(), |r| format!("{} Tgas", r.burnt_tgas)),
                to_closer.join(", ")
            ),
        );
    }

    /// Named accounts sign intents with a key registered on the Verifier.
    async fn register_keys(&mut self, signers: &[&AccountId]) -> Result<()> {
        let verifier = self.ctx.chain.verifier.clone();
        for &signer in signers {
            let pk = self.ctx.chain.signer(signer)?.public_key().to_string();
            let registered: bool = self
                .ctx
                .chain
                .view(
                    &verifier,
                    "has_public_key",
                    &json!({ "account_id": signer, "public_key": pk }),
                )
                .await?;
            if !registered {
                self.call(
                    &format!("add_public_key for {signer}"),
                    signer,
                    &client::add_public_key(&verifier, &pk),
                )
                .await?;
            }
        }
        Ok(())
    }

    /// The evaluator attests `achieved`, with a review, by a signed
    /// `auth_call` intent that guarantees `on_auth` the gas `ob_attest` needs.
    async fn attest_by_intent(&mut self) -> Result<Tx> {
        let attestation = self.review(Verdict::Achieved)?;
        let review = attestation.review_hash.unwrap_or_default();
        let evaluator = self.ctx.accounts.evaluator.clone();
        let min_gas = self.objective.attest(&attestation).gas;
        let intent = self.objective.auth_call(Action::Attest(attestation));
        let signed = intent::sign(self.ctx.chain, &evaluator, &[intent]).await?;
        let tx = self
            .execute_intents(
                &format!(
                    "auth_call attest by evaluator (min_gas {} Tgas)",
                    min_gas.as_tgas()
                ),
                &[signed],
            )
            .await?;
        let resolved = tx.events_of("resolved").next().cloned().unwrap_or_default();
        self.run.check(
            "attested via auth_call",
            resolved["data"]["outcome"] == "achieved"
                && resolved["data"]["review_hash"] == hex::encode(review),
            resolved["data"].to_string(),
        );
        self.check_review(&resolved);
        Ok(tx)
    }

    /// Gas of a settlement: every payout and the callback succeeded, and how
    /// much each receipt was given and used.
    fn check_gas(&mut self, tx: &Tx, payouts: usize) {
        let transfers: Vec<_> = tx
            .receipts
            .iter()
            .filter(|r| r.action == "mt_transfer")
            .collect();
        let max_burnt = transfers.iter().map(|r| r.burnt_tgas).fold(0.0, f64::max);
        let callback = tx
            .receipts
            .iter()
            .find(|r| r.action == "ob_resolve_transfers");
        let entry = tx
            .receipts
            .iter()
            .find(|r| r.action == "ob_attest" || r.action == "on_auth");
        self.run.check(
            "gas",
            tx.ok
                && transfers.len() == payouts
                && transfers.iter().all(|r| r.ok)
                && callback.is_some_and(|r| r.ok),
            format!(
                "prepaid {:.0} Tgas, burnt {:.1} Tgas in total; {} attached {:?}, burnt {:?} Tgas; \
                 {} mt_transfer receipts, each attached {:?} Tgas, max burnt {max_burnt:.2} Tgas; \
                 callback attached {:?}, burnt {:?} Tgas",
                tx.prepaid_tgas,
                tx.burnt_tgas,
                entry.map_or("?", |r| r.action.as_str()),
                entry.and_then(|r| r.attached_tgas),
                entry.map(|r| r.burnt_tgas),
                transfers.len(),
                transfers.first().and_then(|r| r.attached_tgas),
                callback.and_then(|r| r.attached_tgas),
                callback.map(|r| r.burnt_tgas),
            ),
        );
    }

    fn check_payouts(&mut self, tx: &Tx, before: &Balances, expected: &[(AccountId, u128)]) {
        let after = &self
            .run
            .steps
            .last()
            .map_or_else(|| before.clone(), |s| s.after.clone());
        for (account, amount) in expected {
            let delta = Self::mt(after, account) - Self::mt(before, account);
            self.run.check(
                &format!("{account} received"),
                delta == *amount,
                format!("expected {amount}, Verifier balance changed by {delta}"),
            );
        }
        let objective_left = Self::mt(after, self.objective.account());
        self.run.check(
            "objective emptied",
            objective_left == 0,
            format!("objective's Verifier balance after: {objective_left}"),
        );
        let failed: Vec<_> = tx.failed_receipts().map(|r| r.action.clone()).collect();
        self.run.check(
            "all payout receipts succeeded",
            failed.is_empty(),
            format!("failed receipts: {failed:?}"),
        );
        let paid = tx.events_of("paid").count() == 1;
        self.run
            .check("paid event", paid, event_summary(tx, "paid"));
    }

    fn expected_split(&self, amount: u128) -> Vec<(AccountId, u128)> {
        self.objective
            .params()
            .split(amount)
            .into_iter()
            .map(|(recipient, share)| {
                let id: AccountId = self
                    .objective
                    .params()
                    .holder_id(recipient, 0)
                    .unwrap_or_else(|_| unreachable!())
                    .as_str()
                    .parse()
                    .unwrap_or_else(|_| unreachable!());
                (id, share)
            })
            .collect()
    }
}

fn event_summary(tx: &Tx, kind: &str) -> String {
    tx.events_of(kind)
        .map(|e| e["data"].to_string())
        .collect::<Vec<_>>()
        .join("; ")
}

async fn deposit(ctx: &Ctx<'_>, run: &mut Run) -> Result<()> {
    let [c0, c1, ..] = &ctx.accounts.contributors[..] else {
        unreachable!()
    };
    let params = ctx.params(&[(c0, 700_000), (c1, 300_000)], false)?;
    let mut ob = ctx.deploy(run, params, NearToken::ZERO).await?;
    let near = ob.ctx.chain.near_balance(ob.objective.account()).await?;
    ob.run.check(
        "zero-deposit StateInit",
        near == Some(0),
        format!("account exists with {near:?} yocto"),
    );

    ob.fund(AMOUNT).await?;
    ob.commit(c0).await?;
    ob.commit(c1).await?;

    // nearcore 2.14 (`one_yocto_on_promise`) does not deduct a 1 yoctoNEAR
    // promise deposit from a contract whose balance is zero.
    let before = ob.balances().await?;
    let tx = ob.attest(Verdict::Achieved.into()).await?;
    let after = ob
        .run
        .steps
        .last()
        .and_then(|s| s.after.objective_near_yocto.clone());
    let one_yocto_transfers = tx
        .receipts
        .iter()
        .filter(|r| r.action == "mt_transfer" && r.ok && r.attached_yocto.as_deref() == Some("1"))
        .count();
    let expected = ob.expected_split(AMOUNT);
    ob.run.check(
        "payouts from a zero balance",
        tx.ok
            && one_yocto_transfers == expected.len()
            && before.objective_near_yocto.as_deref() == Some("0")
            && after.as_deref() == Some("0"),
        format!(
            "{one_yocto_transfers} mt_transfer receipts with 1 yocto attached succeeded; \
             objective NEAR before {:?}, after {after:?}; tx {}",
            before.objective_near_yocto, tx.hash
        ),
    );
    ob.check_payouts(&tx, &before, &expected);
    let closer = ob.ctx.accounts.deployer.clone();
    ob.close_after_deadline(&closer).await?;
    Ok(())
}

async fn achieved(ctx: &Ctx<'_>, run: &mut Run) -> Result<()> {
    let [c0, c1, ..] = &ctx.accounts.contributors[..] else {
        unreachable!()
    };
    let params = ctx.params(&[(c0, 700_000), (c1, 300_000)], false)?;
    let mut ob = ctx.deploy(run, params, NearToken::ZERO).await?;
    ob.fund(AMOUNT).await?;

    let tx = ob.commit(c0).await?;
    ob.run.check(
        "committed event",
        tx.events_of("committed").count() == 1,
        event_summary(&tx, "committed"),
    );

    // Not committed: an achieved verdict with one of two commitments.
    let attestation = ob.review(Verdict::Achieved)?;
    let review = attestation.review_hash.unwrap_or_default();
    let tx = ob.attest(attestation).await?;
    let error = tx.error.clone().unwrap_or_default();
    ob.run.check(
        "not committed",
        !tx.ok && error.contains("not all contributors have committed"),
        format!("tx {}: {error}", tx.hash),
    );

    let tx = ob.commit(c1).await?;
    ob.run.check(
        "committed event",
        tx.events_of("committed").count() == 1,
        event_summary(&tx, "committed"),
    );

    let before = ob.balances().await?;
    let tx = ob.attest(attestation).await?;
    let resolved = tx.events_of("resolved").next().cloned().unwrap_or_default();
    ob.run.check(
        "resolved event with review_hash",
        resolved["data"]["outcome"] == "achieved"
            && resolved["data"]["review_hash"] == hex::encode(review),
        resolved["data"].to_string(),
    );
    ob.check_review(&resolved);
    let expected = ob.expected_split(AMOUNT);
    ob.check_payouts(&tx, &before, &expected);

    let closer = c1.clone();
    ob.close_after_deadline(&closer).await?;
    Ok(())
}

async fn failed(ctx: &Ctx<'_>, run: &mut Run) -> Result<()> {
    let [c0, c1, ..] = &ctx.accounts.contributors[..] else {
        unreachable!()
    };
    let params = ctx.params(&[(c0, 700_000), (c1, 300_000)], false)?;
    let mut ob = ctx.deploy(run, params, NearToken::ZERO).await?;
    ob.fund(AMOUNT).await?;

    let before = ob.balances().await?;
    let attestation = ob.review(Verdict::Failed)?;
    let tx = ob.attest(attestation).await?;
    let resolved = tx.events_of("resolved").next().cloned().unwrap_or_default();
    ob.run.check(
        "resolved failed",
        resolved["data"]["outcome"] == "failed",
        resolved["data"].to_string(),
    );
    ob.check_review(&resolved);
    let sponsor = ob.ctx.accounts.sponsor.clone();
    ob.check_payouts(&tx, &before, &[(sponsor, AMOUNT)]);

    let closer = ob.ctx.accounts.evaluator.clone();
    ob.close_after_deadline(&closer).await?;
    Ok(())
}

async fn expired(ctx: &Ctx<'_>, run: &mut Run) -> Result<()> {
    let [c0, c1, ..] = &ctx.accounts.contributors[..] else {
        unreachable!()
    };
    let params = ctx.params(&[(c0, 700_000), (c1, 300_000)], false)?;
    // A StateInit deposit only covers missing storage stake; a zero-balance
    // account needs none, so all of it goes back to the signer.
    let mut ob = ctx.deploy(run, params, SURPLUS).await?;
    let deploy = ob.run.steps.last().map(|s| s.tx.clone());
    let sponsor = ob.ctx.accounts.sponsor.clone();
    let refunded = deploy.as_ref().is_some_and(|tx| {
        tx.receipts.iter().any(|r| {
            r.executor == sponsor && r.transfer_yocto == Some(SURPLUS.as_yoctonear().to_string())
        })
    });
    let near = ob.ctx.chain.near_balance(ob.objective.account()).await?;
    ob.run.check(
        "StateInit deposit refunded",
        refunded && near == Some(0),
        format!(
            "deposit {} yocto; refund receipt to {sponsor}: {refunded}; objective NEAR after deploy: {near:?}",
            SURPLUS.as_yoctonear()
        ),
    );

    // The only way to give an instance NEAR is a plain transfer.
    ob.transfer("transfer NEAR to objective", SURPLUS).await?;
    let near = ob.ctx.chain.near_balance(ob.objective.account()).await?;
    ob.run.check(
        "objective holds NEAR",
        near == Some(SURPLUS.as_yoctonear()),
        format!("objective NEAR after transfer: {near:?}"),
    );
    ob.fund(AMOUNT).await?;
    ob.commit(c0).await?;

    let closer = ob.ctx.accounts.deployer.clone();
    let tx = ob.close(&closer).await?;
    let error = tx.error.clone().unwrap_or_default();
    ob.run.check(
        "close before deadline rejected",
        !tx.ok && error.contains("deadline has not expired yet"),
        format!("tx {}: {error}", tx.hash),
    );

    ob.wait_for_deadline().await;
    let before = ob.balances().await?;
    let near_before = ob
        .ctx
        .chain
        .near_balance(ob.objective.account())
        .await?
        .unwrap_or_default();
    let tx = ob.close(&closer).await?;
    let resolved = tx.events_of("resolved").next().cloned().unwrap_or_default();
    ob.run.check(
        "resolved expired",
        resolved["data"]["outcome"] == "expired",
        resolved["data"].to_string(),
    );
    ob.check_payouts(&tx, &before, &[(sponsor, AMOUNT)]);

    // Settled and past the deadline: the payout callback deletes the account
    // within the same transaction.
    let gone = ob
        .ctx
        .chain
        .near_balance(ob.objective.account())
        .await?
        .is_none();
    ob.run.check(
        "deleted in the same transaction",
        gone && tx.events_of("cleanup").count() == 1,
        format!(
            "view_account: {}",
            if gone {
                "does not exist"
            } else {
                "still exists"
            }
        ),
    );
    // With a non-zero balance the payout's 1 yocto is deducted; the rest goes
    // to the closer.
    let remaining = near_before
        .checked_sub(1)
        .context("objective had no NEAR before ob_close")?;
    ob.check_beneficiary(&tx, &closer, remaining);
    Ok(())
}

async fn auth_call(ctx: &Ctx<'_>, run: &mut Run) -> Result<()> {
    let [c0, c1, ..] = &ctx.accounts.contributors[..] else {
        unreachable!()
    };
    let params = ctx.params(&[(c0, 700_000), (c1, 300_000)], true)?;
    let mut ob = ctx.deploy(run, params, NearToken::ZERO).await?;
    ob.fund(AMOUNT).await?;

    let evaluator = ob.ctx.accounts.evaluator.clone();
    ob.register_keys(&[c0, c1, &evaluator]).await?;

    for c in [c0, c1] {
        let intent = ob.objective.auth_call(Action::Commit);
        let signed = intent::sign(ob.ctx.chain, c, &[intent]).await?;
        let tx = ob
            .execute_intents(&format!("auth_call commit by {c}"), &[signed])
            .await?;
        let committed = tx
            .events_of("committed")
            .any(|e| e["data"]["contributor"] == c.as_str());
        ob.run.check(
            &format!("{c} committed via auth_call"),
            tx.ok && committed,
            format!("tx {}: {}", tx.hash, event_summary(&tx, "committed")),
        );
    }

    let before = ob.balances().await?;
    let tx = ob.attest_by_intent().await?;
    let expected = ob.expected_split(AMOUNT);
    ob.check_payouts(&tx, &before, &expected);

    let closer = ob.ctx.accounts.deployer.clone();
    ob.close_after_deadline(&closer).await?;
    Ok(())
}

async fn max(ctx: &Ctx<'_>, run: &mut Run) -> Result<()> {
    let contributors = &ctx.accounts.contributors;
    let shares: Vec<_> = contributors.iter().map(|c| (c, 100_000)).collect();
    let params = ctx.params(&shares, false)?;
    let mut ob = ctx.deploy(run, params, NearToken::ZERO).await?;
    ob.fund(AMOUNT).await?;
    for c in contributors {
        ob.commit(c).await?;
    }

    let before = ob.balances().await?;
    let tx = ob.attest(Verdict::Achieved.into()).await?;
    let expected = ob.expected_split(AMOUNT);
    ob.run.check(
        "eleven payouts",
        expected.iter().filter(|(_, a)| *a > 0).count() == 11,
        format!("{expected:?}"),
    );
    ob.check_payouts(&tx, &before, &expected);
    ob.check_gas(&tx, expected.len());

    let closer = contributors[0].clone();
    ob.close_after_deadline(&closer).await?;
    Ok(())
}

async fn max_auth_call(ctx: &Ctx<'_>, run: &mut Run) -> Result<()> {
    let contributors = &ctx.accounts.contributors;
    let shares: Vec<_> = contributors.iter().map(|c| (c, 100_000)).collect();
    let params = ctx.params(&shares, true)?;
    let mut ob = ctx.deploy(run, params, NearToken::ZERO).await?;
    ob.fund(AMOUNT).await?;
    for c in contributors {
        ob.commit(c).await?;
    }
    let evaluator = ob.ctx.accounts.evaluator.clone();
    ob.register_keys(&[&evaluator]).await?;

    let before = ob.balances().await?;
    let tx = ob.attest_by_intent().await?;
    let expected = ob.expected_split(AMOUNT);
    ob.check_payouts(&tx, &before, &expected);
    ob.check_gas(&tx, expected.len());

    let closer = contributors[0].clone();
    ob.close_after_deadline(&closer).await?;
    Ok(())
}

/// Long enough that the window opened by the last delivery ends after the
/// deadline.
const ACCEPTANCE_WINDOW_SECS: u32 = 180;

async fn accepted(ctx: &Ctx<'_>, run: &mut Run) -> Result<()> {
    let [c0, c1, ..] = &ctx.accounts.contributors[..] else {
        unreachable!()
    };
    let params = Params {
        acceptance_window_secs: Some(ACCEPTANCE_WINDOW_SECS),
        ..ctx.params(&[(c0, 700_000), (c1, 300_000)], false)?
    };
    let mut ob = ctx.deploy(run, params, NearToken::ZERO).await?;
    ob.fund(AMOUNT).await?;
    ob.commit(c0).await?;
    ob.commit(c1).await?;

    let attest_by = |tx: &Tx| -> Option<Timestamp> {
        let delivered = tx.events_of("delivered").next()?;
        serde_json::from_value(delivered["data"]["attest_by"].clone()).ok()
    };

    let tx = ob.deliver(c0).await?;
    let first = attest_by(&tx);
    ob.run.check(
        "delivered event",
        tx.ok
            && first == Some(ob.objective.params().deadline)
            && tx
                .events_of("delivered")
                .any(|e| e["data"]["hash"] == hex::encode(documents::deliverable(c0.as_str()))),
        event_summary(&tx, "delivered"),
    );

    let tx = ob.deliver(c1).await?;
    let window_end = attest_by(&tx).context("no attest_by in the last delivery")?;
    ob.run.check(
        "full delivery opens the window past the deadline",
        tx.ok && window_end > ob.objective.params().deadline,
        format!(
            "deadline {}, attest_by {}",
            serde_json::to_string(&ob.objective.params().deadline)?,
            serde_json::to_string(&window_end)?
        ),
    );

    ob.wait_for_deadline().await;
    let tx = ob.close(c0).await?;
    let error = tx.error.clone().unwrap_or_default();
    ob.run.check(
        "close refused while the window is open",
        !tx.ok && error.contains("deadline has not expired yet"),
        format!("tx {}: {error}", tx.hash),
    );

    let left = window_end
        .duration_since(Timestamp::now())
        .unwrap_or_default();
    println!(
        "  waiting {}s for the acceptance window",
        (left + DEADLINE_SLACK).as_secs()
    );
    tokio::time::sleep(left + DEADLINE_SLACK).await;

    let before = ob.balances().await?;
    let closer = c1.clone();
    let tx = ob.close_after_deadline(&closer).await?;
    let resolved = tx.events_of("resolved").next().cloned().unwrap_or_default();
    ob.run.check(
        "silence resolves as accepted",
        resolved["data"]["outcome"] == "accepted" && resolved["data"].get("review_hash").is_none(),
        resolved["data"].to_string(),
    );
    let expected = ob.expected_split(AMOUNT);
    ob.check_payouts(&tx, &before, &expected);
    Ok(())
}

async fn dao_objective(ctx: &Ctx<'_>, run: &mut Run) -> Result<()> {
    // c0 and c1 are the DAO's council; the contributors are others.
    let [_, _, c2, c3, ..] = &ctx.accounts.contributors[..] else {
        unreachable!()
    };
    let dao = dao::Dao::new(ctx.chain, ctx.accounts, ctx.config)?;
    let mut params = ctx.params(&[(c2, 700_000), (c3, 300_000)], false)?;
    params.sponsor = dao.id.as_str().parse()?;
    params.evaluator = dao.id.as_str().parse()?;
    params.deadline = Timestamp::now() + DAO_DEADLINE_IN;
    let mut ob = ctx.deploy(run, params, NearToken::ZERO).await?;
    let (sponsor, verifier, token) = (
        ob.ctx.accounts.sponsor.clone(),
        ob.ctx.chain.verifier.clone(),
        ob.ctx.chain.token.clone(),
    );

    // The DAO's treasury on the Verifier.
    let tx = ob
        .call(
            "give the DAO the amount on the Verifier",
            &sponsor,
            &Call {
                receiver: verifier.clone(),
                method: "mt_transfer",
                args: json!({ "receiver_id": dao.id, "token_id": token, "amount": AMOUNT.to_string() }),
                gas: Gas::from_tgas(30),
                deposit: ONE_YOCTO,
            },
        )
        .await?;
    if !tx.ok {
        bail!("funding the DAO: {:?}", tx.error);
    }

    // Fund: the DAO's own `mt_transfer_call`, by proposal.
    let call = ob.objective.fund(AMOUNT);
    let description = format!(
        "Fund objective {} with {AMOUNT} {token}",
        ob.objective.account()
    );
    let tx = dao.execute(&mut *ob.run, &call, description).await?;
    let funded = tx.events_of("funded").count() == 1;
    ob.run.check(
        "funded by the DAO",
        funded,
        format!("tx {}: {}", tx.hash, event_summary(&tx, "funded")),
    );
    if !funded {
        bail!("funding by proposal failed");
    }

    for contributor in [c2, c3] {
        let tx = ob.commit(contributor).await?;
        ob.run.check(
            "committed event",
            tx.events_of("committed").count() == 1,
            event_summary(&tx, "committed"),
        );
    }

    // Attest: the DAO calls `ob_attest` itself, by proposal.
    let attestation = ob.review(Verdict::Achieved)?;
    let review = attestation.review_hash.unwrap_or_default();
    let objective = ob.objective.account().clone();
    let call = ob.objective.attest(&attestation);
    let description = format!("Attest objective {objective} as achieved");
    let before = ob.balances().await?;
    let tx = dao.execute(&mut *ob.run, &call, description).await?;
    let resolved = tx.events_of("resolved").next().cloned().unwrap_or_default();
    ob.run.check(
        "attested by the DAO",
        resolved["data"]["outcome"] == "achieved"
            && resolved["data"]["review_hash"] == hex::encode(review),
        resolved["data"].to_string(),
    );
    ob.check_review(&resolved);
    let expected = ob.expected_split(AMOUNT);
    ob.check_payouts(&tx, &before, &expected);

    let closer = ob.ctx.accounts.deployer.clone();
    ob.close_after_deadline(&closer).await?;
    Ok(())
}

async fn dao_intent_objective(ctx: &Ctx<'_>, run: &mut Run) -> Result<()> {
    // c0 and c1 are the DAO's council; the contributors are others.
    let [_, _, c2, c3, ..] = &ctx.accounts.contributors[..] else {
        unreachable!()
    };
    let dao = dao::Dao::new(ctx.chain, ctx.accounts, ctx.config)?;
    let account: AccountId = dao.derived().await?.account;
    let mut params = ctx.params(&[(c2, 700_000), (c3, 300_000)], true)?;
    params.sponsor = account.as_str().parse()?;
    params.evaluator = account.as_str().parse()?;
    params.deadline = Timestamp::now() + DAO_DEADLINE_IN;
    let mut ob = ctx.deploy(run, params, NearToken::ZERO).await?;

    // Fund: a transfer to the objective that notifies it with the fund
    // message, so the Verifier calls `mt_on_transfer` with the DAO as sender.
    let payload = dao.payload(&[ob.objective.fund_intent(AMOUNT)]).await?;
    let description = format!(
        "Fund objective {} with {AMOUNT} {}",
        ob.objective.account(),
        ob.ctx.chain.token
    );
    let (_, signed) = dao
        .sign_by_vote(&mut *ob.run, &payload, description)
        .await?;
    let tx = ob
        .execute_intents("fund by DAO intent (transfer with msg)", &[signed])
        .await?;
    let funded = tx.events_of("funded").count() == 1;
    ob.run.check(
        "funded by the DAO",
        funded,
        format!("tx {}: {}", tx.hash, event_summary(&tx, "funded")),
    );
    if !funded {
        bail!("funding by intent failed");
    }

    for contributor in [c2, c3] {
        let tx = ob.commit(contributor).await?;
        ob.run.check(
            "committed event",
            tx.events_of("committed").count() == 1,
            event_summary(&tx, "committed"),
        );
    }

    // Attest: an `auth_call` intent, so the objective sees the DAO's
    // account as the evaluator.
    let attestation = ob.review(Verdict::Achieved)?;
    let review = attestation.review_hash.unwrap_or_default();
    let payload = dao
        .payload(&[ob.objective.auth_call(Action::Attest(attestation))])
        .await?;
    let description = format!("Attest objective {} as achieved", ob.objective.account());
    let (_, signed) = dao
        .sign_by_vote(&mut *ob.run, &payload, description)
        .await?;
    let before = ob.balances().await?;
    let tx = ob
        .execute_intents("attest by DAO intent (auth_call)", &[signed])
        .await?;
    let resolved = tx.events_of("resolved").next().cloned().unwrap_or_default();
    ob.run.check(
        "attested by the DAO",
        resolved["data"]["outcome"] == "achieved"
            && resolved["data"]["review_hash"] == hex::encode(review),
        resolved["data"].to_string(),
    );
    ob.check_review(&resolved);
    let expected = ob.expected_split(AMOUNT);
    ob.check_payouts(&tx, &before, &expected);

    let closer = ob.ctx.accounts.deployer.clone();
    ob.close_after_deadline(&closer).await?;
    Ok(())
}
