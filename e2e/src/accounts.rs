#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{fs, io::Write, path::Path};

use anyhow::{Context, Result, bail};
use near_kit::{
    AccountId, NearToken,
    protocol::PublishMode,
    signer::{PublicKey, SecretKey},
};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{Config, chain::Chain};

/// Every test account, as `<prefix>-<role>.<parent>`.
pub struct Accounts {
    pub parent: AccountId,
    pub sponsor: AccountId,
    pub evaluator: AccountId,
    /// Publishes the global contract, relays signed intents, and closes
    /// objectives as a third party.
    pub deployer: AccountId,
    pub contributors: Vec<AccountId>,
}

/// The `max` scenarios use the largest valid number of contributors.
const CONTRIBUTORS: usize = extents_objective::Params::MAX_CONTRIBUTORS;

/// Minimum NEAR balances, kept by `accounts`. A transaction must cover its
/// prepaid gas at the pessimistic gas price: 300 Tgas (`ob_attest`,
/// `ob_close`, `execute_intents`) needs about 0.301 NEAR on testnet even
/// though it burns far less. The deployer is also topped up by `publish`.
const SPONSOR_NEAR: NearToken = NearToken::from_millinear(1000);
const EVALUATOR_NEAR: NearToken = NearToken::from_millinear(1000);
const DEPLOYER_NEAR: NearToken = NearToken::from_millinear(1000);
const CONTRIBUTOR_NEAR: NearToken = NearToken::from_millinear(500);
/// `c0` and `c1` are also the test DAO's council: each files proposals
/// (0.1 NEAR bond, refunded on approval) and casts 300 Tgas votes.
const COUNCIL_NEAR: NearToken = NearToken::from_millinear(1000);
const COUNCIL: usize = 2;

/// NEP-591 charges 10× the regular storage price for global contract code.
const GLOBAL_CONTRACT_YOCTO_PER_BYTE: u128 = 10 * 10u128.pow(19);
/// Gas for the publish transaction itself.
const PUBLISH_MARGIN: NearToken = NearToken::from_millinear(200);

impl Accounts {
    pub fn new(config: &Config) -> Result<Self> {
        let named = |role: &str| -> Result<AccountId> {
            format!("{}-{role}.{}", config.prefix, config.parent)
                .parse()
                .with_context(|| format!("invalid account id for {role}"))
        };
        Ok(Self {
            parent: config.parent.parse()?,
            sponsor: match &config.sponsor {
                Some(sponsor) => sponsor.parse()?,
                None => named("sponsor")?,
            },
            evaluator: named("evaluator")?,
            deployer: named("deployer")?,
            contributors: (0..CONTRIBUTORS)
                .map(|i| named(&format!("c{i}")))
                .collect::<Result<_>>()?,
        })
    }

    fn all(&self) -> impl Iterator<Item = (&AccountId, NearToken)> {
        [
            (&self.sponsor, SPONSOR_NEAR),
            (&self.evaluator, EVALUATOR_NEAR),
            (&self.deployer, DEPLOYER_NEAR),
        ]
        .into_iter()
        .chain(self.contributors.iter().enumerate().map(|(i, c)| {
            (
                c,
                if i < COUNCIL {
                    COUNCIL_NEAR
                } else {
                    CONTRIBUTOR_NEAR
                },
            )
        }))
    }

    pub async fn create(&self, chain: &Chain) -> Result<()> {
        for (account, amount) in self.all() {
            if let Some(balance) = chain.near_balance(account).await? {
                let Some(short) = amount
                    .as_yoctonear()
                    .checked_sub(balance)
                    .filter(|s| *s > 0)
                else {
                    println!("{account}: exists");
                    continue;
                };
                let short = NearToken::from_yoctonear(short);
                let tx = chain
                    .as_signer(&self.parent)?
                    .transfer(account.clone(), short)
                    .wait_until::<near_kit::transaction::Final>()
                    .await?;
                println!(
                    "{account}: topped up by {short}, tx {}",
                    tx.transaction_hash()
                );
                continue;
            }
            // Reuse a key left by an earlier, failed attempt.
            let public_key = match chain.signer(account) {
                Ok(signer) => signer.public_key().clone(),
                Err(_) => new_credentials(account)?,
            };
            let tx = chain
                .as_signer(&self.parent)?
                .transaction(account.clone())
                .create_account()
                .transfer(amount)
                .add_full_access_key(public_key)
                .send()
                .wait_until::<near_kit::transaction::Final>()
                .await?;
            if let Some(err) = tx.failure_message() {
                bail!("creating {account}: {err}");
            }
            println!(
                "{account}: created with {amount}, tx {}",
                tx.transaction_hash()
            );
        }
        Ok(())
    }

