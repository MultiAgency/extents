# NEAR Extents

Companion contracts to the NEAR Intents Verifier (`intents.near`). The Verifier
settles economic intents: transfers, withdrawals and `token_diff` swaps. Extents
extends this to social outcomes that need commitments from multiple parties,
e.g. *"I have USDC on NEAR, I want an event organized in NYC."*

Each objective is its own contract at a predictable address ([NEP-616]), holds
resources as balances on the Verifier, and settles through standard Verifier
transfers. Agencies are Sputnik DAOs, which fund and judge objectives through
ordinary proposals. The Verifier is not modified.

In the code, `sponsor` is the customer funding an objective.

Rust dependencies on NEAR Intents are pinned to Git revision
`dbad9c8a4659e8bd7f42c152ec79448a8e9d281c` in `Cargo.toml`. The sandbox fetches
its NEP-141 test token from the same revision, pinned by sha256.

## Contracts

### `extents-objective`

One objective: a sponsor's resources, released to committed contributors only if
an evaluator attests that the objective was achieved.

| Concern        | Mechanism                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------ |
| Objective      | `spec_hash` commits to the off-chain [spec](#extents-spec) the evaluator judges against    |
| Authority      | `evaluator` alone resolves, once, before the last moment to attest; it cannot also be a contributor |
| Resources      | a single NEP-245 token on the Verifier, funded by `sponsor` via `mt_transfer_call`                  |
| Commitment     | each contributor commits with `ob_commit`, or its named backup after `commit_by`; an achieved verdict needs every slot filled |
| Delivery       | each committed contributor records what it delivered, by hash, with `ob_deliver`                    |
| Accountability | payout follows the verdict; without one, [`acceptance_window_secs`](#silence) decides               |

The sponsor may also be the evaluator, as a DAO judging its own grants would
be. Contributors then trust the sponsor's own verdict on whether to pay them.

Like `escrow-swap`, which it follows closely, the account id is derived from
`Params` ([NEP-616]), so the address is known before deployment. Only the params
hash is stored, and every call passes `Params` in full.

```
             mt_transfer_call(fund)             ob_attest(achieved) ───────┐ contributors by share,
sponsor ───────────────────────────▶ objective ─┤   (all committed)         ├ remainder to sponsor
                                      (0s…)     ├ ob_close(), no verdict,  ─┘
contributors ── ob_commit ──────────▶           │   window set, all delivered
             ── ob_deliver ─────────▶           ├ ob_attest(failed)        ─┐
                                                └ ob_close(), no verdict,   ├ sponsor
                                                    otherwise              ─┘
```

**Interface:** `ob_view`, `ob_commit(params)`, `ob_deliver(params, delivery)`,
`ob_attest(params, attestation)`, `ob_close(params)`, and `mt_on_transfer` with
`msg = {"params": …, "action": {"action": "fund"}}`. An attestation is
`{"verdict": "achieved" | "failed", "review_hash"?: <hex>}`; the optional
`review_hash` commits to the evaluator's [review](#extents-spec) and is
published in the `resolved` event, so a verdict can be checked later. A
delivery is `{"hash": <hex>}`, published in the `delivered` event with the
last moment to attest after it (`attest_by`). Contributors and the evaluator
can also act through a signed `auth_call` intent on the Verifier (`on_auth`
with `msg = {"params": …, "action": {"action": "commit"}}`,
`{"action": "deliver", "data": <delivery>}` or
`{"action": "attest", "data": <attestation>}`), provided `params.auth_caller`
names the Verifier. `Params` with any other `auth_caller` are refused: the
contract trusts the signer its caller names.

**Addresses:** derive an objective's address from its `Params` and the code
hash, never accept one, and check that `Params.token` names the real Verifier:
any contract named there can emit a history of funding and verdicts for its
own fake token. Funding checks the address itself: it is refused unless the
account runs code fixed by hash (not by an account id, whose code can be
replaced) at exactly the address that code and the fresh state of these
`Params` derive. Code deployed with a hand-built state lands elsewhere and
can never be funded.

**Events:** count only events from receipts that succeeded. A receipt that
fails after logging keeps its logs: an `mt_on_transfer` that runs out of gas
after emitting `funded` is reverted and refunded, but its `funded` log
remains, as does a `resolved` logged by an attest or close that then ran out
of gas. Stop at an objective's first `cleanup`: anyone can redeploy the same
`StateInit` afterwards, and closing that copy emits a second `resolved`
(`expired`, nothing allocated).

**Funding from another chain:** a sponsor holding tokens elsewhere names its
own Verifier account as `sponsor`, for example the `0x…` account the Verifier
derives from its EVM key (`PublicKey::to_implicit_account_id`). It then:
1. bridges into that account with a 1Click quote whose `recipientType` is
   `INTENTS` and whose `refundType` is `ORIGIN_CHAIN`, with `refundTo` its own
   address there (not an `ANY_INPUT` quote, which never refunds);
2. polls `/v0/status` by deposit address until `SUCCESS`, `REFUNDED` or
   `FAILED`, and never pays again while the outcome is unknown;
3. signs a `transfer` intent to the objective whose notification `msg` is the
   fund message (the `notification` field of `Transfer` in Verifier v0.4.5),
   which reaches `mt_on_transfer` like `mt_transfer_call`.

1Click itself delivers to an `INTENTS` recipient as a plain balance credit
with no notification, so tokens it delivers straight to the objective are
never counted as funding (see Settlement). Not yet tried end to end: a
1Click quote to a `0x…` recipient, which its docs neither show nor rule out.

**Commitment and delivery:** a contributor commits once, before a verdict and
the deadline, and cannot withdraw. Once committed, it delivers once, by hash,
under the same conditions; a delivery cannot be undone. Funding does not wait
for commitments, so contributors can see the resources before agreeing. A
failed verdict or expiry needs no commitments.

**Backups:** `Params.backups` names a backup for some contributors' slots,
with `Params.commit_by` (required with backups, before the deadline). Before
`commit_by`, only the listed contributor can commit. After it, if the slot is
still empty, either the contributor or its backup may commit, and whoever
commits first holds the slot: its share, its delivery and its payout. A
committed slot never changes hands, so nobody is replaced mid-job. Backups
must name listed contributors, be distinct from every contributor and from
each other, and cannot be the evaluator. `State.taken` marks the slots a
backup holds, and payouts name whoever holds each slot.

<a id="silence"></a>**Silence:** `Params.acceptance_window_secs` is part of the
deal both sides see before committing, and decides what happens when the
evaluator does not attest.

- `None` (default): silence until the deadline resolves the objective as
  `expired` and returns everything to the sponsor. An escrow that fails
  closed; contributors rely on the evaluator they agreed to.
- `Some(secs)`: once every contributor has delivered, the evaluator has until
  the later of the deadline and `secs` after the last delivery to attest.
  Without a verdict by then, `ob_close` resolves the objective as `accepted`
  and pays the contributors as an achieved verdict would, with no review. If
  not everyone delivered, silence still expires.

Funding, commitment and delivery end at `Params.deadline` either way; only the
time to attest moves. Within it the evaluator can still attest `achieved` or
`failed`, and a `failed` verdict is final: there is no dispute path.

**Settlement:** the outcome moves the funded balance into `owed`, and the contract
sends each amount with `mt_transfer` on the Verifier. Failed transfers go back
into `owed`, and anyone can retry them with `ob_close`. After the last moment to
attest, once nothing is funded, owed or in flight, `ob_close` reads the
objective's own balance on the Verifier. Zero deletes the account. Anything
else is retained, never sent: a balance cannot tell a plain transfer from a
refused deposit whose refund has not executed, and nothing bounds how long
that refund takes. Always fund through `mt_transfer_call` with the fund
message. Payout callbacks never delete on their own.
Deletion waits for the last moment to attest so that redeploying the same
`StateInit` cannot reopen a settled objective.

**What it does not prove:**

- **Achievement.** The verdict is the evaluator's. The contract checks roles,
  timing and hashes, never the work.
- **Authorship or quality.** A delivery hash proves what was committed and
  when, not who made it or whether it is good.
- **Honest judging.** A bribed or captured evaluator, DAO majority included,
  is recorded like any other, and the contract sees no payment made off chain.
- **Privacy.** Params, specs, reports and reviews are public.
- **Safety.** No independent audit yet. Use testnet funds only.

**Known limits:**

- **A lost payout callback.** Payouts leave `owed` before they are sent, and
  only their callback (`ob_resolve_transfers`, 10 Tgas fixed) puts failures
  back. If that callback itself failed, the objective could not tell which
  transfers in the batch succeeded: it would neither retry nor delete (it is
  never settled with a callback outstanding), and the failed
  amounts would stay on its Verifier balance. With ten contributors the
  callback burns 1.8 of its 10 Tgas, and no way to make it fail has been
  found. A unit test pins this behaviour.
- **Plain transfers.** A plain `mt_transfer` to an objective is lost. Before
  deletion it is retained; after deletion it stays on the Verifier under an
  account no code controls, since the Verifier does not check that an account
  exists. Nobody else can claim that NEP-616 id, and nobody can move the
  balance.
- **Deletion can be blocked.** An objective deletes itself only at a zero
  balance, so anyone can keep one alive by sending it a unit. Deletion protects
  no funds or rights; it only clears state.

**Before committing**, a contributor checks what the contract can't, about
the sponsor and the evaluator:

- **A Sputnik DAO with `auto_update: true`** can have its code replaced by
  its factory without a vote. A `FactoryInfoUpdate` proposal turns that off.
- **Keys registered on the Verifier** (`public_keys_of`) can sign any intent
  for the account without its owner acting: an attestation, or a transfer of
  its whole Verifier balance. A DAO or MPC-derived account should have none
  beyond the one its signer derives.
- **A DAO acts by proposal**, which must pass within the DAO's proposal
  period and before the last moment to attest. With an acceptance window
  shorter than that period, silence decides instead of the vote.
- **Signed intents:** a refused `auth_call` still uses up the intent, since
  the Verifier doesn't wait for the callee, so a new one must be signed.
  Removing a key voids every outstanding intent it signed, including
  verdicts not yet submitted.

`contracts/objective/tests/vectors/params.json` pins the JSON and borsh
encodings of `Params`, their hash, the initial state and the NEP-616 account id
for four cases, so implementations in other languages can check against the
contract rather than against a deployment.

**Limits:** at most 10 contributors, with shares in pips summing to exactly
100%. A unit test checks that the worst-case state fits the 770-byte
zero-balance-account limit, assuming a global contract id of up to 64
characters.

## Formats

### `extents-spec`

The contract does not interpret `spec_hash` or `review_hash`.
[`crates/spec`](crates/spec) defines the documents they commit to, so that a
verdict can be checked by anyone holding the spec and the deliverables.

- **Spec:** the objective's statement and its criteria. Each criterion is one
  of `contains`, `schema`, `numeric_match`, `files`, `live_url`, `sources`,
  `media` or `llm_judge`. All but `llm_judge` are meant to be checked by a
  script. A spec has at most two `llm_judge` criteria and at least one other,
  so a model's answer is never the only gate. Each `llm_judge`
  names its models, one or three, and its outcome is their majority answer.
  A spec may pin `evaluator_build`, the hash of an attested evaluator
  program. Contributors see `spec_hash` in `Params` before they commit, so
  they agree to be judged against exactly these criteria.
- **Judge requests:** the crate builds the exact request body each model
  call sends (`judge_request`): a fixed system message, the question, and the
  deliverables between two fence lines derived from their own hash, which
  text inside them cannot contain. Anyone holding the deliverables rebuilds
  the request and checks its hash. Nothing stops an evaluator from calling
  again and keeping the answer it prefers; only an attested evaluator
  removes that.
- **Review:** the objective's account, the spec's hash, each contributor's
  deliverable by hash, one result per criterion (`pass`, `fail` or
  `skipped`), and each model call: its criterion, model, answer, request and
  response hashes, and the provider's signature. A judged `llm_judge` outcome
  needs one call per named model and must follow their majority. A review
  of a spec that pins `evaluator_build` records the same build. A review
  validates only if its verdict follows from its results: `achieved` only when
  every criterion passed, `failed` only when at least one failed. Results with
  something skipped and nothing failed support neither, so the evaluator
  doesn't attest. A consumer
  checks `objective` against the account the verdict was attested on, so a
  review cannot be reused for another objective with the same spec and
  contributors.
- **Evidence:** each result lists what was fetched to reach it, by URL and
  SHA-256 of the response body. A `live_url`, `sources` or `media` result
  that passed must have some, so a later check can run against the same bytes
  rather than a page that may have changed since. One that failed may have
  none (nothing to fetch, or nothing loaded), with its detail saying why.
- **Hash:** SHA-256 of the document's [RFC 8785] canonical JSON. A document is
  accepted only in normal form (no unknown fields, no `null` for an optional
  field left out), so one meaning has one hash. The vectors in
  `crates/spec/tests/vectors` pin the hashes for other languages. Their expected
  hashes were computed independently with Python's standard library.

An evaluator that cannot check anything writes no review and does not attest,
so an outage is never recorded as a failed verdict. What the silence then
does to the money is set by [`acceptance_window_secs`](#silence): without a
window, the sponsor is refunded just as a failed verdict would refund them.

The crate defines and validates the formats. It does not run any check.

## Status

Established, by unit tests under `near-sdk` mocking (`cargo test`):

- param validation, share rounding (the remainder goes to the sponsor), and
  rejection of tampered params
- commitment only by a listed contributor, once, before a verdict or the
  deadline; an achieved verdict only once all have committed
- funding only by the sponsor, only in the configured token, only before a
  verdict or the deadline
- one verdict, only from the evaluator, only before the deadline; expiry only
  after it
- events for commitments and for the allocation of an achieved and of a
  failed verdict, including the review hash
- committing, delivering and attesting through `on_auth`
- delivery only by a contributor who committed, once, before a verdict or the
  deadline; without a window it leaves the deadline alone
- backups: invalid backup params are rejected; before `commit_by` only the
  listed contributor commits; after it the first to commit holds the slot,
  and only the holder delivers and is paid
- with a window, the last delivery extends the time to attest past the
  deadline but not the time to fund; the evaluator can attest within it,
  `ob_close` is refused until it ends, and silence then resolves as
  `accepted` and pays the split; partial delivery, or no window, expires
- re-queuing a failed transfer and retrying it with `ob_close`
- deletion only after a zero balance read; nonzero unattributed balances
  are retained even after many blocks, including delayed refunds; an unreadable
  balance changes nothing
- a lost payout callback leaves no recovery path (the known limit above)
- worst-case state size
- the pinned `Params` and initial-state vectors (`--test vectors`)

Established for `extents-spec` by `cargo test -p extents-spec`: both vectors
hash to the independently computed values, and documents not in normal form,
with an unbounded `numeric_match`, three `llm_judge` criteria or only
`llm_judge` criteria, a verdict
contradicting the results (including `achieved` with a criterion skipped), a
missing result, the wrong spec, or a fetched criterion passed without evidence
are rejected; a fetched criterion may fail without evidence.

Delivery and the acceptance window (`ob_deliver`, `Outcome::Accepted`) have
not run on testnet: they change the contract's code hash, and the global
contract below has not been republished. The `accepted` e2e scenario is
written for that run.

Historical testnet evidence (predates current delivery, acceptance and cleanup changes):
established on testnet against Tidepool's Verifier, the same v0.4.5 build as
mainnet `intents.near`, by [`e2e/`](e2e/README.md) (2026-11-20). The run used
global code hash `FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa`, built with
`cargo-near` 0.22. Transaction hashes and balances are in
the dated observations in [`e2e/README.md`](e2e/README.md). New reports are grouped by WASM hash under `e2e/results/`.

- **Deployment.** Publishing by code hash cost 28.72 NEAR (10× storage).
  `StateInit` deploys at the account id derived from `init_state`. The
  instance uses 240 bytes and needs no NEAR. A `StateInit` deposit only
  covers missing storage stake, so it is refunded in full.
- **Funding and resolution.**
  - Funding by the sponsor's `mt_transfer_call`.
  - Commitment directly and by signed `auth_call` intent.
  - An achieved verdict is rejected until all have committed.
  - An achieved verdict pays each share exactly, with the remainder to the
    sponsor, directly and by `auth_call`.
  - A failed verdict returns everything.
  - `ob_close` is rejected before the deadline. After it, `ob_close` resolves
    as expired and returns everything.
  - `committed`, `resolved` (with `review_hash`), `paid` and `cleanup`
    events.
- **Payouts from a zero balance.** Each `mt_transfer` attaches 1 yoctoNEAR.
  At protocol 88 (`one_yocto_on_promise`, nearcore 2.14), that is not
  deducted while the contract's balance is zero, so an instance needs no NEAR
  at all. The contract relies on this.
- **Gas.** 10 contributors and 11 payouts settle in one `ob_attest`, burning
  54.4 Tgas. It needs about 182 Tgas prepaid against the 300 Tgas limit.
  Each transfer burns at most 4.2 of its 15 Tgas, and the callback at most
  1.8 of its 10 Tgas. The same settlement also works when the evaluator
  attests by signed `auth_call` intent. The Verifier burns 4.4 Tgas and
  forwards the remaining 295.6 Tgas to `on_auth`, of which the settlement
  burns 58.4 Tgas in total.
- **Deletion.** After the deadline, a settled instance deletes itself. That
  happens in the payout callback, or on a later `ob_close`. Any NEAR it holds
  goes to the signer of that transaction. NEAR can only be added by a plain
  transfer. (These runs predate the balance check: deletion now happens only
  through `ob_close`, after the objective's Verifier balance reads zero.)

Established in a local sandbox by [`sandbox/`](sandbox/README.md), against
the Verifier binary deployed at mainnet `intents.near` (code hash
`BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`), with the test holding the
Verifier's operator roles:

- **A failed payout and its retry.** With the objective's account locked by
  the Verifier's operator, the Verifier rejects every payout (`account '0s…'
  is locked`). The `lost` event reports them, and the amounts go back into
  `owed` exactly while the Verifier balance stays intact. Retrying with
  `ob_close` while still locked loses nothing. After unlocking, `ob_close`
  pays every share exactly. Past the deadline, `ob_close` then deletes the
  account.
- **The testnet scenarios, as a regression suite.** Achieved (refused until
  all have committed), failed, expired (with the `StateInit` refund and
  deletion paying the closer), commitment and attestation by signed intent,
  and ten contributors settling in one transaction, directly and by signed
  intent. Deadlines are reached by producing blocks, so the suite needs no
  faucet or real waiting.
- **Stray funds** (`sandbox/tests/stranded.rs`). A plain `mt_transfer`
  lands on the objective's Verifier balance but never in `funded`, and stays
  there: closing after the deadline neither sends it nor deletes the
  objective. A funding deposit whose `mt_on_transfer` runs out of gas is
  refunded in full and never counted.
- **A backup taking a slot** (`sandbox/tests/backups.rs`). Before
  `commit_by` the backup is refused; after it, with the listed contributor
  absent, the backup commits, the contributor's late commit is refused, and
  the achieved verdict pays the backup that slot's share through the
  Verifier.

Established on testnet by [`e2e/`](e2e/README.md#a-dao-signing-intents-by-vote)
(2026-11-20), independently of the objective contract:

- **A DAO signing intents by vote.** A Sputnik DAO acts on the Verifier as
  the implicit account of the key the MPC signer (`v1.signer-prod.testnet`)
  derives for it on path `agent-owner`.
  - The council approved a `FunctionCall` proposal to the signer's `sign`.
    The signature arrived in the executing transaction, and a relayed
    `execute_intents` moved the DAO's balance on the Verifier.
  - No key was delegated or registered with `add_public_key`. A registered
    key could sign any intent for the account, including a transfer of the
    whole balance.
  - Each proposal carries the payload beside its hash. `extents-e2e dao
    verify` recomputes the hash and checks the signer, the Verifier and the
    deadline before anyone votes.
  - A Trezu template (`e2e/trezu/sign-intents.json`) files exactly those
    args.

Not yet established:

- **A DAO funding, committing to and attesting an objective by intent.** The
  signing path is shown, but objective calls on testnet need the current
  contract republished, because `Params` gained fields since `FS91Wimv…`.
- **Filing through Trezu's UI.** The template's output is checked against
  the CLI's by a unit test, but it hasn't been loaded into Trezu.
- **Funding and deploying in one step.** `StateInit` on Verifier transfers and
  `auth_call` is commented out on Intents `main` (pending `UniversalStateInit`),
  so deployment is a separate `state_init` action for now.

## Development

```sh
cargo test
cargo clippy --all-targets --features abi
RUSTFLAGS='--cfg=near' cargo clippy -p extents-objective --target wasm32-unknown-unknown --features contract
cargo fmt --all -- --check
```

Build the contract with the pinned flags, then run the sandbox (Docker, all
local) against that exact file:

```sh
(cd contracts/objective && cargo near build non-reproducible-wasm --locked --features=contract --abi-features=abi,contract)
EXTENTS_OBJECTIVE_WASM="$PWD/target/near/extents_objective/extents_objective.wasm" cargo test -p extents-sandbox -- --ignored
```

A build to publish comes from `cargo near build reproducible-wasm`, in the
image `[package.metadata.near.reproducible_build]` pins, from a committed
tree. Publish only the file the sandbox ran against. The app's release
manifest is described in [`docs/app.md`](docs/app.md).

[NEP-616]: https://github.com/near/NEPs/blob/master/neps/nep-0616.md
[RFC 8785]: https://www.rfc-editor.org/rfc/rfc8785
