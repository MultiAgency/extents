//! A fact as a token, settled as NEAR Intents settles a swap. An attester
//! owns an NFT contract and mints a token for a fact into the Verifier, where
//! it is the balance `nep171:<contract>:<fact>`. The sponsor signs a
//! `token_diff` paying for that balance, whoever holds it signs the opposite
//! one, and the Verifier applies both or neither.
//!
//! No objective takes part: the Verifier alone settles, and the sponsor's
//! signature locks nothing.

use anyhow::Result;
use extents_sandbox::{Actor, Env, Outcome, SPONSOR_FUNDS, call, nep171};
use near_kit::{AccountId, Gas, NearToken};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const AMOUNT: u128 = 1_000_009;
const GAS: Gas = Gas::from_tgas(100);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// The Verifier's error when the diffs it was given do not net to zero.
const UNMATCHED: &str = "invariant violated";
/// The Verifier's error when a signer lacks what its diff gives up.
const UNCOVERED: &str = "insufficient balance";

/// The fact's token id: the hash of the spec it was judged against.
fn fact() -> String {
    hex::encode(Sha256::digest(b"spec"))
}

/// The Verifier's id for the fact as minted by `issuer`.
fn proof(issuer: &AccountId) -> String {
    nep171(issuer, &fact())
}

/// A signed `token_diff` by `actor`.
async fn diff(env: &Env, actor: &Actor, deltas: &[(&str, i128)]) -> Result<Value> {
    let diff: serde_json::Map<String, Value> = deltas
        .iter()
        .map(|&(token, delta)| (token.to_owned(), delta.to_string().into()))
        .collect();
    env.sign_intents(actor, &[json!({ "intent": "token_diff", "diff": diff })])
        .await
}

/// The sponsor's offer: the payment for `proof`.
async fn offer(env: &Env, proof: &str) -> Result<Value> {
    diff(
        env,
        &env.sponsor,
        &[(&env.token, -AMOUNT.cast_signed()), (proof, 1)],
    )
    .await
}

/// `solver`'s fill: `proof` for the payment.
async fn fill(env: &Env, solver: &Actor, proof: &str) -> Result<Value> {
    diff(
        env,
        solver,
        &[(proof, -1), (&env.token, AMOUNT.cast_signed())],
    )
    .await
}

/// `owner` mints the fact from its contract `issuer` and deposits it into the
/// Verifier for `to`.
async fn attest(env: &Env, owner: &Actor, issuer: &AccountId, to: &AccountId) -> Result<()> {
    env.deposit_nft(owner, issuer, &fact(), to).await
}

/// A sandbox whose sponsor and solver can sign intents, with the evaluator's
/// NFT contract as the issuer of proofs.
async fn setup() -> Result<(Env, AccountId)> {
    let env = Env::new(1).await?;
    env.register_key(&env.sponsor).await?;
    env.register_key(&env.contributors[0]).await?;
    let issuer = env.new_nft("proofs", &env.evaluator.id).await?;
    Ok((env, issuer))
}

/// The Verifier failed the transaction for `reason`.
fn assert_refused(outcome: &Outcome, reason: &str) {
    assert!(!outcome.ok());
    assert!(outcome.error().contains(reason), "{}", outcome.error());
}

/// Nobody was paid, and `holder` still has the proof.
async fn assert_unsettled(env: &Env, holder: &AccountId, proof: &str) -> Result<()> {
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, SPONSOR_FUNDS);
    assert_eq!(env.mt_balance(holder).await?, 0);
    assert_eq!(env.mt_balance_of(holder, proof).await?, 1);
    assert_eq!(env.mt_balance_of(&env.sponsor.id, proof).await?, 0);
    Ok(())
}

/// The sponsor signs its offer before the proof exists. Once the attester
/// mints it to the solver, one transaction pays the solver and hands the
/// sponsor the proof.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn a_proof_swaps_for_the_payment_in_one_transaction() -> Result<()> {
    let (env, issuer) = setup().await?;
    let solver = &env.contributors[0];
    let proof = proof(&issuer);

    let offer = offer(&env, &proof).await?;
    attest(&env, &env.evaluator, &issuer, &solver.id).await?;
    assert_unsettled(&env, &solver.id, &proof).await?;

    let swapped = env
        .execute_intents(&[offer, fill(&env, solver, &proof).await?])
        .await?;
    assert!(swapped.ok(), "{}", swapped.error());
    assert_eq!(env.mt_balance(&solver.id).await?, AMOUNT);
    assert_eq!(
        env.mt_balance(&env.sponsor.id).await?,
        SPONSOR_FUNDS - AMOUNT
    );
    assert_eq!(env.mt_balance_of(&env.sponsor.id, &proof).await?, 1);
    assert_eq!(env.mt_balance_of(&solver.id, &proof).await?, 0);
    Ok(())
}

