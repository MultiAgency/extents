# extents-e2e

End-to-end test of `extents-objective` on NEAR testnet, against Tidepool's
unmodified Verifier (`verifier.tidepool-sandbox.testnet`, `defuse` v0.4.5).

Each instance's account id and initial state come from the crate's own
`Params` and `ContractStorage::init_state`. Each `msg` is a serialized
`TransferMessage` or `auth_call::Message`. The bytes sent on-chain therefore
come from the same code as the contract. The Verifier's intent wire format
(NEP-413 payload, versioned nonce) is written out in `extents-client` (`crates/client`) against
the v0.4.5 tag, because the sibling `intents` checkout is ahead of the
deployed build. Because of that, `run` and `dao` first check that the
live Verifier's code hash is that build's (`extents_client::VERIFIER_SHA256`),
and refuse to run otherwise. Results against another build would be
credited to the wrong one.

Commands run from `extents/`.

## Setup

1. **Tooling.** cargo-near 0.22 (the Verifier's build tool; 0.16 fails), and
   testnet credentials for a parent account in `~/.near-credentials/testnet/`.

   ```sh
   cargo install cargo-near --version 0.22.0 --locked
   ```

2. **Build the wasm** and note its sha256, which is the global contract's
   code hash:

   ```sh
   (cd contracts/objective && cargo near build non-reproducible-wasm --locked \
     --features=contract --abi-features=abi,contract)
   ```

3. **Create the accounts.** `<prefix>-{sponsor,evaluator,deployer,c0..c9}.<parent>`
   (defaults `e2e`, `agency.testnet`) are created from the parent. Existing
   accounts are topped up to a minimum: 1 NEAR for the sponsor, evaluator and
   deployer, and 0.5 NEAR for each contributor, about 8 NEAR in total.

   The minimum is higher than the gas actually burnt because a transaction
   must cover its prepaid gas at the pessimistic gas price. 300 Tgas
   (`ob_attest`, `ob_close`, `execute_intents`) needs about 0.301 NEAR on
   testnet, and most of it is refunded. Keys are written to
   `~/.near-credentials/testnet/` in near-cli's format. A key left there by an
   earlier attempt is reused.

   ```sh
   cargo run -p extents-e2e -- accounts
   ```

4. **Publish the global contract.** The deployer is topped up from the
   parent first. Global code costs 10× regular storage (1e20 yocto per byte),
   which is 28.72 NEAR for 287 KB, burned rather than staked. This step is
   skipped if the code hash is already published.

   ```sh
   cargo run -p extents-e2e -- publish
   ```

5. **Faucet (manual step).** The sponsor needs USDC on the Verifier, and
   Tidepool's faucet only works through its website:
   <https://app.usetidepool.tech/faucet>. Enter the sponsor and choose
   **intents** mode, so the 100 USDC is credited on the Verifier rather than
   to the wallet. The account must be at least 3 hours old, and an address can
   claim once every 7 days. To skip the wait, use an older account as the
   sponsor with `--sponsor <account>` (or `E2E_SPONSOR`), and claim for that
   account instead. Check the result with:

   ```sh
   cargo run -p extents-e2e -- balances
   ```

## Run

```sh
cargo run -p extents-e2e -- run deposit achieved failed expired auth-call max max-auth-call accepted dao-objective dao-intent-objective
```

| Scenario    | What it shows                                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deposit`   | Deploys with no deposit and attests `achieved` from a zero NEAR balance. Every `mt_transfer` attaches 1 yocto, and the balance stays 0.                                                                                                                          |
| `achieved`  | 70/30 split. An achieved verdict with one of two commitments and no deliveries must fail with `not all contributors have delivered`. Once both have committed and delivered, it checks the `committed`, `delivered`, `resolved` (with `review_hash`) and `paid` events, and each balance change, including the sponsor's rounding remainder. |
| `failed`    | A failed verdict returns everything to the sponsor.                                                                                                                                                                                                              |
| `expired`   | A `StateInit` deposit is refunded. NEAR sent by a plain transfer stays. `ob_close` before the deadline fails. After the deadline it returns the funds, and the account deletes itself in the same transaction, paying its remaining NEAR to the closer.            |
| `auth-call` | `auth_caller` is the Verifier. Each contributor commits and delivers, and the evaluator attests, by a signed NEP-413 `auth_call` intent, relayed to `execute_intents` by the deployer. Keys are registered with `add_public_key` first.                                       |
| `max`       | 10 contributors and 11 payouts (one is the sponsor's remainder) in one `ob_attest`. Records the gas of every receipt.                                                                                                                                           |
| `max-auth-call` | As `max`, with the evaluator attesting by a signed `auth_call` intent whose `min_gas` is `Params::attest_gas` (210 Tgas; the recorded run used 190). Records how much gas the Verifier forwards to `on_auth`.                                                                                                     |
| `dao-objective` | The DAO's own account (`e2e-agency.sputnikv2.testnet`) is sponsor and evaluator, as an agency's treasury is. It funds by a `FunctionCall` proposal to `mt_transfer_call` and attests by one to `ob_attest`, each approved by both council members. Contributors are `c2` and `c3`. |
| `dao-intent-objective` | As `dao-objective`, for the DAO's MPC-derived account. It funds with a `transfer` intent carrying the fund `msg`, and attests with an `auth_call` intent, each signed by vote through `v1.signer-prod.testnet` and relayed. The intents' deadline covers the DAO's whole proposal period plus 10 minutes. |
| `accepted`  | `acceptance_window_secs` is 180 s. Both contributors commit and deliver; the last delivery's `attest_by` falls after the deadline. `ob_close` is refused after the deadline while the window is open, and after it resolves as `accepted` with no review, paying the 70/30 split. Needs a contract published after `ob_deliver` was added. |

Every scenario except `expired` ends by waiting for its deadline and calling
`ob_close`, which deletes the account; the run then confirms with
`view_account` that it no longer exists. The deadline is 110 s plus 20 s per
contributor: 150 s with two contributors, 310 s with ten. A full run takes
about 30 minutes and spends about 5 USDC.

Each scenario writes `e2e/results/<wasm-sha256>/<scenario>.json`, with every transaction,
its receipts (gas and deposit attached, gas burnt, failures), the
`extents-objective` events, and Verifier balances before and after.
Each build directory has its own generated `RESULTS.md`. Records include the objective WASM SHA-256 and pinned Verifier SHA-256; generated directories are ignored by Git. To check generated documents against the TypeScript mirror, run `E2E_RESULTS_DIR=<absolute-build-directory> pnpm test` from `app`. Every instance's
params are also printed when it is deployed, so an interrupted run can still
be closed by hand.

## Findings (2026-11-20)

The historical observations below are from one full run against
`verifier.tidepool-sandbox.testnet`, with global code hash
`FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa` (sha256 `d674315c…ac39`,
published in tx `Cp1VbSN5rfdsYpsVXWw6y26KQJAvGq5UYvLXfypGoJ1o`) and
`nearbuilders.testnet` as the sponsor. All 74 checks passed.

`achieved`, `failed` and `auth-call` were then rerun with the same code hash,
once the e2e built its spec and reviews with
[`extents-spec`](../crates/spec) instead of hashing placeholder strings. Their
results replace the earlier ones. Each now records the spec and every review in
its JSON. A `review_hash recomputed` check reads the review back as a document,
validates it against the spec, matches its hash to the one in the `resolved`
event, and checks that the review names the objective it was attested on. It
passed in all three, and each objective's review has its own hash. The spec
and reviews are synthetic: nothing is delivered, and the results are scripted.

`max-auth-call` was added afterwards and run on its own, with the same code
hash, through `rpc.testnet.fastnear.com`. Two earlier
attempts through `rpc.testnet.near.org` failed when HTTP 429 retries pushed
the attestation past the deadline. The contract rejected it as it should, and
`ob_close` returned the funds. All 20 checks passed.

**1. Deposit at deploy: none is needed, and none is kept.**

- A `StateInit` deposit only covers missing storage stake (nearcore 2.14.1
  `settle_state_init_deposit`). A 240-byte instance needs none, so the whole
  deposit is refunded to the signer. In `expired`, 0.001 NEAR went straight
  back to the sponsor and the instance held 0.
- A zero-balance instance can still pay out. With `one_yocto_on_promise`
  (enabled on testnet and mainnet at protocol 88), a 1-yocto promise deposit
  is not deducted from a contract whose balance is zero
  (`near-vm-runner/src/logic/host.rs`). In `deposit`, three `mt_transfer`s
  each attached 1 yocto, and the balance was 0 before and after
  (tx `4zfsWJBaoixzdsVy771q2SjJ349gwEjpBS8APMvJVzn9`). The archival RPC
  shows 0 in every block.
- With a non-zero balance (NEAR sent by a plain transfer), the yocto is
  deducted as usual (`expired`).

**2. Gas: 10 contributors fit in one transaction, with room to spare.** In
`max`, `ob_attest` (tx `E74Vf2rGobjEAbxMoCRHnYduf5VFjgxThVhTFtkecXgz`) burnt
54.4 Tgas in total.

| Receipt                | Attached        | Burnt                     |
| ---------------------- | --------------- | ------------------------- |
| `ob_attest`            | 300 (prepaid)   | 6.74                      |
| `mt_transfer` (11)     | 15 each         | 3.77–4.06 each            |
| `ob_resolve_transfers` | 10              | 1.77 (1.49 for 1 payout, 1.54 for 3) |

The static reservation is 11 × 15 + 10 = 175 Tgas. With `ob_attest`'s own
execution, the call needs about 182 Tgas prepaid, within the 300 Tgas
limit. Each transfer uses at most 28% of its allotment.

The same settlement through `auth_call` (`max-auth-call`, tx
`7vGYZUEEGJag7Ts7jE6qBc6WhEMyB7T8498WM49ia66A`, all 20 checks passed) also
fits.

| Receipt                | Attached | Burnt          |
| ---------------------- | -------- | -------------- |
| `execute_intents`      | 300      | 4.45           |
| `on_auth`              | 295.56   | 6.81           |
| `mt_transfer` (11)     | 15 each  | 3.77–3.97 each |
| `ob_resolve_transfers` | 10       | 1.77           |

With no deposit attached, the Verifier calls `on_auth` directly and forwards
all the gas `execute_intents` does not use. `min_gas` (190 Tgas here) is
therefore only a floor; `on_auth` received 295.6 Tgas.

**3. Retries: a failed payout could not be forced against this Verifier.**

In v0.4.5, `internal_mt_batch_transfer`
(`contracts/defuse/src/contract/tokens/nep245/core.rs`, lines 173–193)
rejects a transfer when:

- it is to oneself;
- an amount is zero;
- the sender's balance is short;
- the sender is locked.

Locked receivers still receive. As a payer, the objective can hit none of
these:

- It cannot be its own contributor, because its id is derived from its
  params.
- `resolve` skips zero amounts.
- Its Verifier balance always equals what it owes.
- Gas is no lever: each transfer burns at most 4.17 of its 15 Tgas.

Only the Verifier's operator could make a payout fail. It can pause
`mt_transfer` (`#[pause]`), or lock the instance with `force_lock_account`
(`Role::UnrestrictedAccountLocker`). That is exactly the case the retry path
is for, but it cannot be triggered on Tidepool without its admin role.
Re-queuing into `owed` and retrying through `ob_close` are therefore covered
only by the unit test; no failure was simulated.

**4. Who receives the balance on deletion: the signer of the final
transaction.**

- In `expired`, the instance held 0.001 NEAR. The payout's 1 yocto was
  deducted, and `DeleteAccount` paid the closer, `e2e-deployer`, the remaining
  999,999,999,999,999,999,999 yocto
  (tx `2ZbY1QVfpAyzRGuqLKgWqnmUpPAAabJaYHEEpcBM8otw`). Its gas refunds were
  separate receipts.
- An instance that never received NEAR holds 0, so deleting it pays nothing,
  as in every other scenario.

## A DAO signing intents by vote

An agency is a Sputnik DAO. On the Verifier it acts as the implicit account
of an Ed25519 key that NEAR's MPC signer derives for it (`derived_public_key`
on path `agent-owner`, domain 1). The MultiAgency platform uses the same
derivation for a DAO's owner account.

