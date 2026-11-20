# Working in Extents

Extents is a NEAR objective escrow, a Rust client and test harnesses, and a Bun/React app.

## Commands

Run from the repository root:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

Build the contract from `contracts/objective`:

```sh
cargo near build non-reproducible-wasm --locked --features=contract --abi-features=abi,contract
```

From `app`, run `pnpm test`, `pnpm typecheck`, and `pnpm exec playwright test`.
Browser tests start local Bun and mock-model servers. Live sandbox tests need Docker:
`cargo test -p extents-sandbox -- --ignored --test-threads=1`.
Set `EXTENTS_OBJECTIVE_WASM` to test a particular artifact. Public testnet e2e commands send
transactions and spend testnet balances; run them only when requested.

## Rules

- Preserve the Params and state encodings, deterministic account derivation, and JSON wire formats.
  Rust and TypeScript share vectors in `contracts/objective/tests/vectors` and `crates/spec/tests/vectors`.
  Do not regenerate pinned vectors to hide a regression. Explain deliberate format changes.
- `auth_caller` is always part of Params; it is not a Cargo feature. It must be absent or the
  Verifier that holds the token: `on_auth` trusts the signer its caller names.
- Funding is sponsor-only. Preserve receipt and delivery-proof verification, unknown-outcome
  recovery, Web Locks and DAO proposal deduplication.
- Keep amounts as integer atomic units or decimal strings. Use chain time for signed-intent deadlines.
- Keep protocol-format support distinct from app capabilities. File criteria remain a protocol
  format, but the app cannot launch them. Reports published by the app are public plaintext.
- Keep contract helpers pure where possible. Contract changes require a rebuilt WASM and an explicit
  hash comparison. Identical interfaces alone do not establish identical binaries.
- Publish only the reproducible build (`cargo near build reproducible-wasm`, in the pinned image).
  Local builds embed local paths. Sandbox evidence counts only for the exact hash that is published.
- Update docs to describe shipped behavior. Mark experiments and unimplemented work explicitly.
- NEAR Intents dependencies are pinned in Cargo.toml; do not modify the sibling `intents` checkout.
- Never commit credentials, API keys, `.env`, build outputs, or generated transaction dumps.
- Other sessions may be editing this tree. Announce before editing files another session may hold,
  and never delete or rewrite files you did not create without saying so.

## Layout

- `contracts/objective`: contract, fixed Params/state layout, events and payout gas rules.
- `crates/spec`: spec/review validation and canonical hashes.
- `crates/client`: pure objective calls and signed-intent wire formats.
- `sandbox`: tests against pinned Verifier/DAO binaries in a local chain.
- `e2e`: explicitly invoked public-testnet scenarios; generated reports are grouped by build hash.
- `app/src/shared`, `server`, `web`: protocol mirrors, API/model adapters, and browser UI.

See README.md, docs/app.md and docs/documents.md for the current behavior.

# Resources

References this code depends on. Others for local work are in `.agents/resources.md` (not tracked).

## NEAR Intents

Source Code:
https://github.com/near/intents

Docs:
https://docs.near-intents.org/llms.txt
https://docs.near-intents.org/llms-full.txt

Verifier Contract:
https://near.github.io/intents/defuse/index.html

Intent Enum:
https://near.github.io/intents/defuse_core/intents/enum.Intent.html

### Tidepool (1Click API-compatible testnet sandbox for NEAR Intents)

https://www.usetidepool.tech/openapi.json
https://www.usetidepool.tech/AGENTS.md
https://www.usetidepool.tech/llms.txt
https://www.usetidepool.tech/llms-full.txt

## NEAR Protocol

Source Code
https://github.com/near/nearcore

Docs:
https://docs.near.org/llms.txt
https://docs.near.org/llms-full.txt

### Relevant Standards

NEAR Enhancement Proposals (NEPs):
https://github.com/near/NEPs

NEP-141 ~ Fungible Tokens:
https://github.com/near/NEPs/blob/master/neps/nep-0141.md

NEP-245 ~ Multi Tokens, Verifier balances:
https://github.com/near/NEPs/blob/master/neps/nep-0245.md

NEP-448 ~ Zero-Balance Accounts (770-byte limit):
https://github.com/near/NEPs/blob/master/neps/nep-0448.md

NEP-519 ~ Yield/Resume Execution:
https://github.com/near/NEPs/blob/master/neps/nep-0519.md

NEP-591 ~ Global Contracts:
https://github.com/near/NEPs/blob/master/neps/nep-0591.md

NEP-616 ~ Deterministic Account IDs:
https://github.com/near/NEPs/blob/master/neps/nep-0616.md

### Rust SDK

https://github.com/near/near-sdk-rs
https://docs.rs/near-sdk

### Tooling

https://github.com/near/cargo-near
https://github.com/near/near-cli-rs
https://github.com/near/near-sandbox
https://github.com/near/near-sandbox-js
https://github.com/near/near-sandbox-rs
https://github.com/r-near/zorsh
https://github.com/r-near/zorsh-gen-rs
https://github.com/r-near/zorsh-schema-gen
https://github.com/r-near/near-abi-ts

### FastNear

https://github.com/orgs/fastnear/repositories

KV FastData API:
https://kv.main.fastnear.com/skill.md

Docs:
https://docs.fastnear.com/llms.txt
https://docs.fastnear.com/llms-full.txt

### NEAR Kit

https://github.com/r-near/near-kit
https://github.com/r-near/near-kit-rs
https://kit.near.tools/llms.txt
https://kit.near.tools/llms-full.txt

## NEAR AI

### Cloud

https://docs.near.ai/llms.txt
https://docs.near.ai/llms-full.txt

## Sputnik DAO and Trezu

Sputnik DAO Contract:
https://github.com/near-daos/sputnik-dao-contract/tree/main/sputnikdao2

Sputnik DAO Factory:
https://github.com/near-daos/sputnik-dao-contract/tree/main/sputnikdao-factory2

Trezu Custom Proposal Templates:
https://github.com/near-devhub/trezu/blob/main/docs/CUSTOM_PROPOSAL_TEMPLATES.md

Trezu Docs:
https://docs.trezu.org/llms.txt
https://docs.trezu.org/llms-full.txt
