//! Balances that arrive without the sponsor's `mt_transfer_call`: refunded,
//! or retained when ownership is unknown, against the Verifier wasm.

use std::time::Duration;

use anyhow::Result;
use extents_client::objective::{Call, Objective};
use extents_objective::Verdict;
use extents_sandbox::{Env, Outcome, call, send_call};
use near_kit::{AccountId, Gas, NearToken};
use serde_json::json;

const AMOUNT: u128 = 1_000;
const STRAY: u128 = 5;
const GAS: Gas = Gas::from_tgas(100);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

async fn plain_transfer(env: &Env, objective: &AccountId, amount: u128) -> Result<Outcome> {
    call(
        &env.sponsor,
        &env.verifier,
        "mt_transfer",
        json!({ "receiver_id": objective, "token_id": env.token, "amount": amount.to_string() }),
        GAS,
        ONE_YOCTO,
    )
    .await
}

fn funded_field(state: &serde_json::Value) -> u128 {
    state["funded"].as_str().unwrap_or("0").parse().unwrap()
}

/// A deployed objective funded by the sponsor's `mt_transfer_call`.
async fn funded(env: &Env, shares: &[(usize, u32)]) -> Result<Objective> {
    let params = env.params(shares, env.now().await? + Duration::from_mins(10))?;
    let objective = env.deploy(&params).await?;
    let fund = env.fund(&objective, AMOUNT).await?;
    assert!(fund.ok(), "{}", fund.error());
    assert_eq!(fund.events("funded").len(), 1);
    Ok(objective)
}

/// A plain `mt_transfer` never notifies the objective, so it never counts as
/// funding: the failed verdict refunds only what was funded, and the stray
/// amount stays on the objective's balance.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn a_plain_transfer_is_never_counted() -> Result<()> {
    let env = Env::new(1).await?;
    let objective = funded(&env, &[(0, 1_000_000)]).await?;
    assert!(plain_transfer(&env, objective.account(), STRAY).await?.ok());
    assert_eq!(funded_field(&env.state(objective.account()).await?), AMOUNT);

    let failed = env.attest(&objective, Verdict::Failed.into()).await?;
    assert!(failed.ok(), "{}", failed.error());
    assert_eq!(env.mt_balance(objective.account()).await?, STRAY);
    Ok(())
}

/// After a verdict, an unattributed arrival is retained, and keeps the
/// objective from deleting itself.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn arrivals_after_the_verdict_are_retained() -> Result<()> {
    let env = Env::new(1).await?;
    let objective = funded(&env, &[(0, 1_000_000)]).await?;

    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    let failed = env.attest(&objective, Verdict::Failed.into()).await?;
    assert!(failed.ok(), "{}", failed.error());
    assert!(plain_transfer(&env, objective.account(), STRAY).await?.ok());

    env.fast_forward_past(objective.params().deadline).await?;
    let close = env.close(&objective).await?;
    assert!(close.ok(), "{}", close.error());
    assert!(close.events("cleanup").is_empty());
    assert!(env.exists(objective.account()).await?);
    assert_eq!(env.mt_balance(objective.account()).await?, STRAY);
    assert_eq!(
        env.mt_balance(&env.sponsor.id).await?,
        sponsor_before + AMOUNT - STRAY
    );
    Ok(())
}

/// A deposit whose `mt_on_transfer` runs out of gas is refunded by the
/// Verifier in full, and never counted.
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn an_under_gassed_deposit_is_refunded_and_never_counted() -> Result<()> {
    let env = Env::new(1).await?;
    let objective = funded(&env, &[(0, 1_000_000)]).await?;
    let sponsor_before = env.mt_balance(&env.sponsor.id).await?;
    // Below about 20.5 Tgas the Verifier's own `mt_transfer_call` runs out
    // and nothing reaches the objective; above about 21.2, `mt_on_transfer`
    // succeeds. Step up from the floor to the first gas the Verifier
    // accepts: it leaves `mt_on_transfer` a fraction of what it needs.
    let mut gas = Gas::from_tgas(20);
    let starved = loop {
        let deposit = Call {
            gas,
            ..objective.fund(STRAY)
        };
        let outcome = send_call(&env.sponsor, &deposit).await?;
        if outcome.ok() {
            break outcome;
        }
        assert!(gas < Gas::from_tgas(25), "the Verifier never accepted it");
        gas = Gas::from_gas(gas.as_gas() + Gas::from_ggas(100).as_gas());
    };
    let on_transfer = starved.calls("mt_on_transfer");
    assert!(
        on_transfer.len() == 1 && !on_transfer[0].ok,
        "{on_transfer:?}"
    );
    assert!(
        starved
            .failed_receipts()
            .iter()
            .any(|e| e.contains("Exceeded the prepaid gas")),
        "{:?}",
        starved.failed_receipts()
    );
    assert_eq!(env.mt_balance(&env.sponsor.id).await?, sponsor_before);

    assert_eq!(funded_field(&env.state(objective.account()).await?), AMOUNT);
    Ok(())
}
