//! A local NEAR sandbox for `extents-objective`, running the same Verifier
//! binary as mainnet `intents.near` and testnet
//! `verifier.tidepool-sandbox.testnet` (`defuse` v0.4.5).
//!
//! Unlike a public network, the test holds the Verifier's operator roles, so
//! failures that only an operator can cause, such as locking an account, are
//! produced by the Verifier's own code rather than simulated.
//!
//! The sandbox runs in Docker (`near-kit-sandbox`, nearcore 2.14).

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
pub use extents_client::outcome::Receipt;
use extents_client::{
    Payload,
    objective::{self as client, Call, Objective, Vote},
    outcome,
};
use extents_objective::{
    Attestation, Delivery, Params, Pips, Timestamp, auth_call::Action, token_id::TokenId,
};
use near_kit::{
    AccountId, Gas, Near, NearToken,
    protocol::{PublishMode, StateInit},
    rpc::{BlockReference, FinalExecutionOutcome, Finality},
    signer::{InMemorySigner, SecretKey},
    transaction::{Final, TransactionBuilder},
};
use near_kit_sandbox::{Sandbox, SandboxConfig};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Published contract code, pinned by sha256, fetched on first use from the
/// first source that serves exactly that code, and cached under
/// `target/sandbox/`.
pub struct Pinned {
    pub name: &'static str,
    pub sha256: &'static str,
    /// Tried in order.
    pub sources: &'static [Source],
}

/// Where pinned code is published.
pub enum Source {
    /// The code deployed on an account.
    Account {
        rpc: &'static str,
        chain_id: &'static str,
        account: &'static str,
    },
    /// A file served over HTTPS.
    Url(&'static str),
}

/// The Verifier at mainnet `intents.near` and testnet
/// `verifier.tidepool-sandbox.testnet` (`defuse` v0.4.5); as a NEAR code
/// hash, `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`.
pub const VERIFIER: Pinned = Pinned {
    name: "defuse",
    sha256: extents_client::VERIFIER_SHA256,
    sources: &[
        Source::Account {
            rpc: "https://rpc.testnet.fastnear.com",
            chain_id: "testnet",
            account: "verifier.tidepool-sandbox.testnet",
        },
        Source::Account {
            rpc: "https://rpc.mainnet.fastnear.com",
            chain_id: "mainnet",
            account: "intents.near",
        },
    ],
};

/// The Sputnik DAO contract agency DAOs run on mainnet.
///
/// It is the default of the `sputnik-dao.near` factory (global code hash
/// `DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF`, version 3.2), as
/// `agentic.sputnik-dao.near` runs it.
pub const SPUTNIK_DAO: Pinned = Pinned {
    name: "sputnikdao2",
    sha256: "bf6f951ee5e45968e3367fa857bebf8bc80badec183998c2239c487237e0d7f6",
    sources: &[Source::Account {
        rpc: "https://rpc.mainnet.fastnear.com",
        chain_id: "mainnet",
        account: "agentic.sputnik-dao.near",
    }],
};

/// The test token: the NEP-141 example contract the Intents repository tests
/// with, as released at the commit the `defuse-*` dependencies pin.
pub const FUNGIBLE_TOKEN: Pinned = Pinned {
    name: "fungible-token",
    sha256: "12c5f9bd9136b4396823478281a61368b4c74cdaf35ab5743b302c3aac55a354",
    sources: &[Source::Url(
        "https://raw.githubusercontent.com/near/intents/dbad9c8a4659e8bd7f42c152ec79448a8e9d281c/releases/fungible-token.wasm",
    )],
};

/// The NEP-171 example contract the Intents repository tests with, as
/// released at the commit the `defuse-*` dependencies pin. Only its owner
/// mints.
pub const NON_FUNGIBLE_TOKEN: Pinned = Pinned {
    name: "non-fungible-token",
    sha256: "38cfeef995845b9846ea323f94d44745dd9480857919bff1e41e72335354abbc",
    sources: &[Source::Url(
        "https://raw.githubusercontent.com/near/intents/dbad9c8a4659e8bd7f42c152ec79448a8e9d281c/releases/non-fungible-token.wasm",
    )],
};

const MAX_GAS: Gas = Gas::from_tgas(300);
const CALL_GAS: Gas = Gas::from_tgas(100);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// The sponsor's initial balance of the test token on the Verifier.
pub const SPONSOR_FUNDS: u128 = 1_000_000_000;
/// How long a signed intent, and its nonce, remain valid, in block time.
const INTENT_TTL: Duration = Duration::from_mins(5);
/// Blocks per fast-forward step. A block advances block time by about 0.3 s
/// in the sandbox, so this is roughly 25 minutes.
const FAST_FORWARD_STEP: u64 = 5_000;
const DAO_PROPOSAL_BOND: NearToken = NearToken::from_millinear(100);
const DAO_PROPOSAL_PERIOD: Duration = Duration::from_hours(24 * 7);

/// An account, its key, and a client that signs as it.
#[derive(Clone)]
pub struct Actor {
    pub id: AccountId,
    pub signer: InMemorySigner,
    pub near: Near,
}

/// A transaction's outcome, with its receipts and the `extents-objective`
/// events it emitted.
pub struct Outcome {
    pub inner: FinalExecutionOutcome,
    pub receipts: Vec<Receipt>,
    pub events: Vec<Value>,
}

impl Outcome {
    /// Expects `inner` to come from `tx_status`, which includes receipt
    /// bodies.
    fn new(inner: FinalExecutionOutcome) -> Self {
        Self {
            receipts: outcome::receipts(&inner),
            events: outcome::events(&inner),
            inner,
        }
    }

