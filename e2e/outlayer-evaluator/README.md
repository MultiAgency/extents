# outlayer-evaluator

The evaluator program of the e2e's `outlayer-evaluator` scenario
([`../README.md`](../README.md)): a WASI module that [OutLayer](https://outlayer.ai)
runs in a TEE, and whose signing key belongs to this exact build.

- `manifest.json` is embedded in the wasm as the `outlayer.manifest` section. It declares
  the key `evaluator`: ed25519, `bind: "wasm"`, `caller: "none"`.
- `wit/signing-keys.wit` is a copy of OutLayer's `worker/wit/deps/signing-keys.wit`
  (`out-layer/outlayer` at `d127d49`), the host interface the key is used through.
- `wit-rpc/rpc.wit` is a copy of OutLayer's `near:rpc` host interface
  (`wasi-examples/rpc-test-ark/wit/world.wit` at the same commit), through which the program
  reads transactions.
- `.cargo/config.toml` builds for `wasm32-wasip2` into the repository's `target/`.

It takes one JSON object on stdin and prints one on stdout, `{"error": ..}` when it refuses:

| `operation` | Input | Output |
| --- | --- | --- |
| `account` | none | `account_id`: the key's implicit account |
| `attest` | `verifier`, `objective`, `params`, `deliveries`, `deadline`, `nonce`, `min_gas` | `verdict`, `review`, and `signed`: an `auth_call` attest intent to `objective`, signed for `execute_intents` |

Each of `deliveries` is `{report, tx, signer}`: a report's text, and the transaction that
delivered it with that transaction's signer. For each, the program fetches the finalized
transaction and requires a `delivered` event carrying the report's SHA-256, logged by a
successful receipt that `objective` executed. It refuses unless every slot of
`params.contributors` has such a delivery.

The verdict is `achieved` when every report contains `## Agenda`, and `failed` otherwise.
`review` is the program's record of what it judged (the objective, each contributor's
delivered hash, the criterion and the verdict), and the attestation's `review_hash` is its
SHA-256.

The deliveries are read from the account the intent is addressed to, so a verdict cannot be
obtained from one contract's events and spent on another.

This is a probe:

- It has one criterion, fixed in the code, and does not check it against `params.spec_hash`.
- Its review is its own format, not an `extents-spec` review.
- It trusts the worker's RPC for the transaction, and its caller for the Verifier and nonce.
- Its build is not reproducible, so its account cannot be re-derived from source by others.
