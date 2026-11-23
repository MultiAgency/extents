//! Publishing to an objective's own account: `FastData` indexes calls to
//! `__fastdata_kv`, and the objective accepts them as a no-op, so the
//! receipt succeeds and nothing about the objective changes.

use std::time::Duration;

use anyhow::Result;
use extents_client::objective::Objective;
use extents_sandbox::{Actor, Env, Outcome, call};
use near_kit::{Gas, NearToken};
use serde_json::{Value, json};

const AMOUNT: u128 = 1_000;
const PUBLISH_GAS: Gas = Gas::from_tgas(30);
/// What a publish may burn. Measured: 1.3 Tgas, and 1.5 for 100 KB.
const PUBLISH_BURN: Gas = Gas::from_tgas(3);

/// Everything observable about an objective.
async fn snapshot(env: &Env, objective: &Objective) -> Result<(Value, u64, u128, u128)> {
    let account = env
        .sandbox
        .client()
        .account(objective.account().clone())
        .await?;
    Ok((
        env.state(objective.account()).await?,
        account.storage_usage,
        account.amount.as_yoctonear(),
        env.mt_balance(objective.account()).await?,
    ))
}

async fn publish(
    from: &Actor,
    objective: &Objective,
    args: Value,
    deposit: NearToken,
) -> Result<Outcome> {
    call(
        from,
        objective.account(),
        "__fastdata_kv",
        args,
        PUBLISH_GAS,
        deposit,
    )
    .await
}

/// docs/spec.md, "Publishing to an objective changes nothing"
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn publishing_is_accepted_and_changes_nothing() -> Result<()> {
    let env = Env::new(2).await?;
    let params = env.params(
        &[(0, 700_000), (1, 300_000)],
        env.now().await? + Duration::from_mins(10),
    )?;
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, AMOUNT).await?.ok());
    assert!(env.commit(&env.contributors[0], &objective).await?.ok());
    // The closer holds no role in the objective.
    let stranger = &env.closer;
    let before = snapshot(&env, &objective).await?;

    let documents = [
        (
            "terms",
            json!({
                "extents/v1/params": params,
                "extents/v1/spec": { "version": 1, "title": "Ship the release" },
            }),
        ),
        ("empty", json!({})),
        (
            "100 KB",
            json!({ "extents/v1/deliverable": { "text": "x".repeat(100_000) } }),
        ),
    ];
    for (name, args) in documents {
        let published = publish(stranger, &objective, args, NearToken::ZERO).await?;
        assert!(published.ok(), "{name}: {}", published.error());
        let receipt = published.calls("__fastdata_kv");
        assert!(receipt.len() == 1 && receipt[0].ok, "{name}: {receipt:?}");
        assert!(receipt[0].burnt < PUBLISH_BURN, "{name}: {receipt:?}");
        assert_eq!(snapshot(&env, &objective).await?, before, "{name}");
    }
    Ok(())
}

/// A deposit would stay on the objective and go to whoever closes it, so a
/// publish with one is refused and the deposit returns to its sender.
///
/// docs/spec.md, "Publishing to an objective changes nothing"
#[tokio::test]
#[ignore = "needs Docker; run with `cargo test -p extents-sandbox -- --ignored`"]
async fn a_publish_with_a_deposit_is_refused() -> Result<()> {
    let env = Env::new(2).await?;
    let params = env.params(
        &[(0, 700_000), (1, 300_000)],
        env.now().await? + Duration::from_mins(10),
    )?;
    let objective = env.deploy(&params).await?;
    assert!(env.fund(&objective, AMOUNT).await?.ok());
    let before = snapshot(&env, &objective).await?;

    let deposit = NearToken::from_yoctonear(1);
    let refused = publish(&env.closer, &objective, json!({}), deposit).await?;
    assert!(
        refused.error().contains("__fastdata_kv takes no deposit"),
        "{}",
        refused.error()
    );
    assert!(
        refused
            .transfers_to(&env.closer.id)
            .contains(&deposit.as_yoctonear()),
        "{:?}",
        refused.receipts
    );
    assert_eq!(snapshot(&env, &objective).await?, before);
    Ok(())
}