    /// Receipts that call `method`.
    pub fn calls(&self, method: &str) -> Vec<&Receipt> {
        self.receipts
            .iter()
            .filter(|r| r.method.as_deref() == Some(method))
            .collect()
    }

    /// NEAR transferred to `account` by `Transfer` receipts, in yocto.
    pub fn transfers_to(&self, account: &AccountId) -> Vec<u128> {
        self.receipts
            .iter()
            .filter(|r| &r.executor == account)
            .filter_map(|r| r.transfer)
            .collect()
    }

    /// Whether the transaction's own result succeeded. Payout receipts can
    /// still fail independently.
    pub fn ok(&self) -> bool {
        self.inner.is_success()
    }

    /// The transaction's JSON return value, if any.
    pub fn value(&self) -> Option<Value> {
        self.inner
            .result()
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    pub fn error(&self) -> String {
        self.inner.failure_message().unwrap_or_default()
    }

    /// The `data` of each event of `kind`.
    pub fn events(&self, kind: &str) -> Vec<&Value> {
        self.events
            .iter()
            .filter(|e| e["event"] == kind)
            .map(|e| &e["data"])
            .collect()
    }

    /// Error messages of receipts that failed.
    pub fn failed_receipts(&self) -> Vec<String> {
        self.inner
            .receipts_outcome
            .iter()
            .filter_map(|r| r.outcome.status.failure().map(|e| format!("{e:?}")))
            .collect()
    }
}

/// A fresh sandbox with the Verifier, a test token, the objective's global
/// contract, and funded accounts.
pub struct Env {
    pub sandbox: Sandbox,
    root: Near,
    pub verifier: AccountId,
    /// The test token's id inside the Verifier, e.g. `nep141:ft.sandbox`.
    pub token: String,
    /// Holds the Verifier's account lock and unlock roles.
    pub operator: Actor,
    pub sponsor: Actor,
    pub evaluator: Actor,
    pub contributors: Vec<Actor>,
    /// Closes objectives as a third party.
    pub closer: Actor,
    code_hash: [u8; 32],
}

impl Env {
    pub async fn new(contributors: usize) -> Result<Self> {
        let sandbox = SandboxConfig::fresh().await?;
        let root = sandbox.client();
        let root_id = sandbox.root_account_id().clone();
        let account =
            |name: &str| -> Result<AccountId> { Ok(format!("{name}.{root_id}").parse()?) };

        let verifier =
            create_account(&root, account("verifier")?, NearToken::from_near(20)).await?;
        let ft = create_account(&root, account("ft")?, NearToken::from_near(5)).await?;
        let operator = create_account(&root, account("operator")?, NearToken::from_near(5)).await?;
        let sponsor = create_account(&root, account("sponsor")?, NearToken::from_near(5)).await?;
        let evaluator =
            create_account(&root, account("evaluator")?, NearToken::from_near(5)).await?;
        let closer = create_account(&root, account("closer")?, NearToken::from_near(5)).await?;
        let mut actors = Vec::with_capacity(contributors);
        for i in 0..contributors {
            actors.push(
                create_account(&root, account(&format!("c{i}"))?, NearToken::from_near(5)).await?,
            );
        }

        let roles = [operator.id.clone()];
        expect_ok(
            "deploy Verifier",
            verifier
                .near
                .transaction(verifier.id.clone())
                .deploy(VERIFIER.code().await?)
                .call("new")
                .args(json!({ "config": {
                    "wnear_id": account("wnear")?,
                    "fees": { "fee": 0, "fee_collector": verifier.id },
                    "roles": { "grantees": {
                        "UnrestrictedAccountLocker": roles,
                        "UnrestrictedAccountUnlocker": roles,
                    } },
                } }))
                .gas(MAX_GAS)
                .send()
                .wait_until::<Final>()
                .await?,
        )?;
        expect_ok(
            "deploy token",
            ft.near
                .transaction(ft.id.clone())
                .deploy(FUNGIBLE_TOKEN.code().await?)
                .call("new_default_meta")
                .args(json!({ "owner_id": sponsor.id, "total_supply": SPONSOR_FUNDS.to_string() }))
                .gas(CALL_GAS)
                .send()
                .wait_until::<Final>()
                .await?,
        )?;
        call(
            &sponsor,
            &ft.id,
            "storage_deposit",
            json!({ "account_id": verifier.id }),
            CALL_GAS,
            NearToken::from_millinear(125),
        )
        .await
        .and_then(|o| expect_ok("register Verifier on token", o.inner))?;
        // An empty `msg` credits the sender on the Verifier.
        call(
            &sponsor,
            &ft.id,
            "ft_transfer_call",
            json!({ "receiver_id": verifier.id, "amount": SPONSOR_FUNDS.to_string(), "msg": "" }),
            CALL_GAS,
            ONE_YOCTO,
        )
        .await
        .and_then(|o| expect_ok("deposit token to Verifier", o.inner))?;

        let code_hash = publish(&root, "objective", objective_wasm()?).await?;

        Ok(Self {
            sandbox,
            root,
            token: format!("nep141:{}", ft.id),
            verifier: verifier.id,
            operator,
            sponsor,
            evaluator,
            contributors: actors,
            closer,
            code_hash,
        })
    }

