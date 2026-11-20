//! A payout that fails on the Verifier goes back into `owed` and is retried
//! by `ob_close`. The failure is real: the Verifier's operator locks the
//! objective's account, and the Verifier's own code rejects its transfers.

use std::time::Duration;

use anyhow::Result;
use extents_objective::{Attestation, Verdict};
use extents_sandbox::Env;

const AMOUNT: u128 = 1_000_009;

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn failed_payouts_are_requeued_and_retried() -> Result<()> {
    let env = Env::new(2).await?;
    let (c0, c1) = (&env.contributors[0], &env.contributors[1]);
    let params = env.params(
        &[(0, 700_000), (1, 300_000)],
        env.now().await? + Duration::from_mins(10),
    )?;
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, AMOUNT).await?.ok());
    env.take_part(c0, &objective).await?;
    env.take_part(c1, &objective).await?;

    // Locked: every payout is rejected by the Verifier.
    env.lock(objective.account()).await?;
    let attest = env
        .attest(&objective, Attestation::from(Verdict::Achieved))
        .await?;
    assert!(attest.ok(), "{}", attest.error());
    let failed = attest.failed_receipts();
    println!(
        "payout failure: {}",
        failed.first().map_or("", String::as_str)
    );
    assert_eq!(failed.len(), 3, "{failed:?}");
    assert!(failed.iter().all(|e| e.contains("locked")), "{failed:?}");
    let lost = attest.events("lost");
    assert_eq!(lost.len(), 1);
    assert_eq!(
        lost[0]["amounts"],
        serde_json::json!({
            c0.id.as_str(): "700006",
            c1.id.as_str(): "300002",
            env.sponsor.id.as_str(): "1",
        })
    );
    assert!(attest.events("paid").is_empty());

    let state = env.state(objective.account()).await?;
    assert_eq!(
        state["owed"],
        serde_json::json!({ "contributor:0": "700006", "contributor:1": "300002", "sponsor": "1" }),
        "{state}"
    );
    assert_eq!(env.mt_balance(objective.account()).await?, AMOUNT);
    assert_eq!(env.mt_balance(&c0.id).await?, 0);

    // Retrying while still locked fails the same way and loses nothing.
    let retry = env.close(&objective).await?;
    assert!(retry.ok(), "{}", retry.error());
    assert_eq!(retry.events("lost").len(), 1);
    assert_eq!(env.state(objective.account()).await?["owed"], state["owed"]);
    assert_eq!(env.mt_balance(objective.account()).await?, AMOUNT);

    // Unlocked: the retry pays everything.
    env.unlock(objective.account()).await?;
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let retry = env.close(&objective).await?;
    assert!(retry.ok(), "{}", retry.error());
    assert!(
        retry.failed_receipts().is_empty(),
        "{:?}",
        retry.failed_receipts()
    );
    assert_eq!(retry.events("paid").len(), 1);
    assert_eq!(env.mt_balance(&c0.id).await?, 700_006);
    assert_eq!(env.mt_balance(&c1.id).await?, 300_002);
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, sponsor_before + 1);
    assert_eq!(env.mt_balance(objective.account()).await?, 0);

    // Settled but before the deadline, so the account stays.
    assert!(env.state(objective.account()).await?.get("owed").is_none());
    assert!(env.exists(objective.account()).await?);

    // Past the deadline, closing deletes it.
    env.fast_forward_past(params.deadline).await?;
    let close = env.close(&objective).await?;
    assert!(close.ok(), "{}", close.error());
    assert_eq!(close.events("cleanup").len(), 1);
    assert!(!env.exists(objective.account()).await?);
    Ok(())
}

/// The heaviest `ob_close`: after the deadline, it retries eleven failed
/// payouts (ten contributors and the sponsor's remainder), then reads the
/// objective's balance and deletes it, all in one transaction within
/// `Params::close_gas` (250 Tgas).
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn worst_case_close_retries_eleven_payouts_and_deletes() -> Result<()> {
    let env = Env::new(10).await?;
    let shares: Vec<(usize, u32)> = (0..10).map(|i| (i, 100_000)).collect();
    let params = env.params(&shares, env.now().await? + Duration::from_mins(10))?;
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, AMOUNT).await?.ok());
    for contributor in &env.contributors {
        env.take_part(contributor, &objective).await?;
    }

    env.lock(objective.account()).await?;
    let attest = env
        .attest(&objective, Attestation::from(Verdict::Achieved))
        .await?;
    assert!(attest.ok(), "{}", attest.error());
    assert_eq!(attest.failed_receipts().len(), 11);

    env.fast_forward_past(params.deadline).await?;
    env.unlock(objective.account()).await?;
    let close = env.close(&objective).await?;
    assert!(close.ok(), "{}", close.error());
    assert!(
        close.failed_receipts().is_empty(),
        "{:?}",
        close.failed_receipts()
    );
    let transfers = close.calls("mt_transfer");
    assert_eq!(transfers.len(), 11);
    let paid = close.events("paid");
    assert_eq!(paid.len(), 1);
    assert_eq!(
        paid[0]["amounts"].as_object().map(serde_json::Map::len),
        Some(11)
    );
    assert_eq!(close.calls("mt_balance_of").len(), 1);
    assert_eq!(close.events("cleanup").len(), 1);
    assert!(!env.exists(objective.account()).await?);
    for contributor in &env.contributors {
        assert_eq!(env.mt_balance(&contributor.id).await?, 100_000);
    }
    println!(
        "worst-case ob_close burnt {} Tgas",
        close.inner.total_gas_used().as_tgas()
    );
    Ok(())
}
