//! Which release a worker runs, from its boot event log and app-compose, as
//! OutLayer's portal serves them for each running worker.
//!
//! dstack extends RTMR3 at boot with one event per fact: the app id, the hash
//! of the app-compose, the instance id, the key provider. Replaying the
//! events must give the quote's RTMR3, and then the compose that hashes to the
//! logged compose hash is the one that ran. A worker has no instance id, so
//! every worker of one release has one RTMR3.

use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256, Sha384};

use crate::text;

/// The type dstack gives the events it extends RTMR3 with.
const DSTACK_EVENT: u32 = 0x0800_0001;

/// What a worker's event log and compose say about it.
#[derive(Debug, PartialEq, Eq)]
pub struct Release {
    pub compose_hash: String,
    /// Every image the compose runs, each pinned by its digest.
    pub images: Vec<String>,
}

/// An event's digest: its type, name and payload, as dstack measures them.
fn digest(kind: u32, name: &str, payload: &[u8]) -> [u8; 48] {
    let mut hash = Sha384::new();
    hash.update(kind.to_le_bytes());
    hash.update(b":");
    hash.update(name.as_bytes());
    hash.update(b":");
    hash.update(payload);
    hash.finalize().into()
}

/// Replays `worker`'s RTMR3 events against `rtmr3`, the quote's, and returns
/// the release its compose names. `worker` is one entry of a node's `cvms`
/// at `https://workers.outlayer.ai/api/attestation`.
pub fn release(worker: &Value, rtmr3: &[u8]) -> Result<Release> {
    let events = worker["event_log"].as_array().context("no `event_log`")?;
    let mut register = [0u8; 48];
    let mut composes = Vec::new();
    for event in events.iter().filter(|event| event["imr"] == 3) {
        let kind = event["event_type"]
            .as_u64()
            .and_then(|kind| u32::try_from(kind).ok())
            .context("no `event_type`")?;
        let name = text(event, "event")?;
        ensure!(kind == DSTACK_EVENT, "event {name} is not dstack's");
        let payload = hex::decode(text(event, "event_payload")?)?;
        let logged = hex::decode(text(event, "digest")?)?;
        ensure!(
            logged == digest(kind, name, &payload),
            "event {name}: its digest is not of its name and payload"
        );
        register = Sha384::new()
            .chain_update(register)
            .chain_update(&logged)
            .finalize()
            .into();
        if name == "compose-hash" {
            composes.push(payload);
        }
    }
    ensure!(
        register == rtmr3,
        "the event log does not replay to the quote's RTMR3"
    );
    let [logged] = &composes[..] else {
        bail!("the event log names {} compose hashes", composes.len());
    };

    let compose = text(worker, "app_compose")?;
    let compose_hash = Sha256::digest(compose.as_bytes());
    ensure!(
        logged[..] == compose_hash[..],
        "the app-compose is not the one the event log names"
    );
    let compose: Value = serde_json::from_str(compose)?;
    let images: Vec<String> = text(&compose, "docker_compose_file")?
        .lines()
        .filter_map(|line| line.trim().strip_prefix("image:"))
        .map(|image| image.trim().trim_matches(['"', '\'']).to_owned())
        .collect();
    ensure!(!images.is_empty(), "the compose runs no image");
    for image in &images {
        ensure!(
            image.contains("@sha256:"),
            "image {image} is not pinned by its digest"
        );
    }
    Ok(Release {
        compose_hash: hex::encode(compose_hash),
        images,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const IMAGE: &str = "docker.io/outlayer/near-outlayer-worker@sha256:4cbf";

    fn compose(image: &str) -> String {
        json!({ "docker_compose_file": format!("services:\n  worker:\n    image: {image}\n") })
            .to_string()
    }

    fn event(name: &str, payload: &[u8]) -> Value {
        json!({
            "imr": 3,
            "event_type": DSTACK_EVENT,
            "event": name,
            "event_payload": hex::encode(payload),
            "digest": hex::encode(digest(DSTACK_EVENT, name, payload)),
        })
    }

    /// A worker running `compose`, and the RTMR3 its log replays to.
    fn worker(compose: &str) -> (Value, [u8; 48]) {
        let events = vec![
            json!({ "imr": 0, "event_type": 1, "digest": "00" }),
            event("app-id", &[7; 20]),
            event("compose-hash", &Sha256::digest(compose.as_bytes())),
            event("instance-id", b""),
        ];
        let mut register = [0u8; 48];
        for event in events.iter().filter(|event| event["imr"] == 3) {
            let digest = hex::decode(event["digest"].as_str().unwrap()).unwrap();
            register = Sha384::new()
                .chain_update(register)
                .chain_update(digest)
                .finalize()
                .into();
        }
        (
            json!({ "event_log": events, "app_compose": compose }),
            register,
        )
    }

    fn refusal(worker: &Value, rtmr3: &[u8]) -> String {
        release(worker, rtmr3).unwrap_err().to_string()
    }

    #[test]
    fn a_log_that_replays_names_its_compose_and_images() {
        let compose = compose(IMAGE);
        let (worker, rtmr3) = worker(&compose);
        assert_eq!(
            release(&worker, &rtmr3).unwrap(),
            Release {
                compose_hash: hex::encode(Sha256::digest(compose.as_bytes())),
                images: vec![IMAGE.to_owned()],
            }
        );
    }

    #[test]
    fn another_rtmr3_is_refused() {
        let (worker, mut rtmr3) = worker(&compose(IMAGE));
        rtmr3[0] ^= 1;
        assert!(refusal(&worker, &rtmr3).contains("does not replay"));
    }

    #[test]
    fn an_event_whose_payload_was_changed_is_refused() {
        let (mut worker, rtmr3) = worker(&compose(IMAGE));
        worker["event_log"][1]["event_payload"] = json!(hex::encode([8; 20]));
        assert!(refusal(&worker, &rtmr3).contains("app-id: its digest"));
    }

    #[test]
    fn another_compose_than_the_logged_one_is_refused() {
        let (mut worker, rtmr3) = worker(&compose(IMAGE));
        worker["app_compose"] = json!(compose("docker.io/other@sha256:1"));
        assert!(refusal(&worker, &rtmr3).contains("not the one the event log names"));
    }

    #[test]
    fn an_image_not_pinned_by_digest_is_refused() {
        let (worker, rtmr3) = worker(&compose("docker.io/outlayer/near-outlayer-worker:latest"));
        assert!(refusal(&worker, &rtmr3).contains("not pinned"));
    }
}
