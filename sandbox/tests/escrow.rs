//! A fact as a token, paid from an escrow. The Intents repository's
//! `escrow-swap` contract locks the sponsor's payment at an address its
//! params derive and pays whoever sends it the token it names. Here that
//! token is an attester's proof (`tests/proof.rs`), so the payment is held
//! until the attester mints, with no evaluator's vote and no objective.
//!
//! The escrow has no published build: see the README for building it.

use std::time::Duration;

use anyhow::{Result, anyhow};
use defuse_escrow_swap::{ContractStorage, Params};
use extents_objective::Timestamp;
use extents_sandbox::{Actor, Env, Outcome, SPONSOR_FUNDS, call, escrow_swap_wasm, nep171};
use near_kit::{
    AccountId, CryptoHash, Gas, NearToken,
    protocol::{StateInit, StateInitExt},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// One proof buys all of it.
const AMOUNT: u128 = 1_000_000;
/// The proof's price in the payment token: one proof per [`AMOUNT`].
const PRICE: &str = "0.000001";
const GAS: Gas = Gas::from_tgas(300);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// The fact's token id: the hash of the spec it was judged against.
fn fact() -> String {
    hex::encode(Sha256::digest(b"spec"))
}

/// An escrow of the sponsor's payment for one token.
struct Escrow {
    account: AccountId,
    state_init: StateInit,
    /// Its `Params`, which every call carries.
    params: Value,
    deadline: Timestamp,
}

impl Escrow {
    /// The escrow, under the global contract `code_hash`, that pays the
    /// sponsor's test token for `wanted`, a Verifier token id, until ten
    /// minutes from now. Not deployed.
    async fn new(env: &Env, code_hash: [u8; 32], wanted: &str) -> Result<Self> {
        let deadline = env.now().await? + Duration::from_mins(10);
        let params: Params = serde_json::from_value(json!({
            "maker": env.sponsor.id,
            "src_token": format!("nep245:{}:{}", env.verifier, env.token),
            "dst_token": format!("nep245:{}:{wanted}", env.verifier),
            "price": PRICE,
            "deadline": deadline,
            "salt": hex::encode(rand::random::<[u8; 32]>()),
        }))?;
        let data = ContractStorage::init_state(&params).map_err(|e| anyhow!("{e}"))?;
        let state_init = StateInit::by_hash(CryptoHash::from(code_hash), data);
        Ok(Self {
            account: state_init.derive_account_id(),
            state_init,
            params: serde_json::to_value(&params)?,
            deadline,
        })
    }

    /// `actor` sends `amount` of the Verifier token `token` to the escrow
    /// with `action`.
    async fn send(
        &self,
        env: &Env,
        actor: &Actor,
        token: &str,
        amount: u128,
        action: Value,
    ) -> Result<Outcome> {
        call(
            actor,
            &env.verifier,
            "mt_transfer_call",
            json!({
                "receiver_id": self.account,
                "token_id": token,
                "amount": amount.to_string(),
                "msg": json!({ "params": self.params, "action": action }).to_string(),
            }),
            GAS,
            ONE_YOCTO,
        )
        .await
    }

    /// The sponsor's funding with [`AMOUNT`].
    async fn fund(&self, env: &Env) -> Result<Outcome> {
        self.send(
            env,
            &env.sponsor,
            &env.token,
            AMOUNT,
            json!({ "action": "fund" }),
        )
        .await
    }

    /// `solver`'s fill with one `token`.
    async fn fill(&self, env: &Env, solver: &Actor, token: &str) -> Result<Outcome> {
        let deadline = env.now().await? + Duration::from_mins(5);
        let fill = json!({ "action": "fill", "data": { "price": PRICE, "deadline": deadline } });
        self.send(env, solver, token, 1, fill).await
    }

    async fn close(&self, actor: &Actor) -> Result<Outcome> {
        call(
            actor,
            &self.account,
            "es_close",
            json!({ "params": self.params }),
            GAS,
            NearToken::ZERO,
        )
        .await
    }
}

/// A sandbox with the evaluator's NFT contract as the issuer of proofs, and
/// a funded escrow of the sponsor's payment for the proof of [`fact`].
async fn setup() -> Result<(Env, AccountId, Escrow)> {
    let env = Env::new(1).await?;
    let issuer = env.new_nft("proofs", &env.evaluator.id).await?;
    let code_hash = env.publish("escrow-swap", escrow_swap_wasm()?).await?;
    let escrow = Escrow::new(&env, code_hash, &nep171(&issuer, &fact())).await?;
    env.state_init(&env.closer, escrow.state_init.clone(), NearToken::ZERO)
        .await?;
    let funded = escrow.fund(&env).await?;
    assert!(funded.ok(), "{}", funded.error());
    assert!(
        funded.failed_receipts().is_empty(),
        "{:?}",
        funded.failed_receipts()
    );
    assert_held(&env, &escrow).await?;
    Ok((env, issuer, escrow))
}

/// The escrow holds the payment, and the sponsor does not.
async fn assert_held(env: &Env, escrow: &Escrow) -> Result<()> {
    assert_eq!(env.mt_balance(&escrow.account).await?, AMOUNT);
    assert_eq!(
        env.mt_balance(&env.sponsor.id).await?,
        SPONSOR_FUNDS - AMOUNT
    );
    Ok(())
}

/// The sponsor funds the escrow before the proof exists and cannot take the
/// payment back. Once the attester mints the proof to the solver, the
/// solver's transfer of it to the escrow pays the solver and hands the
/// sponsor the proof.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn a_proof_fills_an_escrow_that_holds_the_payment() -> Result<()> {
    let (env, issuer, escrow) = setup().await?;
    let solver = &env.contributors[0];
    let proof = nep171(&issuer, &fact());

    let early = escrow.close(&env.sponsor).await?;
    assert!(early.error().contains("unauthorized"), "{}", early.error());
    assert_held(&env, &escrow).await?;

    env.deposit_nft(&env.evaluator, &issuer, &fact(), &solver.id)
        .await?;
    let filled = escrow.fill(&env, solver, &proof).await?;
    assert!(filled.ok(), "{}", filled.error());
    assert!(
        filled.failed_receipts().is_empty(),
        "{:?}",
        filled.failed_receipts()
    );
    assert_eq!(env.mt_balance(&solver.id).await?, AMOUNT);
    assert_eq!(env.mt_balance_of(&solver.id, &proof).await?, 0);
    assert_eq!(env.mt_balance_of(&env.sponsor.id, &proof).await?, 1);
    assert_eq!(env.mt_balance(&escrow.account).await?, 0);
    assert_eq!(env.mt_balance_of(&escrow.account, &proof).await?, 0);
    Ok(())
}

/// The same fact minted from the solver's own contract is refused and
/// returned. With no fill by the deadline, anyone closes the escrow and the
/// payment returns to the sponsor.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn without_the_named_proof_the_payment_returns_at_the_deadline() -> Result<()> {
    let (env, _, escrow) = setup().await?;
    let solver = &env.contributors[0];

    let own = env.new_nft("forged", &solver.id).await?;
    let forged = nep171(&own, &fact());
    env.deposit_nft(solver, &own, &fact(), &solver.id).await?;
    let refused = escrow.fill(&env, solver, &forged).await?;
    assert!(
        refused
            .failed_receipts()
            .iter()
            .any(|e| e.contains("wrong token")),
        "{:?}",
        refused.failed_receipts()
    );
    assert_eq!(env.mt_balance_of(&solver.id, &forged).await?, 1);
    assert_eq!(env.mt_balance(&solver.id).await?, 0);
    assert_held(&env, &escrow).await?;

    env.fast_forward_past(escrow.deadline).await?;
    let closed = escrow.close(&env.closer).await?;
    assert!(closed.ok(), "{}", closed.error());
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, SPONSOR_FUNDS);
    assert_eq!(env.mt_balance(&escrow.account).await?, 0);
    Ok(())
}
