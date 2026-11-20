# Objective documents

The contract commits to documents by hash. The app publishes their contents as public plaintext
with FastData under the objective account. There is no encryption, private-delivery flow,
offer negotiation, or attested evaluator in this implementation.

## Formats and commitments

| Document | Commitment | Publisher |
| --- | --- | --- |
| Params | Borsh/Keccak hash in initial state; also determines the account address | Sponsor at launch |
| Spec | SHA-256 of canonical JSON in `Params.spec_hash` | Sponsor at launch |
| Report | SHA-256 of its UTF-8 bytes in the successful `delivered` event | The slot holder |
| Review | SHA-256 of canonical JSON in the optional attestation `review_hash` | Evaluator, or a DAO proposer |

`crates/spec` defines spec/review validation and RFC 8785 canonical JSON hashes.
The TypeScript mirror is checked against the same vectors. The protocol supports file criteria,
but this app accepts text reports and refuses file criteria when launching an objective.

## Publication and reads

Publication calls `__fastdata_kv` on the objective. That method does not exist, so its receipt
fails intentionally; FastData indexes the call anyway. Publication alone proves no contract action.

Documents use the keys `extents/v1/params`, `extents/v1/spec`, `extents/v1/deliverable` and
`extents/v1/review`. The server reads the params and spec rows, derives the objective account from Params and the configured
code hash, and requires the derived address and spec hash to match. The spec row must be written
by the sponsor. Unsupported schema sizes are reported before compilation.

After a successful finalized `ob_deliver`, the holder publishes:

```json
{"extents/v1/deliverable":{"text":"exact report","delivery_tx":"<transaction hash>","delivery_signer":"<transaction signer>"}}
```

The reader verifies the finalized transaction, a successful receipt executed by this objective,
the delivered event's contributor, and the report hash. Backup holders are selected from `taken`.
Every recorded delivery must have a matching report; replacing published text cannot replace
its on-chain commitment. The browser can republish a missing proof.

The evaluator checks those reports, validates the review against the spec, publishes it, and
attests its recomputed hash. A DAO proposer files the same attestation for the evaluator DAO to
approve. Allocation and completed payment are separate events.

## Evidence and privacy

Reviews contain fetched evidence hashes and model request/response hashes. During evaluation,
the server archives the exact evidence and model receipt bytes in a private, content-addressed
store. The archive is quota-bounded and has no replay tool yet. Draft checks do not write to it.
Provider signatures are verified; TEE attestation is not verified.

The private server archive does not make the published report or review private. Do not publish
confidential material through this app. The contract itself interprets hashes and account roles,
not document contents, evidence quality or real-world achievement.

## Discovery

The app opens an objective at `/o/<address>` and reads its state and documents. There is no global
objective search or reputation index. Historical events can support a separate indexer, but that
is not a service this repository implements.
