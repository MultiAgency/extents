# outlayer-evaluator

The evaluator program of the e2e's `outlayer-evaluator` scenario
([`../README.md`](../README.md)): a WASI module that [OutLayer](https://outlayer.ai)
runs in a TEE, and whose signing key belongs to this exact build.

- `manifest.json` is embedded in the wasm as the `outlayer.manifest` section. It declares
  the key `evaluator`: ed25519, `bind: "wasm"`, `caller: "none"`.
- `wit/signing-keys.wit` is a copy of OutLayer's `worker/wit/deps/signing-keys.wit`
  (`out-layer/outlayer` at `d127d49`), the host interface the key is used through.
- `.cargo/config.toml` builds for `wasm32-wasip2` into the repository's `target/`.

It takes one JSON object on stdin and prints one on stdout:

| `operation` | Input | Output |
| --- | --- | --- |
| `account` | none | `account_id`: the key's implicit account |
| `attest` | `verifier`, `objective`, `params`, `report`, `deadline`, `nonce`, `min_gas` | `verdict`, `review_hash`, and `signed`: an `auth_call` attest intent to `objective`, signed for `execute_intents` |

The verdict is `achieved` when the report contains `## Agenda`, and `failed` otherwise.
`review_hash` is the SHA-256 of the report.

This is a probe. The program trusts its caller for the report, the terms, the Verifier and
the nonce: it does not read what was delivered on chain, so anyone can have it attest
`achieved` for an objective that names it by supplying a passing report.
