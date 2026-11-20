//! An acceptance window decides what the evaluator's silence means once
//! every contributor has delivered: the last delivery extends the time to
//! attest, and silence then pays the contributors. Partial delivery expires.

use std::time::Duration;

use anyhow::Result;
use extents_client::objective::Objective;
use extents_objective::{Attestation, Params, Verdict};
use extents_sandbox::Env;
use serde_json::json;

const AMOUNT: u128 = 1_000_009;
const WINDOW: Duration = Duration::from_hours(2);

/// A funded objective with a ten-minute deadline and a two-hour window, both
/// contributors committed.
async fn committed(env: &Env) -> Result<(Objective, Params)> {
    let mut params = env.params(
        &[(0, 700_000), (1, 300_000)],
        env.now().await? + Duration::from_mins(10),
    )?;
    params.acceptance_window_secs = Some(u32::try_from(WINDOW.as_secs())?);
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, AMOUNT).await?.ok());
    for contributor in &env.contributors {
        assert!(env.commit(contributor, &objective).await?.ok());
    }
    Ok((objective, params))
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn silence_after_full_delivery_is_accepted() -> Result<()> {
    let env = Env::new(2).await?;
    let (objective, params) = committed(&env).await?;

    let first = env
        .deliver(&env.contributors[0], &objective, [1; 32])
        .await?;
    assert!(first.ok(), "{}", first.error());
    // One delivery of two leaves the time to attest at the deadline.
    assert_eq!(env.attest_by(&objective).await?, params.deadline);

    let last = env
        .deliver(&env.contributors[1], &objective, [2; 32])
        .await?;
    assert!(last.ok(), "{}", last.error());
    let attest_by = env.attest_by(&objective).await?;
    assert!(attest_by > params.deadline, "{attest_by:?}");
    let delivered = last.events("delivered");
    assert_eq!(delivered[0]["attest_by"], json!(attest_by));

    // Past the deadline but inside the window: contributors are done, the
    // evaluator still has time, and nobody can close.
    env.fast_forward_past(params.deadline).await?;
    let late = env
        .deliver(&env.contributors[0], &objective, [3; 32])
        .await?;
    assert!(
        late.error().contains("deadline has expired"),
        "{}",
        late.error()
    );
    // The window extends the time to attest, never the time to fund: the
    // objective refuses the sponsor, and the Verifier refunds.
    let refused = env.fund(&objective, 1).await?;
    assert!(refused.events("funded").is_empty());
    assert!(
        refused
            .failed_receipts()
            .iter()
            .any(|e| e.contains("deadline has expired")),
        "{:?}",
        refused.failed_receipts()
    );
    assert_eq!(env.mt_balance(objective.account()).await?, AMOUNT);
    let early = env.close(&objective).await?;
    assert!(
        early.error().contains("deadline has not expired yet"),
        "{}",
        early.error()
    );

    // Silence through the window: accepted, paid by shares, then deleted.
    env.fast_forward_past(attest_by).await?;
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let close = env.close(&objective).await?;
    assert!(close.ok(), "{}", close.error());
    let resolved = close.events("resolved");
    assert_eq!(resolved[0]["outcome"], "accepted");
    assert!(resolved[0].get("review_hash").is_none());
    assert_eq!(env.mt_balance(&env.contributors[0].id).await?, 700_006);
    assert_eq!(env.mt_balance(&env.contributors[1].id).await?, 300_002);
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, sponsor_before + 1);
    assert_eq!(close.events("cleanup").len(), 1);
    assert!(!env.exists(objective.account()).await?);
    Ok(())
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn the_evaluator_can_attest_inside_the_window() -> Result<()> {
    let env = Env::new(2).await?;
    let (objective, params) = committed(&env).await?;
    for (contributor, hash) in env.contributors.iter().zip([[1; 32], [2; 32]]) {
        assert!(env.deliver(contributor, &objective, hash).await?.ok());
    }

    // After the deadline, within the window, a failed verdict still counts.
    env.fast_forward_past(params.deadline).await?;
    assert!(env.now().await? < env.attest_by(&objective).await?);
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let attest = env
        .attest(&objective, Attestation::from(Verdict::Failed))
        .await?;
    assert!(attest.ok(), "{}", attest.error());
    assert_eq!(attest.events("resolved")[0]["outcome"], "failed");
    assert_eq!(
        env.mt_balance(&env.sponsor.id).await?,
        sponsor_before + AMOUNT
    );
    Ok(())
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn partial_delivery_expires() -> Result<()> {
    let env = Env::new(2).await?;
    let (objective, params) = committed(&env).await?;
    assert!(
        env.deliver(&env.contributors[0], &objective, [1; 32])
            .await?
            .ok()
    );

    // No window opened, so silence past the deadline expires the objective.
    env.fast_forward_past(params.deadline).await?;
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let close = env.close(&objective).await?;
    assert!(close.ok(), "{}", close.error());
    assert_eq!(close.events("resolved")[0]["outcome"], "expired");
    assert_eq!(
        env.mt_balance(&env.sponsor.id).await?,
        sponsor_before + AMOUNT
    );
    assert_eq!(env.mt_balance(&env.contributors[0].id).await?, 0);
    Ok(())
}
