//! An objective works with any NEAR account as sponsor and evaluator: it
//! checks only who calls. Each account kind acts by its own means.

use std::time::Duration;

use anyhow::Result;
use extents_objective::{Attestation, Params, Verdict};
use extents_sandbox::{Actor, Env, Outcome, call, send_call};
use near_kit::{AccountId, Gas, NearToken};
use serde_json::json;

/// Not divisible by 70/30, so the split leaves a remainder for the sponsor.
const AMOUNT: u128 = 1_000_009;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const REVIEW: [u8; 32] = [7; 32];

const ACHIEVED: Attestation = Attestation {
    verdict: Verdict::Achieved,
    review_hash: Some(REVIEW),
};

/// Gives `account` the objective's amount on the Verifier, from the sponsor.
async fn give(env: &Env, account: &AccountId) -> Result<()> {
    let sent = call(
        &env.sponsor,
        &env.verifier,
        "mt_transfer",
        json!({ "receiver_id": account, "token_id": env.token, "amount": AMOUNT.to_string() }),
        Gas::from_tgas(30),
        ONE_YOCTO,
    )
    .await?;
    assert!(sent.ok(), "{}", sent.error());
    Ok(())
}

/// The contributors were paid 70/30 and the remainder went to `sponsor`.
async fn assert_paid(
    env: &Env,
    attest: &Outcome,
    contributors: [&Actor; 2],
    sponsor: &AccountId,
    objective: &AccountId,
) -> Result<()> {
    let resolved = attest.events("resolved");
    assert_eq!(resolved.len(), 1, "{:?}", attest.failed_receipts());
    assert_eq!(resolved[0]["outcome"], "achieved");
    assert_eq!(resolved[0]["review_hash"], hex::encode(REVIEW));
    assert_eq!(env.mt_balance(&contributors[0].id).await?, 700_006);
    assert_eq!(env.mt_balance(&contributors[1].id).await?, 300_002);
    assert_eq!(env.mt_balance(sponsor).await?, 1);
    assert_eq!(env.mt_balance(objective).await?, 0);
    Ok(())
}

#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn implicit_accounts_sponsor_and_evaluate() -> Result<()> {
    let env = Env::new(2).await?;
    let sponsor = env.implicit_actor(NearToken::from_near(2)).await?;
    let evaluator = env.implicit_actor(NearToken::from_near(2)).await?;
    give(&env, &sponsor.id).await?;

    let mut params = env.params(
        &[(0, 700_000), (1, 300_000)],
        env.now().await? + Duration::from_mins(10),
    )?;
    params.sponsor = sponsor.id.as_str().parse()?;
    params.evaluator = evaluator.id.as_str().parse()?;
    let objective = env.deploy(&params).await?;

    let fund = send_call(&sponsor, &objective.fund(AMOUNT)).await?;
    assert_eq!(
        fund.events("funded").len(),
        1,
        "{:?}",
        fund.failed_receipts()
    );

    for contributor in &env.contributors {
        assert!(env.commit(contributor, &objective).await?.ok());
    }
    let attest = send_call(&evaluator, &objective.attest(&ACHIEVED)).await?;
    assert!(attest.ok(), "{}", attest.error());
    assert_paid(
        &env,
        &attest,
        [&env.contributors[0], &env.contributors[1]],
        &sponsor.id,
        objective.account(),
    )
    .await
}

/// A Sputnik DAO, running mainnet's agency DAO code, sponsors and evaluates
/// by `FunctionCall` proposals: one to fund, one to attest. Each runs when
/// the council's last approval lands, with the DAO as the caller.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn dao_sponsors_and_evaluates_by_proposal() -> Result<()> {
    let env = Env::new(4).await?;
    // c0 and c1 govern the DAO; c2 and c3 are the contributors.
    let council = [&env.contributors[0], &env.contributors[1]];
    let dao = env.new_dao("agency", &council).await?;
    give(&env, &dao).await?;

    let mut params = env.params(
        &[(2, 700_000), (3, 300_000)],
        env.now().await? + Duration::from_mins(10),
    )?;
    params.sponsor = dao.as_str().parse()?;
    params.evaluator = dao.as_str().parse()?;
    let objective = env.deploy(&params).await?;

    let fund = env
        .dao_call(&dao, &council, &objective.fund(AMOUNT))
        .await?;
    assert_eq!(
        fund.events("funded").len(),
        1,
        "{:?}",
        fund.failed_receipts()
    );
    assert_eq!(env.mt_balance(objective.account()).await?, AMOUNT);

    for contributor in &env.contributors[2..] {
        assert!(env.commit(contributor, &objective).await?.ok());
    }
    let attest = env
        .dao_call(&dao, &council, &objective.attest(&ACHIEVED))
        .await?;
    assert_paid(
        &env,
        &attest,
        [&env.contributors[2], &env.contributors[3]],
        &dao,
        objective.account(),
    )
    .await
}

/// The heaviest attestation by proposal: ten contributors and eleven payouts
/// in an `ob_attest` with `Params::attest_gas` (210 Tgas), inside a vote
/// prepaid with 300 Tgas.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn dao_attests_for_ten_contributors_by_proposal() -> Result<()> {
    const CONTRIBUTORS: usize = Params::MAX_CONTRIBUTORS;

    let env = Env::new(2 + CONTRIBUTORS).await?;
    // c0 and c1 govern the DAO; the rest are the contributors.
    let council = [&env.contributors[0], &env.contributors[1]];
    let dao = env.new_dao("agency", &council).await?;

    let shares: Vec<_> = (2..2 + CONTRIBUTORS).map(|i| (i, 100_000)).collect();
    let mut params = env.params(&shares, env.now().await? + Duration::from_mins(10))?;
    params.evaluator = dao.as_str().parse()?;
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, AMOUNT).await?.ok());
    for contributor in &env.contributors[2..] {
        assert!(env.commit(contributor, &objective).await?.ok());
    }

    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let attest = env
        .dao_call(&dao, &council, &objective.attest(&ACHIEVED))
        .await?;
    let ob_attest = attest.calls("ob_attest");
    assert!(
        ob_attest.len() == 1
            && ob_attest[0].ok
            && ob_attest[0].gas == objective.attest(&ACHIEVED).gas,
        "{ob_attest:?}"
    );
    let resolved = attest.events("resolved");
    assert_eq!(resolved.len(), 1, "{:?}", attest.failed_receipts());
    assert_eq!(resolved[0]["outcome"], "achieved");
    let payouts = attest.calls("mt_transfer");
    assert!(
        payouts.len() == CONTRIBUTORS + 1 && payouts.iter().all(|p| p.ok),
        "{payouts:?}"
    );
    for contributor in &env.contributors[2..] {
        assert_eq!(env.mt_balance(&contributor.id).await?, 100_000);
    }
    assert_eq!(
        env.mt_balance(&env.sponsor.id).await?,
        sponsor_before + AMOUNT - 1_000_000
    );
    assert_eq!(env.mt_balance(objective.account()).await?, 0);
    Ok(())
}
