//! Gas burnt by `ob_commit` and `ob_deliver`, in an ordinary state and at the
//! largest valid one, against the Verifier wasm.

use std::time::Duration;

use anyhow::Result;
use extents_client::objective::gas;
use extents_objective::Params;
use extents_sandbox::{Env, Outcome};
use near_kit::Gas;

/// The gas the one receipt calling `method` burnt. The client attaches
/// `gas::CALL`, which must keep at least a fourfold margin over it.
fn burnt(outcome: &Outcome, method: &str) -> Gas {
    assert!(outcome.ok(), "{method}: {}", outcome.error());
    let calls = outcome.calls(method);
    assert_eq!(calls.len(), 1, "{method}: {calls:?}");
    assert_eq!(calls[0].gas, gas::CALL, "{method}");
    assert!(
        calls[0].burnt.as_gas() * 4 < gas::CALL.as_gas(),
        "{method}: {calls:?}"
    );
    calls[0].burnt
}

/// Two contributors, no backups or window: the first commit and delivery.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn commit_and_deliver_gas_ordinary() -> Result<()> {
    let env = Env::new(2).await?;
    let params = env.params(
        &[(0, 700_000), (1, 300_000)],
        env.now().await? + Duration::from_mins(10),
    )?;
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, 1_000).await?.ok());

    let c0 = &env.contributors[0];
    let commit = burnt(&env.commit(c0, &objective).await?, "ob_commit");
    let deliver = burnt(&env.deliver(c0, &objective, [1; 32]).await?, "ob_deliver");
    eprintln!("ordinary: ob_commit {commit}, ob_deliver {deliver}");
    Ok(())
}

/// The largest valid params: ten contributors, each with a backup, an
/// acceptance window, `commit_by` and `auth_caller`. The worst commit is a
/// backup taking the last slot after `commit_by`; the worst delivery is that
/// backup's, the last one, which opens the window.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn commit_and_deliver_gas_worst_case() -> Result<()> {
    const N: usize = Params::MAX_CONTRIBUTORS;
    let env = Env::new(2 * N).await?;
    let now = env.now().await?;
    let shares: Vec<_> = (0..N).map(|i| (i, 100_000)).collect();
    // `commit_by` is passed in one fast-forward step (about 25 minutes of
    // block time); the window then reaches past the deadline, so the last
    // delivery extends the time to attest.
    let mut params = env.params(&shares, now + Duration::from_mins(40))?;
    params.backups = (0..N)
        .map(|i| {
            Ok((
                env.contributors[i].id.as_str().parse()?,
                env.contributors[N + i].id.as_str().parse()?,
            ))
        })
        .collect::<Result<_>>()?;
    params.commit_by = Some(now + Duration::from_mins(2));
    // The last delivery must extend the original 24-hour deadline so this
    // measures the state update that opens the acceptance window.
    params.acceptance_window_secs = Some(24 * 60 * 60);
    params.auth_caller = Some(env.verifier.as_str().parse()?);
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, 1_000).await?.ok());

    let mut commits = Vec::new();
    for contributor in &env.contributors[..N - 1] {
        commits.push(burnt(
            &env.commit(contributor, &objective).await?,
            "ob_commit",
        ));
    }
    env.fast_forward_past(params.commit_by.unwrap_or(now))
        .await?;
    let backup = &env.contributors[2 * N - 1];
    let taken = burnt(&env.commit(backup, &objective).await?, "ob_commit");

    let mut delivers = Vec::new();
    for (i, contributor) in env.contributors[..N - 1].iter().enumerate() {
        let hash = [u8::try_from(i)?; 32];
        delivers.push(burnt(
            &env.deliver(contributor, &objective, hash).await?,
            "ob_deliver",
        ));
    }
    let last = burnt(
        &env.deliver(backup, &objective, [0xff; 32]).await?,
        "ob_deliver",
    );
    assert!(env.attest_by(&objective).await? > params.deadline);

    eprintln!(
        "worst case: ob_commit max {} (backup taking the last slot {taken}), \
         ob_deliver max {} (last, opening the window {last})",
        commits.iter().max().copied().unwrap_or(taken).max(taken),
        delivers.iter().max().copied().unwrap_or(last).max(last),
    );
    Ok(())
}
