# outlayer-evaluator

The evaluator program of the e2e's `outlayer-evaluator` scenario
([`../README.md`](../README.md)): a WASI module that [OutLayer](https://outlayer.ai)
runs in a TEE, and whose signing key belongs to this exact build. An experiment: neither
the contract nor the app depends on it.

- `manifest.json` is embedded in the wasm as the `outlayer.manifest` section. It declares
  the key `evaluator` (ed25519, `bind: "wasm"`, `caller: "none"`) and the one host the
  program may reach, `api.github.com`.
- `src/judge.rs` judges reports against a spec, with the fetching passed in. Its tests run
  on the host: `cargo test --target "$(rustc -vV | sed -n 's/host: //p')"`.
- `src/program.rs` is the program as the worker runs it: input, output and host interfaces.
- `wit/signing-keys.wit` is a copy of OutLayer's `worker/wit/deps/signing-keys.wit`
  (`out-layer/outlayer` at `d127d49`), the host interface the key is used through.
- `wit-rpc/rpc.wit` is a copy of OutLayer's `near:rpc` host interface
  (`wasi-examples/rpc-test-ark/wit/world.wit` at the same commit), through which the program
  reads transactions.
- `.cargo/config.toml` builds for `wasm32-wasip2` into the repository's `target/`.
- `build.sh` is the build to publish and to check: see [Reproducing the build](#reproducing-the-build).

It takes one JSON object on stdin and prints one on stdout, `{"error": ..}` when it refuses:

| `operation` | Input | Output |
| --- | --- | --- |
| `account` | none | `account_id`: the key's implicit account |
| `attest` | `verifier`, `objective`, `params`, `spec`, `deliveries`, `deadline`, `nonce`, `min_gas` | `review`, and `signed`: an `auth_call` attest intent to `objective`, signed for `execute_intents` |

## What it checks before it signs

1. **The terms.** `spec` must be a valid `extents-spec` document whose hash is
   `params.spec_hash`. It is parsed and hashed by [`crates/spec`](../../crates/spec) itself.
2. **The deliveries.** Each of `deliveries` is `{report, tx, signer}`: a report's text, and
   the transaction that delivered it with that transaction's signer. The program fetches the
   finalized transaction and requires a `delivered` event carrying the report's SHA-256,
   logged by a successful receipt that `objective` executed. Every slot of
   `params.contributors` must have one.
3. **The criteria**, for every report:
   - `contains`, as the app checks it.
   - `live_url`, with a rule of this evaluator's own: the URL on the report's label line is
     fetched only if the spec names that exact URL as the phrase of a `contains` criterion,
     and it is on `api.github.com`. Anything else the report cites fails without a fetch. A
     redirect is not followed. A JSON page is matched in its compact form as well as the
     form it was served in: GitHub serves one document with or without whitespace between
     tokens from one request to the next, so `must_contain` is written compactly.
   - Any other kind is refused: the program gives no verdict on a spec it cannot judge.

The deliveries are read from the account the intent is addressed to, so a verdict cannot be
obtained from one contract's events and spent on another.

## What it signs

`review` is an `extents-spec` review, valid against the spec: each contributor's delivered
hash, one result per criterion, and for a fetched page its URL and the SHA-256 of the
response. Its `evaluator_build` is the spec's; a build cannot read its own hash, and only
this build's key signs for the account in the terms. The attestation's `review_hash` is the
review's hash.

The verdict is `achieved` when every criterion passes. It is `failed` only for what the
reports settle for good: a missing phrase, or a citation the spec does not name. Anyone can
run this program at any time, so it never fails what may still come true. It refuses, and
signs nothing, when:

- a named page loads but does not yet show what it must (a pull request still open);
- the page, or the RPC, cannot be reached or answers with an error status.

The objective then stays open, and expires and refunds unless a later run can judge it.

## Limits

- Two kinds of criterion. Its `contains` and `live_url` follow `app/src/server/checks.ts`
  but are a second implementation of them.
- A named URL must be known when the objective is launched: it suits paying for an open
  pull request, not for whichever pull request later closes an issue.
- `must_contain` is still a substring test: it finds a key and value somewhere in the
  page, not at a place in its structure.
- It trusts the worker's RPC for the transaction, and its caller for the Verifier and nonce.

## Reproducing the build

```sh
./build.sh
```

builds in the official Rust image, named by the digest of its `linux/amd64` manifest, with
the repository mounted at a fixed path and a fresh cargo home and target directory. It writes
`target/outlayer-evaluator/reproducible/outlayer-evaluator.wasm` at the repository's root and
prints its sha256, which is what OutLayer binds the key to and what a spec pins as
`evaluator_build`. It needs Docker, and the network for the toolchain's target and the
crates of `Cargo.lock`.

The bytes depend on the sources the program is built from: this directory, with its
`Cargo.lock`, and [`crates/spec`](../../crates/spec) with the root `Cargo.toml` it takes its
dependency versions from. A change to any of them is another program, with another account.

At commit `0f7b0f8` it prints
`6ff917139fd3ae85d0092ed9d5869e6c43a397a808a86804f729e27d258957f6`, from a clean export of
that commit: the program of the testnet run recorded in [`../README.md`](../README.md).

Measured on one machine (Apple silicon, Docker Desktop): two builds from checkouts at
different paths gave identical bytes. The same sources built in the image's `linux/arm64`
variant gave different bytes, so the architecture is part of the recipe. A plain
`cargo build --release` on the host gives a third binary: fine for the tests, not a hash
anyone else can check. Whether another machine reproduces the hash has not been tried.
