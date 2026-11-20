//! A backup taking an empty contributor slot, against the Verifier wasm.

use std::time::Duration;

use anyhow::Result;
use extents_objective::Verdict;
use extents_sandbox::Env;

const AMOUNT: u128 = 1_000;

/// `c2` backs `c1`. `c1` never commits; after `commit_by`, `c2` takes the slot
/// and the achieved verdict pays it `c1`'s share.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn backup_takes_an_empty_slot_and_is_paid() -> Result<()> {
    let env = Env::new(3).await?;
    let (c0, c1, c2) = (
        &env.contributors[0],
        &env.contributors[1],
        &env.contributors[2],
    );
    // fast-forwarding moves in steps of 5,000 blocks, so the deadline is far
    // enough out to survive the jump past `commit_by`
    let now = env.now().await?;
    let mut params = env.params(
        &[(0, 700_000), (1, 300_000)],
        now + Duration::from_hours(24),
    )?;
    params.backups = [(c1.id.as_str().parse()?, c2.id.as_str().parse()?)].into();
    params.commit_by = Some(now + Duration::from_mins(2));

    let objective = env.deploy(&params).await?;
    let fund = env.fund(&objective, AMOUNT).await?;
    assert!(fund.ok(), "{}", fund.error());
    assert_eq!(
        env.state(objective.account()).await?["funded"],
        AMOUNT.to_string()
    );
    assert!(env.commit(c0, &objective).await?.ok());

    let early = env.commit(c2, &objective).await?;
    assert!(
        early.error().contains("only after commit_by"),
        "{}",
        early.error()
    );

    env.fast_forward_past(params.commit_by.unwrap()).await?;
    let taken = env.commit(c2, &objective).await?;
    assert!(taken.ok(), "{}", taken.error());
    let state = env.state(objective.account()).await?;
    assert_eq!(state["taken"], 0b10);

    let late = env.commit(c1, &objective).await?;
    assert!(
        late.error().contains("already committed"),
        "{}",
        late.error()
    );

    let (c0_before, c2_before) = (env.mt_balance(&c0.id).await?, env.mt_balance(&c2.id).await?);
    let attest = env.attest(&objective, Verdict::Achieved.into()).await?;
    assert!(attest.ok(), "{}", attest.error());
    assert_eq!(env.mt_balance(&c0.id).await?, c0_before + 700);
    assert_eq!(env.mt_balance(&c2.id).await?, c2_before + 300);
    assert_eq!(env.mt_balance(&c1.id).await?, 0);
    Ok(())
}