    /// The latest final block's timestamp.
    pub async fn now(&self) -> Result<Timestamp> {
        let block = self
            .root
            .rpc()
            .block(BlockReference::Finality(Finality::Final))
            .await?;
        Timestamp::from_nanos(block.header.timestamp.into()).context("timestamp out of range")
    }

    /// Params for an objective over the test token, with `shares` in pips by
    /// contributor index.
    pub fn params(&self, shares: &[(usize, u32)], deadline: Timestamp) -> Result<Params> {
        Ok(Params {
            sponsor: self.sponsor.id.as_str().parse()?,
            token: format!("nep245:{}:{}", self.verifier, self.token).parse::<TokenId>()?,
            evaluator: self.evaluator.id.as_str().parse()?,
            contributors: shares
                .iter()
                .map(|&(i, pips)| {
                    Ok((
                        self.contributors[i].id.as_str().parse()?,
                        Pips::from_pips(pips).context("share out of range")?,
                    ))
                })
                .collect::<Result<_>>()?,
            backups: std::collections::BTreeMap::new(),
            deadline,
            commit_by: None,
            acceptance_window_secs: None,
            spec_hash: [0; 32],
            auth_caller: None,
            salt: rand::random(),
        })
    }

    /// Deploys an instance with no deposit, at the id derived from `params`.
    pub async fn deploy(&self, params: &Params) -> Result<Objective> {
        self.deploy_with_deposit(params, NearToken::ZERO)
            .await
            .map(|(objective, _)| objective)
    }