Only the DAO can ask for a signature with that key. It does so with a
`FunctionCall` proposal to the signer's `sign`, which runs once the council
approves it. No key is delegated to an agent, so every intent the DAO signs
is a vote. This matters because a key registered on the Verifier with
`add_public_key` can sign any intent for its account, including transfers
of the whole balance. The Verifier has no per-intent scoping.

```sh
cargo run -p extents-e2e -- dao create             # e2e-agency.sputnikv2.testnet, council c0 and c1
cargo run -p extents-e2e -- dao show               # its derived account and Verifier balance
cargo run -p extents-e2e -- dao fund 2000000       # sponsor → the DAO's account, on the Verifier
cargo run -p extents-e2e -- dao transfer 1000000   # the DAO signs a transfer back, by vote
cargo run -p extents-e2e -- dao verify <id>        # what a sign proposal would sign
cargo run -p extents-e2e -- dao prepare '<intents JSON array>'   # fields for the Trezu template
```

The testnet factory (`sputnikv2.testnet`, contract version 3.31) deploys the
DAO's code to its account, so creating one costs 5.4 NEAR, held as the DAO's
storage stake. The policy is Sputnik's default with a 0.1 NEAR proposal bond.
With a council of two, both must approve.

**What voters see.** A vote approves a 32-byte hash, so each sign proposal
also carries the payload it hashes, as a JSON string in an `intent` argument
beside the signer's `request`. The signer ignores that argument. Voters see
both in the proposal's args. `dao verify` recomputes the NEP-413 hash from
the `intent` and checks the rest before anyone votes:

- the proposal calls `v1.signer-prod.testnet`, with exactly one action,
  `sign`;
- it signs with this DAO's key (path, domain);
- the signed hash is the NEP-413 hash of the attached payload;
- the payload's signer is this DAO's account, its recipient is the Verifier,
  and it hasn't expired.

The binding is checked by tooling, not enforced on-chain. Unit tests show
that `verify` catches each of these:

- a hash that signs a different payload than the one shown;
- a payload for another signer;
- another key path;
- another receiver;
- an extra action.

**Trezu.** [`trezu/sign-intents.json`](trezu/sign-intents.json) is a Trezu
custom proposal template that files exactly these args from two fields,
`intent` and `hash`, which `dao prepare` prints. A unit test checks that the
manifest, with those values substituted, produces byte for byte the args the
CLI files, and `dao transfer` files that same form on-chain. To use it, a
member with the DAO's `ChangePolicy` permission pastes it at
`/<dao>/custom-templates/create` in Trezu. Trezu stores templates in its own
backend, per DAO. Filing through Trezu's UI itself has not been tried. On
mainnet, `binding.receiver_id` is `v1.signer`.

**Shown on testnet (2026-11-20).** DAO `e2e-agency.sputnikv2.testnet`
(created in tx `5UF9PVRyLMJvbhoEqPJdAJ6jjAw1HUB5GjHenPy4PBMA`), derived
account `aa59f4f8d95bb6f755c51939c6504e4d9fe9b63cf4594cd31d47b8c1ee9f48f0`.