    pub async fn publish(&self, chain: &Chain, wasm: &Path) -> Result<()> {
        let code = fs::read(wasm).with_context(|| format!("reading {}", wasm.display()))?;
        let hash = code_hash(&code);
        println!(
            "wasm: {} bytes, sha256 {}, code hash {}",
            code.len(),
            hex::encode(hash),
            near_kit::CryptoHash::from(hash)
        );
        if chain.global_contract_exists(hash).await? {
            println!("already published");
            return Ok(());
        }

        let cost = u128::try_from(code.len())? * GLOBAL_CONTRACT_YOCTO_PER_BYTE;
        let needed = cost + PUBLISH_MARGIN.as_yoctonear();
        let have = chain
            .near_balance(&self.deployer)
            .await?
            .unwrap_or_default();
        if have < needed {
            let top_up = NearToken::from_yoctonear(needed - have);
            let tx = chain
                .as_signer(&self.parent)?
                .transfer(self.deployer.clone(), top_up)
                .wait_until::<near_kit::transaction::Final>()
                .await?;
            println!(
                "topped up deployer by {top_up}, tx {}",
                tx.transaction_hash()
            );
        }

        let before = chain
            .near_balance(&self.deployer)
            .await?
            .unwrap_or_default();
        let tx = chain
            .as_signer(&self.deployer)?
            .publish(code, PublishMode::Immutable)
            .wait_until::<near_kit::transaction::Final>()
            .await?;
        if let Some(err) = tx.failure_message() {
            bail!("publish: {err}");
        }
        let after = chain
            .near_balance(&self.deployer)
            .await?
            .unwrap_or_default();
        println!(
            "published, tx {}; deployer paid {} (expected storage {})",
            tx.transaction_hash(),
            NearToken::from_yoctonear(before - after),
            NearToken::from_yoctonear(cost),
        );
        Ok(())
    }

    pub async fn print_balances(&self, chain: &Chain) -> Result<()> {
        for (account, _) in std::iter::once((&self.parent, NearToken::ZERO)).chain(self.all()) {
            let near = chain.near_balance(account).await?;
            let mt = chain.mt_balance(account).await?;
            println!(
                "{account}: {}, {mt} {}",
                near.map_or_else(
                    || "absent".into(),
                    |n| NearToken::from_yoctonear(n).to_string()
                ),
                chain.token,
            );
        }
        Ok(())
    }
}

pub fn code_hash(code: &[u8]) -> [u8; 32] {
    Sha256::digest(code).into()
}

/// Generates a key and writes it in near-cli's legacy keychain format, which
/// both near-cli and near-kit's `FileSigner` read.
fn new_credentials(account: &AccountId) -> Result<PublicKey> {
    let key = SecretKey::generate_ed25519();
    let dir = dirs_home()?.join(".near-credentials/testnet");
    fs::create_dir_all(&dir)?;
    let bytes = serde_json::to_vec_pretty(&json!({
        "account_id": account,
        "public_key": key.public_key().to_string(),
        "private_key": near_cli_secret_key(&key)?,
    }))?;
    write_credentials(&dir.join(format!("{account}.json")), &bytes)?;
    Ok(key.public_key())
}

/// Creates a private key file without replacing an existing identity.
fn write_credentials(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

/// near-cli requires the 64-byte ed25519 form (seed, then public key);
/// near-kit's `Display` writes the 32-byte seed. Both parse in near-kit.
fn near_cli_secret_key(key: &SecretKey) -> Result<String> {
    let seed = key.as_bytes();
    let public = key.public_key();
    let public = public.as_ed25519_bytes().context("not an ed25519 key")?;
    Ok(format!(
        "ed25519:{}",
        bs58::encode([seed, public.as_slice()].concat()).into_string()
    ))
}

fn dirs_home() -> Result<std::path::PathBuf> {
    std::env::var_os("HOME")
        .map(Into::into)
        .context("HOME is not set")
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn credentials_are_private_and_cannot_be_overwritten() -> Result<()> {
        let path = std::env::temp_dir().join(format!(
            "extents-credentials-{}.json",
            rand::random::<u64>()
        ));
        write_credentials(&path, b"original identity")?;
        let mode = fs::metadata(&path)?.permissions().mode() & 0o777;
        let replacement = write_credentials(&path, b"replacement");
        let bytes = fs::read(&path)?;
        fs::remove_file(&path)?;
        assert_eq!(mode, 0o600);
        assert!(replacement.is_err());
        assert_eq!(bytes, b"original identity");
        Ok(())
    }
}
