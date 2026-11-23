//! Leaving early: the sponsor cancels while no slot is committed and takes
//! the funding back, and a slot's holder withdraws before delivering, which
//! empties the slot for the contributor or its backup to take again.

use std::time::Duration;

use anyhow::Result;
use extents_client::objective::Objective;
use extents_objective::{Verdict, auth_call::Action};
use extents_sandbox::{Actor, Env, Outcome, send_call};

const AMOUNT: u128 = 1_000_009;

/// A funded objective with a ten-minute deadline, nobody committed.
async fn funded(env: &Env, auth_call: bool) -> Result<Objective> {
    let mut params = env.params(
        &[(0, 700_000), (1, 300_000)],
        env.now().await? + Duration::from_mins(10),
    )?;
    if auth_call {
        params.auth_caller = Some(env.verifier.as_str().parse()?);
    }
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, AMOUNT).await?.ok());
    Ok(objective)
}

async fn cancel(env: &Env, objective: &Objective) -> Result<Outcome> {
    send_call(&env.sponsor, &objective.cancel()).await
}

async fn withdraw(actor: &Actor, objective: &Objective) -> Result<Outcome> {
    send_call(actor, &objective.withdraw()).await
}

fn assert_refused(outcome: &Outcome, message: &str) {
    assert!(outcome.error().contains(message), "{}", outcome.error());
}

/// The sponsor's refund: the whole amount back, the outcome `cancelled`, and
/// the objective closed to funding and commitment.
async fn assert_cancelled(
    env: &Env,
    objective: &Objective,
    outcome: &Outcome,
    sponsor_before: u128,
) -> Result<()> {
    assert!(outcome.ok(), "{}", outcome.error());
    let resolved = outcome.events("resolved");
    assert_eq!(resolved.len(), 1, "{:?}", outcome.failed_receipts());
    assert_eq!(resolved[0]["outcome"], "cancelled");
    assert_eq!(
        env.mt_balance(&env.sponsor.id).await?,
        sponsor_before + AMOUNT
    );
    assert_eq!(env.mt_balance(objective.account()).await?, 0);

    let refunded = env.mt_balance(&env.sponsor.id).await?;
    assert!(env.fund(objective, 1).await?.events("funded").is_empty());
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, refunded);
    assert_refused(
        &env.commit(&env.contributors[0], objective).await?,
        "already resolved",
    );
    Ok(())
}

/// docs/spec.md, "The sponsor may cancel until someone commits"; docs/spec.md, "One verdict"; docs/spec.md, "Payouts are exact"
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn sponsor_cancels_before_any_commitment() -> Result<()> {
    let env = Env::new(2).await?;
    let objective = funded(&env, false).await?;

    // Only the sponsor can cancel.
    let stranger = send_call(&env.contributors[0], &objective.cancel()).await?;
    assert_refused(&stranger, "unauthorized");

    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let cancelled = cancel(&env, &objective).await?;
    assert_cancelled(&env, &objective, &cancelled, sponsor_before).await
}

/// docs/spec.md, "The sponsor may cancel until someone commits"; docs/spec.md, "A holder may withdraw until it delivers"
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn a_commitment_locks_the_funding_until_it_is_withdrawn() -> Result<()> {
    let env = Env::new(2).await?;
    let c0 = &env.contributors[0];
    let objective = funded(&env, false).await?;

    assert_refused(
        &withdraw(c0, &objective).await?,
        "no commitment to withdraw",
    );
    assert!(env.commit(c0, &objective).await?.ok());
    assert_refused(
        &cancel(&env, &objective).await?,
        "a contributor has committed",
    );

    let withdrawn = withdraw(c0, &objective).await?;
    assert!(withdrawn.ok(), "{}", withdrawn.error());
    let events = withdrawn.events("withdrawn");
    assert_eq!(events.len(), 1, "{:?}", withdrawn.failed_receipts());
    assert_eq!(events[0]["contributor"], c0.id.as_str());

    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let cancelled = cancel(&env, &objective).await?;
    assert_cancelled(&env, &objective, &cancelled, sponsor_before).await
}

/// A slot emptied by withdrawal passes between the listed contributor and
/// its backup: whoever commits first holds it, only the holder can withdraw,
/// and nobody can withdraw after delivering. The holder at the verdict is
/// paid.
///
/// docs/spec.md, "A holder may withdraw until it delivers"; docs/spec.md, "Only the holder acts for a slot"; docs/spec.md, "A backup takes an empty slot only after commit-by"; docs/spec.md, "A delivery is final"; docs/spec.md, "Payouts are exact"
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn a_withdrawn_slot_passes_between_contributor_and_backup() -> Result<()> {
    let env = Env::new(3).await?;
    let (c0, c1, c2) = (
        &env.contributors[0],
        &env.contributors[1],
        &env.contributors[2],
    );
    // One fast-forward step passes `commit_by` with time to spare.
    let now = env.now().await?;
    let mut params = env.params(&[(0, 700_000), (1, 300_000)], now + Duration::from_mins(40))?;
    params.backups = [(c1.id.as_str().parse()?, c2.id.as_str().parse()?)].into();
    params.commit_by = Some(now + Duration::from_mins(2));
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, AMOUNT).await?.ok());

    // c1 commits, then leaves before commit_by; it may come back.
    assert!(env.commit(c1, &objective).await?.ok());
    assert!(withdraw(c1, &objective).await?.ok());
    assert!(env.commit(c1, &objective).await?.ok());
    assert!(withdraw(c1, &objective).await?.ok());

    // After commit_by the backup takes the empty slot; c1 can neither take
    // it back nor withdraw it.
    env.fast_forward_past(params.commit_by.unwrap_or(now))
        .await?;
    assert!(env.commit(c2, &objective).await?.ok());
    assert_refused(&env.commit(c1, &objective).await?, "already committed");
    assert_refused(&withdraw(c1, &objective).await?, "unauthorized");

    // Delivered work cannot be withdrawn.
    assert!(env.commit(c0, &objective).await?.ok());
    for (contributor, hash) in [(c0, [1; 32]), (c2, [2; 32])] {
        assert!(env.deliver(contributor, &objective, hash).await?.ok());
    }
    assert_refused(&withdraw(c2, &objective).await?, "already delivered");

    let c2_before = env.mt_balance(&c2.id).await?;
    let attest = env.attest(&objective, Verdict::Achieved.into()).await?;
    assert!(attest.ok(), "{}", attest.error());
    assert_eq!(env.mt_balance(&c2.id).await?, c2_before + 300_002);
    Ok(())
}

/// Withdrawal and cancellation by signed `auth_call` intent.
///
/// docs/spec.md, "The sponsor may cancel until someone commits"; docs/spec.md, "A holder may withdraw until it delivers"
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn withdraw_and_cancel_by_signed_intent() -> Result<()> {
    let env = Env::new(2).await?;
    let c0 = &env.contributors[0];
    let objective = funded(&env, true).await?;

    env.register_key(c0).await?;
    for action in [Action::Commit, Action::Withdraw] {
        let signed = env.sign_auth_call(c0, &objective, action).await?;
        let outcome = env.execute_intents(&[signed]).await?;
        assert!(outcome.ok(), "{}", outcome.error());
    }
    let state = env.state(objective.account()).await?;
    assert!(state.get("committed").is_none(), "{state}");

    env.register_key(&env.sponsor).await?;
    let signed = env
        .sign_auth_call(&env.sponsor, &objective, Action::Cancel)
        .await?;
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let cancelled = env.execute_intents(&[signed]).await?;
    assert_cancelled(&env, &objective, &cancelled, sponsor_before).await
}