/// Either `token_diff` alone fails the transaction and stays unspent: the
/// same two then settle together.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn neither_half_of_a_swap_lands_alone() -> Result<()> {
    let (env, issuer) = setup().await?;
    let solver = &env.contributors[0];
    let proof = proof(&issuer);
    attest(&env, &env.evaluator, &issuer, &solver.id).await?;
    let offer = offer(&env, &proof).await?;
    let fill = fill(&env, solver, &proof).await?;

    for alone in [&offer, &fill] {
        let refused = env.execute_intents(std::slice::from_ref(alone)).await?;
        assert_refused(&refused, UNMATCHED);
        assert_unsettled(&env, &solver.id, &proof).await?;
    }

    let swapped = env.execute_intents(&[offer, fill]).await?;
    assert!(swapped.ok(), "{}", swapped.error());
    assert_eq!(env.mt_balance(&solver.id).await?, AMOUNT);
    Ok(())
}

/// The offer names its issuer. A solver without the proof cannot fill it, and
/// neither can the same fact minted from the solver's own contract.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn only_the_named_issuers_proof_fills_the_offer() -> Result<()> {
    let (env, issuer) = setup().await?;
    let solver = &env.contributors[0];
    let proof = proof(&issuer);
    let offer = offer(&env, &proof).await?;

    let unheld = fill(&env, solver, &proof).await?;
    let refused = env.execute_intents(&[offer.clone(), unheld]).await?;
    assert_refused(&refused, UNCOVERED);

    let own = env.new_nft("forged", &solver.id).await?;
    let forged = self::proof(&own);
    attest(&env, solver, &own, &solver.id).await?;
    assert_eq!(env.mt_balance_of(&solver.id, &forged).await?, 1);
    let refused = env
        .execute_intents(&[offer, fill(&env, solver, &forged).await?])
        .await?;
    assert_refused(&refused, UNMATCHED);
    assert_unsettled(&env, &solver.id, &forged).await
}

/// A signed offer is not an escrow. The sponsor moves its balance away after
/// the solver earned the proof, and the swap fails.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn a_signed_offer_locks_nothing() -> Result<()> {
    let (env, issuer) = setup().await?;
    let solver = &env.contributors[0];
    let proof = proof(&issuer);
    let offer = offer(&env, &proof).await?;
    attest(&env, &env.evaluator, &issuer, &solver.id).await?;

    let moved = call(
        &env.sponsor,
        &env.verifier,
        "mt_transfer",
        json!({
            "receiver_id": env.closer.id,
            "token_id": env.token,
            "amount": SPONSOR_FUNDS.to_string(),
        }),
        GAS,
        ONE_YOCTO,
    )
    .await?;
    assert!(moved.ok(), "{}", moved.error());

    let refused = env
        .execute_intents(&[offer, fill(&env, solver, &proof).await?])
        .await?;
    assert_refused(&refused, UNCOVERED);
    assert_eq!(env.mt_balance(&solver.id).await?, 0);
    assert_eq!(env.mt_balance_of(&solver.id, &proof).await?, 1);
    Ok(())
}

/// Why the proof is an NFT: the Verifier's source has an intent that mints a
/// token named after its signer, but the deployed build does not accept it.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn the_deployed_verifier_has_no_mint_intent() -> Result<()> {
    let (env, _) = setup().await?;
    env.register_key(&env.evaluator).await?;
    let mint = json!({
        "intent": "imt_mint",
        "receiver_id": env.contributors[0].id,
        "tokens": { fact(): "1" },
    });
    let signed = env.sign_intents(&env.evaluator, &[mint]).await?;
    let refused = env.execute_intents(&[signed]).await?;
    assert_refused(&refused, "unknown variant `imt_mint`");
    Ok(())
}