    /// Deploys an instance, attaching `deposit` to its `StateInit`.
    pub async fn deploy_with_deposit(
        &self,
        params: &Params,
        deposit: NearToken,
    ) -> Result<(Objective, Outcome)> {
        let objective = self.objective(params)?;
        let outcome = self.launch(&self.sponsor, &objective, deposit).await?;
        Ok((objective, outcome))
    }

    /// The objective `params` derive, whether or not it is deployed.
    pub fn objective(&self, params: &Params) -> Result<Objective> {
        Objective::new(params.clone(), self.code_hash)
    }

    /// Deploys `objective` as `actor`, attaching `deposit` to its
    /// `StateInit`. Launching needs no role.
    pub async fn launch(
        &self,
        actor: &Actor,
        objective: &Objective,
        deposit: NearToken,
    ) -> Result<Outcome> {
        self.state_init(actor, objective.state_init(), deposit)
            .await
    }

    /// Creates the account `state_init` derives, as `actor`.
    pub async fn state_init(
        &self,
        actor: &Actor,
        state_init: StateInit,
        deposit: NearToken,
    ) -> Result<Outcome> {
        let outcome = send(actor, actor.near.state_init(state_init, deposit)).await?;
        ensure!(outcome.ok(), "state init: {}", outcome.error());
        Ok(outcome)
    }

    /// Publishes `code` as an immutable global contract, and returns the
    /// hash it is deployed by.
    pub async fn publish(&self, name: &str, code: Vec<u8>) -> Result<[u8; 32]> {
        publish(&self.root, name, code).await
    }

    /// Sends `amount` of NEAR from `from` to `to`.
    pub async fn transfer(
        &self,
        from: &Actor,
        to: &AccountId,
        amount: NearToken,
    ) -> Result<Outcome> {
        send(from, from.near.transaction(to.clone()).transfer(amount)).await
    }

    /// `None` if the account does not exist.
    pub async fn near_balance(&self, account: &AccountId) -> Result<Option<u128>> {
        if !self.exists(account).await? {
            return Ok(None);
        }
        Ok(Some(
            self.root
                .account(account.clone())
                .await?
                .amount
                .as_yoctonear(),
        ))
    }

    /// Registers `actor`'s key on the Verifier, so it can sign intents.
    pub async fn register_key(&self, actor: &Actor) -> Result<()> {
        let outcome = send_call(
            actor,
            &client::add_public_key(&self.verifier, &actor.signer.public_key().to_string()),
        )
        .await?;
        ensure!(outcome.ok(), "add_public_key: {}", outcome.error());
        Ok(())
    }

    /// Signs, as `actor`, an `auth_call` intent carrying `action` to
    /// `objective`, expiring [`INTENT_TTL`] after the current block time.
    pub async fn sign_auth_call(
        &self,
        actor: &Actor,
        objective: &Objective,
        action: Action,
    ) -> Result<Value> {
        self.sign_intents(actor, &[objective.auth_call(action)])
            .await
    }

    /// Signs `intents` as `actor`, expiring [`INTENT_TTL`] after the current
    /// block time.
    pub async fn sign_intents(&self, actor: &Actor, intents: &[Value]) -> Result<Value> {
        let salt: String = self
            .root
            .view(self.verifier.clone(), "current_salt")
            .await?;
        Payload::new(
            &actor.id,
            &self.verifier,
            &salt,
            self.now().await? + INTENT_TTL,
            intents,
        )?
        .sign(&actor.signer)
        .await
    }

