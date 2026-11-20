//! The sponsor releasing the payment itself, without the evaluator: an
//! achieved verdict from the sponsor, under the evaluator's conditions,
//! resolves as `released` and pays the split through the Verifier.

use std::time::Duration;

use anyhow::Result;
use extents_client::objective::Objective;
use extents_objective::{Attestation, Verdict, auth_call::Action};
use extents_sandbox::{Env, Outcome, send_call};

/// Not divisible by 70/30, so the split leaves a remainder for the sponsor.
const AMOUNT: u128 = 1_000_009;
const SEVENTY_THIRTY: &[(usize, u32)] = &[(0, 700_000), (1, 300_000)];

/// A funded objective with a ten-minute deadline, both contributors
/// committed but neither delivered.
async fn committed(env: &Env, auth_call: bool, sponsor_evaluates: bool) -> Result<Objective> {
    let mut params = env.params(SEVENTY_THIRTY, env.now().await? + Duration::from_mins(10))?;
    if auth_call {
        params.auth_caller = Some(env.verifier.as_str().parse()?);
    }
    if sponsor_evaluates {
        params.evaluator = params.sponsor.clone();
    }
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, AMOUNT).await?.ok());
    for contributor in &env.contributors {
        assert!(env.commit(contributor, &objective).await?.ok());
    }
    Ok(objective)
}

async fn deliver_all(env: &Env, objective: &Objective) -> Result<()> {
    for (contributor, hash) in env.contributors.iter().zip([[1; 32], [2; 32]]) {
        assert!(env.deliver(contributor, objective, hash).await?.ok());
    }
    Ok(())
}

/// The sponsor's own attestation.
async fn sponsor_attests(env: &Env, objective: &Objective, verdict: Verdict) -> Result<Outcome> {
    send_call(&env.sponsor, &objective.attest(&Attestation::from(verdict))).await
}

/// `outcome` resolved the objective as `expected` and paid 70/30, with the
/// remainder to the sponsor.
async fn assert_paid(
    env: &Env,
    objective: &Objective,
    outcome: &Outcome,
    expected: &str,
    sponsor_before: u128,
) -> Result<()> {
    let resolved = outcome.events("resolved");
    assert_eq!(resolved.len(), 1, "{:?}", outcome.failed_receipts());
    assert_eq!(resolved[0]["outcome"], expected);
    assert_eq!(env.mt_balance(&env.contributors[0].id).await?, 700_006);
    assert_eq!(env.mt_balance(&env.contributors[1].id).await?, 300_002);
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, sponsor_before + 1);
    assert_eq!(env.mt_balance(objective.account()).await?, 0);
    Ok(())
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn sponsor_releases_once_every_slot_delivered() -> Result<()> {
    let env = Env::new(2).await?;
    let objective = committed(&env, false, false).await?;

    let early = sponsor_attests(&env, &objective, Verdict::Achieved).await?;
    assert!(
        early
            .error()
            .contains("not all contributors have delivered"),
        "{}",
        early.error()
    );

    deliver_all(&env, &objective).await?;
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let released = sponsor_attests(&env, &objective, Verdict::Achieved).await?;
    assert!(released.ok(), "{}", released.error());
    assert_paid(&env, &objective, &released, "released", sponsor_before).await?;

    let again = sponsor_attests(&env, &objective, Verdict::Achieved).await?;
    assert!(
        again.error().contains("already resolved"),
        "{}",
        again.error()
    );
    Ok(())
}

/// Only the evaluator can fail an objective: the sponsor cannot take its
/// money back by declaring the work failed.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn sponsor_can_never_attest_failed() -> Result<()> {
    let env = Env::new(2).await?;
    let objective = committed(&env, false, false).await?;
    deliver_all(&env, &objective).await?;

    let refused = sponsor_attests(&env, &objective, Verdict::Failed).await?;
    assert!(
        refused.error().contains("unauthorized"),
        "{}",
        refused.error()
    );
    assert_eq!(env.mt_balance(objective.account()).await?, AMOUNT);
    Ok(())
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn sponsor_releases_by_signed_intent() -> Result<()> {
    let env = Env::new(2).await?;
    let objective = committed(&env, true, false).await?;
    deliver_all(&env, &objective).await?;

    env.register_key(&env.sponsor).await?;
    let signed = env
        .sign_auth_call(
            &env.sponsor,
            &objective,
            Action::Attest(Attestation::from(Verdict::Achieved)),
        )
        .await?;
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let released = env.execute_intents(&[signed]).await?;
    assert!(released.ok(), "{}", released.error());
    assert_paid(&env, &objective, &released, "released", sponsor_before).await
}

/// A sponsor that is also the evaluator attests as the evaluator.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn a_sponsor_who_evaluates_attests_as_the_evaluator() -> Result<()> {
    let env = Env::new(2).await?;
    let objective = committed(&env, false, true).await?;
    deliver_all(&env, &objective).await?;

    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let achieved = sponsor_attests(&env, &objective, Verdict::Achieved).await?;
    assert!(achieved.ok(), "{}", achieved.error());
    assert_paid(&env, &objective, &achieved, "achieved", sponsor_before).await
}