- The run was proposal 1, in the template's string form. Its transaction
  dump is no longer checked in (see [`results/RESULTS.md`](results/RESULTS.md)).
  1. `e2e-c0` filed it (tx `DoCph2tizJTPg4AWESNePbARP1xP9sAbcHaiogyneZVT`),
     and it verified.
  2. `e2e-c0` approved it (tx `CbkNg7aFDCU82pJmowUB3NYWHzZ2FYqFEv3caWkRc3QY`).
  3. `e2e-c1` approved it (tx `Gx6p5bSTtGUA8tbutkNipKMqfbgaFGxv313kq2M5XtZv`).
     That vote executed `sign`, and the MPC signature arrived in the same
     transaction. It verified against the derived key, and `simulate_intents`
     accepted it.
  4. A relayed `execute_intents` (tx
     `2BbVLoi9zWqkurhgLsqAAWx4XfptVc6QWyc6dUqog361`) moved 0.5 USDC from the
     DAO's account to the sponsor.
- An earlier run, proposal 0, filed the payload as a JSON object instead of a
  string and also passed (tx `47aGsQe4MVDYypxQZm7zERGsjo3Ntw74BMEUFezX7uvN`).
- From filing to execution took about 27 seconds.
- Signing directly with `v1.signer-prod.testnet`, with an extra argument
  beside `request`, took about 14 s and cost 1 yoctoNEAR (tx
  `2wwamWaos7JVvPRannPc9X4cEUHgqEhJhrw9RctvuCzG`).

**Not shown yet.** Funding an objective (a `transfer` intent with the fund
`msg`), committing, and attesting (`auth_call` intents) as the DAO. These need
the current objective contract on testnet. The published one (`FS91Wimv…`)
predates the `acceptance_window_secs` field, so it hashes `Params`
differently.

## Configuration

Flags or environment variables: `--parent`/`E2E_PARENT`,
`--prefix`/`E2E_PREFIX`, `--sponsor`/`E2E_SPONSOR`,
`--verifier`/`E2E_VERIFIER`, `--token`/`E2E_TOKEN` (the token id inside the
Verifier, e.g. `nep141:usdc.tidepool-sandbox.testnet`), `--wasm`/`E2E_WASM`,
`--results`/`E2E_RESULTS`, `--rpc`/`E2E_RPC`.

**RPC.** The default endpoint is `https://rpc.testnet.fastnear.com`. A run
makes dozens of RPC calls per step. Both `rpc.testnet.near.org` and keyless
FastNEAR answer bursts with HTTP 429, and near-kit's retries then stall a run
past its deadlines. Set `FASTNEAR_API_KEY` to a FastNEAR key, and it is sent
as `Authorization: Bearer`. It has no flag and never goes in the URL, so it
stays out of shell history and logs.

Variables can also go in `extents/.env`. It is git-ignored and should be
readable only by you (`chmod 600 .env`). It is loaded at startup from that
fixed path, never from the working directory or its parents. A missing file
is fine, but a malformed one stops the run rather than letting it continue
without its keys. Variables already set in the environment take precedence.