    /// Relays signed intents to `execute_intents`, from `closer`.
    pub async fn execute_intents(&self, signed: &[Value]) -> Result<Outcome> {
        send_call(
            &self.closer,
            &client::execute_intents(&self.verifier, signed),
        )
        .await
    }

    /// The sponsor's `mt_transfer_call` of `amount` into `objective`.
    pub async fn fund(&self, objective: &Objective, amount: u128) -> Result<Outcome> {
        send_call(&self.sponsor, &objective.fund(amount)).await
    }

    pub async fn commit(&self, contributor: &Actor, objective: &Objective) -> Result<Outcome> {
        send_call(contributor, &objective.commit()).await
    }

    /// Commits and delivers as `contributor`, as an achieved verdict
    /// requires of every slot. The delivery is the hash of its account id.
    pub async fn take_part(&self, contributor: &Actor, objective: &Objective) -> Result<()> {
        let commit = self.commit(contributor, objective).await?;
        ensure!(
            commit.ok(),
            "commit by {}: {}",
            contributor.id,
            commit.error()
        );
        let hash = Sha256::digest(contributor.id.as_bytes()).into();
        let deliver = self.deliver(contributor, objective, hash).await?;
        ensure!(
            deliver.ok(),
            "deliver by {}: {}",
            contributor.id,
            deliver.error()
        );
        Ok(())
    }

    /// Records `contributor`'s delivery of the work hashed as `hash`.
    pub async fn deliver(
        &self,
        contributor: &Actor,
        objective: &Objective,
        hash: [u8; 32],
    ) -> Result<Outcome> {
        send_call(contributor, &objective.deliver(&Delivery { hash })).await
    }

    /// The objective's last moment to attest: `Params::deadline`, extended by
    /// an acceptance window once every contributor has delivered.
    pub async fn attest_by(&self, objective: &Objective) -> Result<Timestamp> {
        let state = self.state(objective.account()).await?;
        Ok(serde_json::from_value(state["deadline"].clone())?)
    }

    /// The evaluator's `ob_attest`, with exactly `Params::attest_gas`, so
    /// every attestation in the suite tests that rule.
    pub async fn attest(&self, objective: &Objective, attestation: Attestation) -> Result<Outcome> {
        send_call(&self.evaluator, &objective.attest(&attestation)).await
    }

    pub async fn close(&self, objective: &Objective) -> Result<Outcome> {
        send_call(&self.closer, &objective.close()).await
    }

    /// Locks `account` on the Verifier, as its operator: it can still
    /// receive, but transfers from it fail.
    pub async fn lock(&self, account: &AccountId) -> Result<Outcome> {
        self.operator_call("force_lock_account", json!({ "account_id": account }))
            .await
    }

    pub async fn unlock(&self, account: &AccountId) -> Result<Outcome> {
        self.operator_call("force_unlock_account", json!({ "account_id": account }))
            .await
    }

    async fn operator_call(&self, method: &str, args: Value) -> Result<Outcome> {
        let outcome = call(
            &self.operator,
            &self.verifier,
            method,
            args,
            CALL_GAS,
            ONE_YOCTO,
        )
        .await?;
        ensure!(outcome.ok(), "{method}: {}", outcome.error());
        Ok(outcome)
    }

    /// `account`'s balance of the test token on the Verifier.
    pub async fn mt_balance(&self, account: &AccountId) -> Result<u128> {
        self.mt_balance_of(account, &self.token).await
    }

    /// `account`'s balance on the Verifier of `token`, a Verifier token id.
    pub async fn mt_balance_of(&self, account: &AccountId, token: &str) -> Result<u128> {
        let balance: String = self
            .root
            .view(self.verifier.clone(), "mt_balance_of")
            .args(json!({ "account_id": account, "token_id": token }))
            .await?;
        Ok(balance.parse()?)
    }

