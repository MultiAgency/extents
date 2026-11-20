//! The objective's lifecycle against the Verifier: the testnet e2e scenarios,
//! in a sandbox where deadlines are reached by producing blocks.

use std::time::Duration;

use anyhow::Result;
use extents_client::objective::Objective;
use extents_objective::{Attestation, Verdict, auth_call::Action};
use extents_sandbox::{Env, Receipt, call};
use near_kit::{Gas, NearToken};
use serde_json::json;

/// Not divisible by 10 or by 70/30, so every split leaves a remainder for the
/// sponsor.
const AMOUNT: u128 = 1_000_009;
const SEVENTY_THIRTY: &[(usize, u32)] = &[(0, 700_000), (1, 300_000)];
const REVIEW: [u8; 32] = [7; 32];

const fn achieved() -> Attestation {
    Attestation {
        verdict: Verdict::Achieved,
        review_hash: Some(REVIEW),
    }
}

/// A funded objective with a ten-minute deadline.
async fn funded(env: &Env, shares: &[(usize, u32)], auth_call: bool) -> Result<Objective> {
    let mut params = env.params(shares, env.now().await? + Duration::from_mins(10))?;
    if auth_call {
        params.auth_caller = Some(env.verifier.as_str().parse()?);
    }
    let objective = env.deploy(&params).await?;
    let fund = env.fund(&objective, AMOUNT).await?;
    assert!(fund.ok(), "{}", fund.error());
    assert_eq!(fund.events("funded").len(), 1);
    Ok(objective)
}

