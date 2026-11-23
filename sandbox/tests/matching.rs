//! Matching as NEAR Intents does it: a solver's quote is its signed
//! commitment, the sponsor answers with signed funding, and a relayer sends
//! both to the Verifier in one `execute_intents`.
//!
//! The Verifier accepts the pair or neither. The objective then hears of each
//! in its own receipt, so one can land without the other; the party left
//! alone undoes its half by withdrawing or cancelling.

use std::time::Duration;

use anyhow::Result;
use extents_client::objective::Objective;
use extents_objective::auth_call::Action;
use extents_sandbox::{Actor, Env, SPONSOR_FUNDS, send_call};
use near_kit::NearToken;
use serde_json::Value;

const AMOUNT: u128 = 1_000_009;

/// The objective whose terms pay everything to `env.contributors[solver]`
/// and let the Verifier relay signed calls. Not deployed.
async fn terms(env: &Env, solver: usize) -> Result<Objective> {
    let mut params = env.params(
        &[(solver, 1_000_000)],
        env.now().await? + Duration::from_mins(10),
    )?;
    params.auth_caller = Some(env.verifier.as_str().parse()?);
    env.objective(&params)
}

/// `actor`'s signed commitment to `objective`.
async fn commitment(env: &Env, actor: &Actor, objective: &Objective) -> Result<Value> {
    env.sign_auth_call(actor, objective, Action::Commit).await
}

/// The sponsor's signed funding of `objective` with `amount`.
async fn funding(env: &Env, objective: &Objective, amount: u128) -> Result<Value> {
    env.sign_intents(&env.sponsor, &[objective.fund_intent(amount)])
        .await
}

async fn launch(env: &Env, objective: &Objective) -> Result<()> {
    env.launch(&env.closer, objective, NearToken::ZERO).await?;
    Ok(())
}

/// Nothing funded, nobody committed, and the sponsor still holds everything.
async fn assert_untouched(env: &Env, objective: &Objective) -> Result<()> {
    let state = env.state(objective.account()).await?;
    assert_eq!(state["funded"], "0", "{state}");
    assert!(state.get("committed").is_none(), "{state}");
    assert_eq!(env.mt_balance(objective.account()).await?, 0);
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, SPONSOR_FUNDS);
    Ok(())
}

/// Both are signed for an address nobody has launched. A third party launches
/// it, and one transaction funds and commits, in either order of the pair.
///
/// docs/spec.md, "The address derives from the terms"
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn a_quote_and_its_funding_settle_in_one_transaction() -> Result<()> {
    let env = Env::new(1).await?;
    let solver = &env.contributors[0];
    env.register_key(solver).await?;
    env.register_key(&env.sponsor).await?;

    for funding_first in [true, false] {
        let objective = terms(&env, 0).await?;
        let quote = commitment(&env, solver, &objective).await?;
        let funding = funding(&env, &objective, AMOUNT).await?;
        assert!(!env.exists(objective.account()).await?);

        launch(&env, &objective).await?;
        let pair = if funding_first {
            [funding, quote]
        } else {
            [quote, funding]
        };
        let matched = env.execute_intents(&pair).await?;
        assert!(matched.ok(), "{}", matched.error());
        assert!(
            matched.failed_receipts().is_empty(),
            "{:?}",
            matched.failed_receipts()
        );
        let funded = matched.events("funded");
        assert_eq!(funded.len(), 1);
        assert_eq!(funded[0]["funded"], AMOUNT.to_string());
        let committed = matched.events("committed");
        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0]["contributor"], solver.id.as_str());
        assert_eq!(env.mt_balance(objective.account()).await?, AMOUNT);
    }
    Ok(())
}