    /// The objective's `ob_view`.
    pub async fn state(&self, objective: &AccountId) -> Result<Value> {
        self.view(objective, "ob_view").await
    }

    /// The result of `account`'s view method `method`, called with no
    /// arguments.
    pub async fn view(&self, account: &AccountId, method: &str) -> Result<Value> {
        Ok(self.root.view(account.clone(), method).await?)
    }

    pub async fn exists(&self, account: &AccountId) -> Result<bool> {
        Ok(self.root.account_exists(account.clone()).await?)
    }

    /// Produces `blocks` empty blocks.
    pub async fn fast_forward(&self, blocks: u64) -> Result<()> {
        Ok(self.sandbox.fast_forward(blocks).await?)
    }

    /// Produces empty blocks until block time is past `deadline`.
    pub async fn fast_forward_past(&self, deadline: Timestamp) -> Result<()> {
        tokio::time::timeout(Duration::from_mins(15), async {
            let mut now = self.now().await?;
            while now <= deadline {
                self.fast_forward(FAST_FORWARD_STEP).await?;
                let next = self.now().await?;
                ensure!(
                    next > now,
                    "sandbox fast-forward did not advance final block time"
                );
                now = next;
            }
            Ok(())
        })
        .await
        .with_context(|| format!("sandbox did not reach {deadline:?} within 15 minutes"))?
    }

    /// An implicit account: the hex of a fresh key's public key, created by a
    /// plain transfer to it, as wallets and agents create theirs.
    pub async fn implicit_actor(&self, balance: NearToken) -> Result<Actor> {
        let key = SecretKey::generate_ed25519();
        let public_key = key.public_key();
        let id: AccountId = hex::encode(
            public_key
                .as_ed25519_bytes()
                .context("generated key is not ed25519")?,
        )
        .parse()?;
        expect_ok(
            &format!("create implicit {id}"),
            self.root
                .transfer(id.clone(), balance)
                .wait_until::<Final>()
                .await?,
        )?;
        let signer = InMemorySigner::from_secret_key(id.clone(), key)?;
        Ok(Actor {
            near: self.root.with_signer(signer.clone()),
            signer,
            id,
        })
    }

    /// A Sputnik DAO running mainnet's agency DAO code ([`SPUTNIK_DAO`]),
    /// whose `council` must all approve (half plus one of two), with a
    /// 0.1 NEAR proposal bond.
    pub async fn new_dao(&self, name: &str, council: &[&Actor]) -> Result<AccountId> {
        let dao = create_account(
            &self.root,
            format!("{name}.{}", self.sandbox.root_account_id()).parse()?,
            NearToken::from_near(10),
        )
        .await?;
        let council: Vec<AccountId> = council.iter().map(|a| a.id.clone()).collect();
        expect_ok(
            &format!("deploy DAO {}", dao.id),
            dao.near
                .transaction(dao.id.clone())
                .deploy(SPUTNIK_DAO.code().await?)
                .call("new")
                .args(json!({
                    "config": { "name": name, "purpose": "extents sandbox", "metadata": "" },
                    "policy": client::council_policy(&council, DAO_PROPOSAL_BOND, DAO_PROPOSAL_PERIOD),
                }))
                .gas(MAX_GAS)
                .send()
                .wait_until::<Final>()
                .await?,
        )?;
        Ok(dao.id)
    }

    /// An NFT contract ([`NON_FUNGIBLE_TOKEN`]) that only `owner` mints from.
    pub async fn new_nft(&self, name: &str, owner: &AccountId) -> Result<AccountId> {
        let nft = create_account(
            &self.root,
            format!("{name}.{}", self.sandbox.root_account_id()).parse()?,
            NearToken::from_near(5),
        )
        .await?;
        expect_ok(
            &format!("deploy NFT {}", nft.id),
            nft.near
                .transaction(nft.id.clone())
                .deploy(NON_FUNGIBLE_TOKEN.code().await?)
                .call("new_default_meta")
                .args(json!({ "owner_id": owner }))
                .gas(CALL_GAS)
                .send()
                .wait_until::<Final>()
                .await?,
        )?;
        Ok(nft.id)
    }

