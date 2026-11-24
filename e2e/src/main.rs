//! End-to-end test of `extents-objective` against a live NEAR Intents
//! Verifier on testnet. Every instance's account id and initial state come
//! from the crate's own `Params` and `ContractStorage::init_state`, so the
//! JSON and borsh bytes sent on-chain cannot drift from the contract.

mod accounts;
mod chain;
mod dao;
mod documents;
mod intent;
mod outlayer;
mod report;
mod scenarios;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use crate::{accounts::Accounts, chain::Chain, scenarios::Scenario};

#[derive(Parser)]
#[command(about)]
struct Cli {
    #[command(flatten)]
    config: Config,

    #[command(subcommand)]
    command: Command,
}

#[derive(clap::Args, Clone, Debug)]
pub struct Config {
    /// Existing testnet account that creates and funds the e2e accounts.
    #[arg(long, env = "E2E_PARENT", default_value = "agency.testnet")]
    pub parent: String,

    /// Prefix of the e2e accounts: `<prefix>-sponsor.<parent>`, etc.
    #[arg(long, env = "E2E_PREFIX", default_value = "e2e")]
    pub prefix: String,

    /// Use an existing account as the sponsor instead of
    /// `<prefix>-sponsor.<parent>`, e.g. one old enough for the faucet.
    #[arg(long, env = "E2E_SPONSOR")]
    pub sponsor: Option<String>,

    #[arg(
        long,
        env = "E2E_VERIFIER",
        default_value = "verifier.tidepool-sandbox.testnet"
    )]
    pub verifier: String,

    /// Token id inside the Verifier (`mt_balance_of`, `mt_transfer_call`).
    #[arg(
        long,
        env = "E2E_TOKEN",
        default_value = "nep141:usdc.tidepool-sandbox.testnet"
    )]
    pub token: String,

    /// Testnet JSON-RPC endpoint. A run makes dozens of calls per step, and
    /// both `rpc.testnet.near.org` and keyless `rpc.testnet.fastnear.com`
    /// answer bursts with 429s, stalling a run past its deadlines.
    #[arg(
        long,
        env = "E2E_RPC",
        default_value = "https://rpc.testnet.fastnear.com"
    )]
    pub rpc: String,

    /// API key for `rpc.testnet.fastnear.com`, sent as `Authorization:
    /// Bearer`. Read from `FASTNEAR_API_KEY` (environment or `.env`) only,
    /// so it stays out of shell history and URLs.
    #[arg(skip = std::env::var("FASTNEAR_API_KEY").ok().filter(|k| !k.is_empty()))]
    pub api_key: Option<String>,

    /// The wasm built by `cargo near build`; its sha256 is the global
    /// contract's code hash.
    #[arg(
        long,
        env = "E2E_WASM",
        default_value = "target/near/extents_objective/extents_objective.wasm"
    )]
    pub wasm: PathBuf,

    /// The evaluator program of the `outlayer-evaluator` scenario, built
    /// from `e2e/outlayer-evaluator`.
    #[arg(
        long,
        env = "E2E_OUTLAYER_WASM",
        default_value = "target/outlayer-evaluator/wasm32-wasip2/release/outlayer-evaluator.wasm"
    )]
    pub outlayer_wasm: PathBuf,

    /// Where scenario results are written.
    #[arg(long, env = "E2E_RESULTS", default_value = "e2e/results")]
    pub results: PathBuf,
}

#[derive(Subcommand)]
enum Command {
    /// Create the sponsor, evaluator, deployer and contributors as
    /// sub-accounts of the parent, and top existing ones up to their
    /// minimum NEAR balance.
    Accounts,
    /// Publish the wasm as a global contract by code hash, from the deployer.
    Publish,
    /// Print NEAR and Verifier balances of every e2e account.
    Balances,
    /// Run scenarios, in order. Each writes `<results>/<wasm-sha256>/<scenario>.json`,
    /// with a summary for that build.
    Run {
        #[arg(required = true, value_enum)]
        scenarios: Vec<Scenario>,
    },
    /// A Sputnik DAO that signs NEAR Intents by vote, through the MPC signer.
    Dao {
        #[command(subcommand)]
        command: dao::Command,
    },
}

/// Loads `extents/.env` (e.g. `FASTNEAR_API_KEY`) from a fixed path, so no
/// other `.env` is picked up whatever the working directory. A missing file
/// is fine; an unreadable or malformed one is an error rather than a run
/// without its keys. Variables already set in the environment win.
fn load_env() -> Result<()> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env");
    match dotenvy::from_path(&path) {
        Err(err) if !err.not_found() => {
            Err(err).with_context(|| format!("loading {}", path.display()))
        }
        _ => Ok(()),
    }
}

/// Refuses to run against a Verifier build other than the one the intent
/// format and every recorded result assume.
async fn ensure_pinned_verifier(chain: &Chain) -> Result<()> {
    anyhow::ensure!(
        chain.verifier_is_pinned().await?,
        "{} no longer runs the pinned Verifier build (sha256 {}); check its \
         changes against extents-client before running",
        chain.verifier,
        extents_client::VERIFIER_SHA256
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    load_env()?;
    let Cli { config, command } = Cli::parse();
    let chain = Chain::testnet(&config)?;
    let accounts = Accounts::new(&config)?;

    match command {
        Command::Accounts => accounts.create(&chain).await,
        Command::Publish => accounts.publish(&chain, &config.wasm).await,
        Command::Balances => accounts.print_balances(&chain).await,
        Command::Run { scenarios } => {
            ensure_pinned_verifier(&chain).await?;
            let mut passed = true;
            for scenario in scenarios {
                let run = scenario.run(&chain, &accounts, &config).await?;
                passed &= run.passed();
                report::write(&config.results, &run)?;
            }
            anyhow::ensure!(
                passed,
                "one or more e2e scenarios failed; see the results reports"
            );
            Ok(())
        }
        Command::Dao { command } => {
            ensure_pinned_verifier(&chain).await?;
            dao::Dao::new(&chain, &accounts, &config)?
                .run(command, &config)
                .await
        }
    }
}