/// Every payout succeeded and attached exactly 1 yoctoNEAR.
fn assert_paid(payouts: &[&Receipt], count: usize) {
    assert_eq!(payouts.len(), count);
    assert!(
        payouts.iter().all(|r| r.ok && r.attached == 1),
        "{payouts:?}"
    );
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn achieved_pays_shares_from_a_zero_balance() -> Result<()> {
    let env = Env::new(2).await?;
    let (c0, c1) = (&env.contributors[0], &env.contributors[1]);
    let objective = funded(&env, SEVENTY_THIRTY, false).await?;
    assert_eq!(env.near_balance(objective.account()).await?, Some(0));

    let commit = env.commit(c0, &objective).await?;
    assert_eq!(commit.events("committed")[0]["contributor"], c0.id.as_str());

    let refused = env.attest(&objective, achieved()).await?;
    assert!(
        refused
            .error()
            .contains("not all contributors have committed"),
        "{}",
        refused.error()
    );

    assert!(env.commit(c1, &objective).await?.ok());
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let attest = env.attest(&objective, achieved()).await?;
    assert!(attest.ok(), "{}", attest.error());
    let resolved = attest.events("resolved");
    assert_eq!(resolved[0]["outcome"], "achieved");
    assert_eq!(resolved[0]["review_hash"], hex::encode(REVIEW));
    assert_paid(&attest.calls("mt_transfer"), 3);
    assert_eq!(
        attest.events("paid")[0]["amounts"],
        json!({ c0.id.as_str(): "700006", c1.id.as_str(): "300002", env.sponsor.id.as_str(): "1" })
    );
    assert_eq!(env.mt_balance(&c0.id).await?, 700_006);
    assert_eq!(env.mt_balance(&c1.id).await?, 300_002);
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, sponsor_before + 1);
    assert_eq!(env.mt_balance(objective.account()).await?, 0);
    // The 1 yoctoNEAR payout deposits were not deducted from a zero balance.
    assert_eq!(env.near_balance(objective.account()).await?, Some(0));

    env.fast_forward_past(objective.params().deadline).await?;
    let close = env.close(&objective).await?;
    assert_eq!(close.events("cleanup").len(), 1);
    assert!(!env.exists(objective.account()).await?);
    Ok(())
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn failed_returns_everything_to_the_sponsor() -> Result<()> {
    let env = Env::new(2).await?;
    let objective = funded(&env, SEVENTY_THIRTY, false).await?;
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;

    let attest = env
        .attest(
            &objective,
            Attestation {
                verdict: Verdict::Failed,
                review_hash: Some(REVIEW),
            },
        )
        .await?;
    assert!(attest.ok(), "{}", attest.error());
    assert_eq!(attest.events("resolved")[0]["outcome"], "failed");
    assert_paid(&attest.calls("mt_transfer"), 1);
    assert_eq!(
        env.mt_balance(&env.sponsor.id).await?,
        sponsor_before + AMOUNT
    );
    assert_eq!(env.mt_balance(&env.contributors[0].id).await?, 0);
    assert_eq!(env.mt_balance(objective.account()).await?, 0);
    Ok(())
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn expired_returns_funds_and_deletion_pays_the_closer() -> Result<()> {
    let env = Env::new(2).await?;
    let params = env.params(SEVENTY_THIRTY, env.now().await? + Duration::from_mins(10))?;

    // A StateInit deposit only covers missing storage stake, and an
    // instance needs none, so all of it is refunded to the signer.
    let surplus = NearToken::from_millinear(1);
    let (objective, deploy) = env.deploy_with_deposit(&params, surplus).await?;
    assert_eq!(env.near_balance(objective.account()).await?, Some(0));
    assert!(
        deploy
            .transfers_to(&env.sponsor.id)
            .contains(&surplus.as_yoctonear()),
        "{:?}",
        deploy.receipts
    );

    // NEAR sent by a plain transfer stays.
    let sent = env
        .transfer(&env.sponsor, objective.account(), surplus)
        .await?;
    assert!(sent.ok(), "{}", sent.error());
    assert_eq!(
        env.near_balance(objective.account()).await?,
        Some(surplus.as_yoctonear())
    );

    assert!(env.fund(&objective, AMOUNT).await?.ok());
    assert!(env.commit(&env.contributors[0], &objective).await?.ok());

    let early = env.close(&objective).await?;
    assert!(
        early.error().contains("deadline has not expired yet"),
        "{}",
        early.error()
    );

    env.fast_forward_past(params.deadline).await?;
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let close = env.close(&objective).await?;
    assert!(close.ok(), "{}", close.error());
    assert_eq!(close.events("resolved")[0]["outcome"], "expired");
    assert_paid(&close.calls("mt_transfer"), 1);
    assert_eq!(
        env.mt_balance(&env.sponsor.id).await?,
        sponsor_before + AMOUNT
    );

    // Settled past the deadline: the payout callback deletes the account in
    // the same transaction. With a non-zero balance the payout's yoctoNEAR is
    // deducted, and the rest goes to the closer.
    assert_eq!(close.events("cleanup").len(), 1);
    assert!(!env.exists(objective.account()).await?);
    assert!(
        close
            .transfers_to(&env.closer.id)
            .contains(&(surplus.as_yoctonear() - 1)),
        "{:?}",
        close.transfers_to(&env.closer.id)
    );
    Ok(())
}

/// How an account without its own NEAR transactions, such as a DAO's derived
/// account, funds an objective: a signed `transfer` intent whose `msg` makes
/// the Verifier call the objective's `mt_on_transfer` with the signer as
/// sender. Anyone else's funding is refused and refunded by the Verifier.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn fund_by_signed_transfer_intent() -> Result<()> {
    let env = Env::new(2).await?;
    let params = env.params(SEVENTY_THIRTY, env.now().await? + Duration::from_mins(10))?;
    let objective = env.deploy(&params).await?;
    let fund_intent = objective.fund_intent(AMOUNT);

    // Not the sponsor: the objective refuses, and the Verifier refunds.
    let stranger = &env.contributors[0];
    let sent = call(
        &env.sponsor,
        &env.verifier,
        "mt_transfer",
        json!({ "receiver_id": stranger.id, "token_id": env.token, "amount": AMOUNT.to_string() }),
        Gas::from_tgas(30),
        NearToken::from_yoctonear(1),
    )
    .await?;
    assert!(sent.ok(), "{}", sent.error());
    env.register_key(stranger).await?;
    let signed = env
        .sign_intents(stranger, std::slice::from_ref(&fund_intent))
        .await?;
    let refused = env.execute_intents(&[signed]).await?;
    assert!(refused.ok(), "{}", refused.error());
    assert!(refused.events("funded").is_empty());
    assert!(
        refused.calls("mt_on_transfer").iter().all(|r| !r.ok),
        "{:?}",
        refused.calls("mt_on_transfer")
    );
    assert_eq!(env.mt_balance(&stranger.id).await?, AMOUNT);
    assert_eq!(env.mt_balance(objective.account()).await?, 0);

    // The sponsor: funded.
    env.register_key(&env.sponsor).await?;
    let signed = env.sign_intents(&env.sponsor, &[fund_intent]).await?;
    let funded = env.execute_intents(&[signed]).await?;
    assert!(funded.ok(), "{}", funded.error());
    let events = funded.events("funded");
    assert_eq!(events.len(), 1, "{:?}", funded.failed_receipts());
    assert_eq!(events[0]["funded"], AMOUNT.to_string());
    assert_eq!(env.mt_balance(objective.account()).await?, AMOUNT);
    assert_eq!(
        env.state(objective.account()).await?["funded"],
        AMOUNT.to_string()
    );
    Ok(())
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn commit_and_attest_by_signed_intent() -> Result<()> {
    let env = Env::new(2).await?;
    let objective = funded(&env, SEVENTY_THIRTY, true).await?;

    for contributor in &env.contributors {
        env.register_key(contributor).await?;
        let signed = env
            .sign_auth_call(contributor, &objective, Action::Commit)
            .await?;
        let outcome = env.execute_intents(&[signed]).await?;
        assert!(outcome.ok(), "{}", outcome.error());
        assert_eq!(
            outcome.events("committed")[0]["contributor"],
            contributor.id.as_str()
        );
    }

    env.register_key(&env.evaluator).await?;
    let signed = env
        .sign_auth_call(&env.evaluator, &objective, Action::Attest(achieved()))
        .await?;
    let outcome = env.execute_intents(&[signed]).await?;
    assert!(outcome.ok(), "{}", outcome.error());
    let resolved = outcome.events("resolved");
    assert_eq!(resolved[0]["outcome"], "achieved");
    assert_eq!(resolved[0]["review_hash"], hex::encode(REVIEW));
    assert_paid(&outcome.calls("mt_transfer"), 3);
    assert_eq!(env.mt_balance(&env.contributors[0].id).await?, 700_006);
    assert_eq!(env.mt_balance(&env.contributors[1].id).await?, 300_002);
    Ok(())
}

/// Ten contributors at 10% each: ten shares and the sponsor's remainder.
const TEN_TENTHS: &[(usize, u32)] = &[
    (0, 100_000),
    (1, 100_000),
    (2, 100_000),
    (3, 100_000),
    (4, 100_000),
    (5, 100_000),
    (6, 100_000),
    (7, 100_000),
    (8, 100_000),
    (9, 100_000),
];

async fn all_committed(env: &Env, auth_call: bool) -> Result<Objective> {
    let objective = funded(env, TEN_TENTHS, auth_call).await?;
    for contributor in &env.contributors {
        assert!(env.commit(contributor, &objective).await?.ok());
    }
    Ok(objective)
}

/// Eleven payouts each fit in their 15 Tgas, and the callback in its 10.
fn assert_eleven_payouts_fit(outcome: &extents_sandbox::Outcome) {
    let payouts = outcome.calls("mt_transfer");
    assert_paid(&payouts, 11);
    assert!(
        payouts
            .iter()
            .all(|r| r.gas == Gas::from_tgas(15) && r.burnt < r.gas),
        "{payouts:?}"
    );
    let callback = outcome.calls("ob_resolve_transfers");
    assert!(
        callback.len() == 1 && callback[0].ok && callback[0].burnt < callback[0].gas,
        "{callback:?}"
    );
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn ten_contributors_settle_in_one_transaction() -> Result<()> {
    let env = Env::new(10).await?;
    let objective = all_committed(&env, false).await?;

    let attest = env.attest(&objective, achieved()).await?;
    assert!(attest.ok(), "{}", attest.error());
    assert_eleven_payouts_fit(&attest);
    for contributor in &env.contributors {
        assert_eq!(env.mt_balance(&contributor.id).await?, 100_000);
    }
    assert_eq!(env.mt_balance(objective.account()).await?, 0);
    Ok(())
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn ten_contributors_settle_by_signed_intent() -> Result<()> {
    let env = Env::new(10).await?;
    let objective = all_committed(&env, true).await?;

    env.register_key(&env.evaluator).await?;
    let signed = env
        .sign_auth_call(&env.evaluator, &objective, Action::Attest(achieved()))
        .await?;
    let outcome = env.execute_intents(&[signed]).await?;
    assert!(outcome.ok(), "{}", outcome.error());
    // The Verifier forwards to `on_auth` all the gas it does not use, so
    // `min_gas` is only a floor.
    let on_auth = outcome.calls("on_auth");
    assert!(
        on_auth.len() == 1 && on_auth[0].ok && on_auth[0].gas > objective.attest(&achieved()).gas,
        "{on_auth:?}"
    );
    assert_eleven_payouts_fit(&outcome);
    for contributor in &env.contributors {
        assert_eq!(env.mt_balance(&contributor.id).await?, 100_000);
    }
    Ok(())
}