/// An intent the Verifier refuses fails the transaction, so the other intent
/// of the pair does not run either, and its signature is not spent.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn the_verifier_accepts_the_pair_or_neither() -> Result<()> {
    let env = Env::new(2).await?;
    let (solver, unregistered) = (&env.contributors[0], &env.contributors[1]);
    env.register_key(solver).await?;
    env.register_key(&env.sponsor).await?;

    // Funding the sponsor cannot cover: the quote does not land.
    let objective = terms(&env, 0).await?;
    launch(&env, &objective).await?;
    let quote = commitment(&env, solver, &objective).await?;
    let overdrawn = funding(&env, &objective, SPONSOR_FUNDS + 1).await?;
    let refused = env.execute_intents(&[overdrawn, quote.clone()]).await?;
    assert!(!refused.ok());
    assert_untouched(&env, &objective).await?;

    // The same quote still matches funding the sponsor can cover.
    let covered = funding(&env, &objective, AMOUNT).await?;
    let matched = env.execute_intents(&[covered, quote]).await?;
    assert!(matched.ok(), "{}", matched.error());
    assert_eq!(matched.events("funded").len(), 1);
    assert_eq!(matched.events("committed").len(), 1);
    let sponsor_after = env.mt_balance(&env.sponsor.id).await?;

    // A quote signed with a key the Verifier does not know: no funding moves.
    let objective = terms(&env, 1).await?;
    launch(&env, &objective).await?;
    let unknown = commitment(&env, unregistered, &objective).await?;
    let covered = funding(&env, &objective, AMOUNT).await?;
    let refused = env.execute_intents(&[covered, unknown]).await?;
    assert!(!refused.ok());
    let state = env.state(objective.account()).await?;
    assert_eq!(state["funded"], "0", "{state}");
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, sponsor_after);
    Ok(())
}

/// Nothing ties the two intents to each other. A quote relayed alone commits
/// its solver to an unfunded objective, and funding lands beside a commitment
/// the objective refuses. Each party undoes its own half.
///
/// docs/spec.md, "A holder may withdraw until it delivers"; docs/spec.md, "The sponsor may cancel until someone commits"
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn each_half_lands_without_the_other() -> Result<()> {
    let env = Env::new(1).await?;
    let solver = &env.contributors[0];
    env.register_key(solver).await?;
    env.register_key(&env.sponsor).await?;
    env.register_key(&env.evaluator).await?;

    // The quote alone.
    let objective = terms(&env, 0).await?;
    launch(&env, &objective).await?;
    let alone = env
        .execute_intents(&[commitment(&env, solver, &objective).await?])
        .await?;
    assert!(alone.ok(), "{}", alone.error());
    assert_eq!(alone.events("committed").len(), 1);
    assert_eq!(env.state(objective.account()).await?["funded"], "0");
    let withdrawn = send_call(solver, &objective.withdraw()).await?;
    assert!(withdrawn.ok(), "{}", withdrawn.error());
    assert_untouched(&env, &objective).await?;

    // Funding beside a commitment from an account the terms do not name.
    let objective = terms(&env, 0).await?;
    launch(&env, &objective).await?;
    let stranger = commitment(&env, &env.evaluator, &objective).await?;
    let lopsided = env
        .execute_intents(&[funding(&env, &objective, AMOUNT).await?, stranger])
        .await?;
    assert!(lopsided.ok(), "{}", lopsided.error());
    assert_eq!(lopsided.events("funded").len(), 1);
    assert!(lopsided.events("committed").is_empty());
    let on_auth = lopsided.calls("on_auth");
    assert!(on_auth.len() == 1 && !on_auth[0].ok, "{on_auth:?}");
    assert_eq!(env.mt_balance(objective.account()).await?, AMOUNT);

    let cancelled = send_call(&env.sponsor, &objective.cancel()).await?;
    assert!(cancelled.ok(), "{}", cancelled.error());
    assert_eq!(cancelled.events("resolved")[0]["outcome"], "cancelled");
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, SPONSOR_FUNDS);
    Ok(())
}

/// The launch cannot ride in the pair, and must come first: relayed to an
/// address with no account, the pair moves nothing and both signatures are
/// spent.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn a_pair_relayed_before_the_launch_is_spent() -> Result<()> {
    let env = Env::new(1).await?;
    let solver = &env.contributors[0];
    env.register_key(solver).await?;
    env.register_key(&env.sponsor).await?;

    let objective = terms(&env, 0).await?;
    let pair = [
        funding(&env, &objective, AMOUNT).await?,
        commitment(&env, solver, &objective).await?,
    ];
    let early = env.execute_intents(&pair).await?;
    assert!(early.ok(), "{}", early.error());
    assert!(early.events("funded").is_empty() && early.events("committed").is_empty());
    assert!(!env.exists(objective.account()).await?);
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, SPONSOR_FUNDS);

    launch(&env, &objective).await?;
    let again = env.execute_intents(&pair).await?;
    assert!(!again.ok());
    assert_untouched(&env, &objective).await
}