    /// As `owner` of the NFT contract `nft`, mints `token_id` and deposits
    /// it into the Verifier for `to`, as the token [`nep171`] names.
    pub async fn deposit_nft(
        &self,
        owner: &Actor,
        nft: &AccountId,
        token_id: &str,
        to: &AccountId,
    ) -> Result<()> {
        call(
            owner,
            nft,
            "nft_mint",
            json!({ "token_id": token_id, "token_owner_id": owner.id, "token_metadata": {} }),
            CALL_GAS,
            NearToken::from_millinear(100),
        )
        .await
        .and_then(|o| expect_ok("mint NFT", o.inner))?;
        // A `msg` naming an account credits it on the Verifier.
        call(
            owner,
            nft,
            "nft_transfer_call",
            json!({ "receiver_id": self.verifier, "token_id": token_id, "msg": to }),
            CALL_GAS,
            ONE_YOCTO,
        )
        .await
        .and_then(|o| expect_ok("deposit NFT to Verifier", o.inner))
    }

    /// Has `dao` make one function call, as an agency does: `council[0]`
    /// files a `FunctionCall` proposal and every member approves it. Returns
    /// the executing transaction, the last vote's.
    pub async fn dao_call(
        &self,
        dao: &AccountId,
        council: &[&Actor],
        request: &Call,
    ) -> Result<Outcome> {
        let kind = request.proposal_kind();
        let description = format!("{} on {}", request.method, request.receiver);
        let proposer = council.first().context("empty council")?;
        let filed = send_call(
            proposer,
            &client::add_proposal(dao, &description, &kind, DAO_PROPOSAL_BOND),
        )
        .await?;
        ensure!(filed.ok(), "add_proposal: {}", filed.error());
        let id = filed
            .value()
            .and_then(|v| v.as_u64())
            .context("add_proposal returned no id")?;
        let mut executing = None;
        for member in council {
            let vote = send_call(member, &client::vote(dao, id, &kind, Vote::Approve)).await?;
            ensure!(vote.ok(), "vote by {}: {}", member.id, vote.error());
            executing = Some(vote);
        }
        executing.context("empty council")
    }
}

/// The Verifier's token id for `token_id` of the NFT contract `nft`.
pub fn nep171(nft: &AccountId, token_id: &str) -> String {
    format!("nep171:{nft}:{token_id}")
}

async fn publish(root: &Near, name: &str, code: Vec<u8>) -> Result<[u8; 32]> {
    let code_hash: [u8; 32] = Sha256::digest(&code).into();
    // The evidence names the exact build each test ran.
    println!("{name} wasm sha256 {}", hex::encode(code_hash));
    expect_ok(
        &format!("publish {name}"),
        root.publish(code, PublishMode::Immutable)
            .wait_until::<Final>()
            .await?,
    )?;
    Ok(code_hash)
}

async fn create_account(root: &Near, id: AccountId, balance: NearToken) -> Result<Actor> {
    let key = SecretKey::generate_ed25519();
    expect_ok(
        &format!("create {id}"),
        root.transaction(id.clone())
            .create_account()
            .transfer(balance)
            .add_full_access_key(key.public_key())
            .send()
            .wait_until::<Final>()
            .await?,
    )?;
    let signer = InMemorySigner::from_secret_key(id.clone(), key)?;
    Ok(Actor {
        near: root.with_signer(signer.clone()),
        signer,
        id,
    })
}

/// Sends a function call and waits for every receipt, returning the outcome
/// whether or not it succeeded.
pub async fn call(
    actor: &Actor,
    receiver: &AccountId,
    method: &str,
    args: Value,
    gas: Gas,
    deposit: NearToken,
) -> Result<Outcome> {
    let tx = actor
        .near
        .call(receiver.clone(), method)
        .args(args)
        .gas(gas)
        .deposit(deposit)
        .finish();
    send(actor, tx).await
}

/// Sends `call` as `actor`.
pub async fn send_call(actor: &Actor, call: &Call) -> Result<Outcome> {
    self::call(
        actor,
        &call.receiver,
        call.method,
        call.args.clone(),
        call.gas,
        call.deposit,
    )
    .await
}

/// Sends `tx` as `actor` and returns its full outcome, receipts included.
async fn send(actor: &Actor, tx: TransactionBuilder) -> Result<Outcome> {
    let sent = tx.wait_until::<Final>().await?;
    let full = actor
        .near
        .tx_status(sent.transaction_hash(), actor.id.clone())
        .wait_until::<Final>()
        .await?;
    Ok(Outcome::new(full))
}

fn expect_ok(what: &str, outcome: FinalExecutionOutcome) -> Result<()> {
    if let Some(err) = outcome.failure_message() {
        bail!("{what}: {err}");
    }
    let failed = Outcome::new(outcome).failed_receipts();
    ensure!(failed.is_empty(), "{what}: receipts failed: {failed:?}");
    Ok(())
}

fn workspace() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn sha256_hex(code: &[u8]) -> String {
    hex::encode(Sha256::digest(code))
}

impl Pinned {
    /// The code, from the cache or else the first source serving it.
    pub async fn code(&self) -> Result<Vec<u8>> {
        let path = workspace().join(format!("target/sandbox/{}-{}.wasm", self.name, self.sha256));
        if let Ok(code) = fs::read(&path)
            && sha256_hex(&code) == self.sha256
        {
            return Ok(code);
        }
        for source in self.sources {
            let Ok(code) = source.fetch().await else {
                continue;
            };
            if sha256_hex(&code) == self.sha256 {
                fs::create_dir_all(path.parent().unwrap_or(&workspace()))?;
                fs::write(&path, &code)?;
                return Ok(code);
            }
        }
        bail!("no source served {} with sha256 {}", self.name, self.sha256)
    }
}

impl Source {
    async fn fetch(&self) -> Result<Vec<u8>> {
        Ok(match *self {
            Self::Account {
                rpc,
                chain_id,
                account,
            } => {
                Near::custom(rpc, chain_id)
                    .build()
                    .contract_code(account)
                    .await?
                    .code
            }
            Self::Url(url) => reqwest::get(url)
                .await?
                .error_for_status()?
                .bytes()
                .await?
                .to_vec(),
        })
    }
}

/// The objective's wasm: `EXTENTS_OBJECTIVE_WASM` if set, e.g. the exact
/// artifact to publish, or else the local build's output.
fn objective_wasm() -> Result<Vec<u8>> {
    local_wasm(
        "EXTENTS_OBJECTIVE_WASM",
        "target/near/extents_objective/extents_objective.wasm",
        "contracts/objective",
    )
}

/// The Intents repository's `escrow-swap` contract.
///
/// It has no published build: this reads `EXTENTS_ESCROW_SWAP_WASM` if set,
/// or else `target/sandbox/defuse_escrow_swap.wasm`, built from the commit
/// the `defuse-*` dependencies pin.
pub fn escrow_swap_wasm() -> Result<Vec<u8>> {
    local_wasm(
        "EXTENTS_ESCROW_SWAP_WASM",
        "target/sandbox/defuse_escrow_swap.wasm",
        "contracts/escrow-swap of near/intents",
    )
}

/// The wasm at the path in the variable `var` if set, or else at `default`
/// in the workspace: a build of the crate at `source`.
fn local_wasm(var: &str, default: &str, source: &str) -> Result<Vec<u8>> {
    let path = std::env::var_os(var).map_or_else(|| workspace().join(default), PathBuf::from);
    fs::read(&path).with_context(|| {
        format!(
            "reading {}; build it first: (cd {source} && cargo near build \
             non-reproducible-wasm --locked --features=contract --abi-features=abi,contract)",
            path.display()
        )
    })
}
