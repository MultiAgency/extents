# NEAR Extents: specification (draft for review)

Status: draft for review. Written for MultiAgency/product-board#23, part of MultiAgency/product-board#21.
Sources: `README.md`, `docs/design-notes.md`, `docs/documents.md`, `docs/citynode.md`, `crates/spec`.
Where this draft and the code disagree, the code and the pinned vectors win; please flag it.

The rules are in [§7](#7-rules), one `####` heading each. Tests cite the rule they check as
`docs/spec.md, "<heading>"`, and other docs link to it rather than restating it; `app/test/rules.test.ts`
fails on a rule no test cites and on a citation or link to a heading that does not exist.

## 1. Purpose

The NEAR Intents Verifier settles economic intents: transfers, withdrawals and `token_diff`
swaps that net to zero. Extents extends it to social outcomes that need commitments from
several parties, for example "I have USDC on NEAR, I want an event organized in NYC."

Extents is a set of companion contracts. The Verifier is not modified.

## 2. Model

An **objective** is one contract with:

| Role | Who |
| --- | --- |
| Sponsor | the party funding the objective (customer, or a DAO) |
| Contributors (up to 10) | the parties doing the work, each with a share of the payout |
| Backups | optional named stand-ins for a contributor's slot |
| Evaluator | the single judge, which may be the sponsor |

What each role may do, and when, is in [§7](#7-rules).

- **Address.** Each objective is its own account, at the address its terms derive
  ([rule](#the-address-derives-from-the-terms)).
- **Resources.** One NEP-245 token, held as a balance on the Verifier (`intents.near`), funded
  by the sponsor with `mt_transfer_call`.
- **Lifecycle.** fund, commit, deliver, attest, settle, close. Commit, deliver, withdraw and
  attest also work through a signed `auth_call` intent on the Verifier.
- **Outcomes.** `achieved` (pays contributors by share, remainder to the sponsor), `failed`
  (refunds the sponsor), `expired` (no verdict by the deadline, refund), `accepted` (silence
  after full delivery under an acceptance window, pays as achieved), `released` (the
  sponsor's own concession, pays as achieved), `cancelled` (sponsor withdraws funding before
  any commitment).
- **Example.** A Sputnik DAO funds a 30-day, $5k objective for a scoped job. Contributors
  commit on-chain, the evaluator attests with the hash of its written review, and payment
  releases only on an `achieved` verdict. Otherwise the funds return to the DAO.

## 3. How the outcome is judged

The contract cannot see the real world. It checks roles, timing and hashes, never the work.
Everything therefore depends on a measurable spec and an evaluator people can trust.

### 3.1 What `spec_hash` commits to

`Params.spec_hash` is the SHA-256 of the RFC 8785 canonical JSON of an **extents-spec**
document (`crates/spec`). Contributors see the hash before they commit, so they agree to be
judged against exactly those criteria.

A spec holds the objective's statement and its criteria. Each criterion is one of
`contains`, `schema`, `numeric_match`, `files`, `live_url`, `sources`, `media`, `llm_judge`.

All criteria except `llm_judge` are meant to be checked by a script. A spec may pin
`evaluator_build`, the hash of an attested evaluator program. What makes a spec valid is in
[§7.4](#74-specs-and-reviews); shared vectors in `crates/spec/tests/vectors` pin its hashes for
other languages.

A **measurable** spec is one where each criterion can be answered pass/fail from deliverables
the contributors publish (reports, URLs, files, figures), not from the evaluator's taste.

### 3.2 Who evaluates

The evaluator is named in `Params` and is the agreed authority. The intended evaluator is the
**City Node DAO overseeing the agency**: a Sputnik DAO that attests by passing a
`FunctionCall` proposal to `ob_attest`, or by an intent its council signs. The evaluator is
never the community doing the work. A sponsor may also be the evaluator (a DAO judging its
own grants); contributors then trust the sponsor's own verdict.

### 3.3 Review and verdict

The evaluator checks each contributor's published report, validates a **review** against the
spec, publishes it, and attests with the review's hash (`review_hash`), which appears in the
`resolved` event so anyone can verify the verdict later. With several contributors,
[a criterion holds for the deliverable as a whole](#a-criterion-holds-for-the-deliverable-as-a-whole):
the reports together, never whichever comes first.

A review records: the objective account, the spec hash, each contributor's deliverable by
hash, one result per criterion (`pass`, `fail`, `skipped`), the evidence fetched (URL and
SHA-256 of each response body, and optionally the HTTP status, the content type and, after a redirect, the URL it
ended at), and every model call (criterion, model, answer, request and
response hashes, provider signature).

A review is valid only if [its verdict follows from its results](#a-verdict-follows-its-results).

### 3.4 When the evaluator is silent

Set by `Params.acceptance_window_secs`, visible before anyone commits: see
[silence fails closed](#silence-fails-closed-unless-the-terms-say-otherwise). A `failed` verdict is
final. There is no dispute path.

## 4. Risk spread over time: milestones

Splitting work into milestones, each its own objective, spreads the risk and gets money to the
people doing the work sooner.

- Each milestone is a separate objective with its own contract, spec, deadline, funding and
  evaluator verdict. A failed or expired milestone refunds only its own funding.
- Contributors are paid when their milestone is attested, not at the end of the whole job.
- The sponsor can fund milestone N+1 after milestone N resolves, limiting exposure to one
  milestone.
- Nothing in the contract links one milestone to another. Ordering, sequencing and
  "fund the next only if the last achieved" are decisions made by the sponsor or agency,
  not enforced on chain.

## 5. Composition: agencies and sub-objectives

The sponsor names one agency. The agency breaks the work into **sub-objectives**; each one
requires its contributors to commit, and is set to end before its parent's deadline.

- A sub-objective is an ordinary objective. Its sponsor is the agency (typically a Sputnik
  DAO), and its contributors are the people or sub-agencies doing the work.
- **The ordering rule is set by agencies, not enforced.** The contract does not check, across
  objectives, that a child's deadline precedes its parent's, nor that a parent's contributors
  correspond to the children. Agencies must set deadlines accordingly, and reviewers of a
  parent objective should check the children.
- Subcontracting is therefore a convention built on ordinary funding and attestation, with
  no cross-objective call in the contract.

## 6. Documents and evidence

| Document | Commitment | Publisher |
| --- | --- | --- |
| Params | Borsh/Keccak hash in initial state; fixes the account address | Sponsor at launch |
| Spec | SHA-256 of canonical JSON in `Params.spec_hash` | Sponsor at launch |
| Report | SHA-256 of its UTF-8 bytes in the `delivered` event | The slot holder |
| Review | SHA-256 of canonical JSON in the attestation's `review_hash` | Evaluator, or a DAO proposer |

The app publishes these as public plaintext via FastData under the objective account and
verifies them against the on-chain commitments. The contract stores commitments, not documents.

## 7. Rules

What the contract enforces, and what makes a spec or review valid. A rule's heading is its name:
renaming one is removing it and adding another.

### 7.1 Terms

#### The address derives from the terms

Each objective is its own account, derived from its `Params` and the contract's code hash
(NEP-616). Every call carries the `Params` and is refused unless they hash to the ones the account
was created with, so the terms cannot change after launch. Funding is also refused unless the
account is the one those `Params` derive under immutable global code. Clients derive the address;
they never accept one.

#### Shares sum to exactly 100%

One to ten contributors, each with a non-zero share in pips, summing to exactly 100%.

#### The evaluator holds no slot

The evaluator is never a contributor or a backup: it cannot judge work it is paid for. The sponsor
may be the evaluator.

#### Backups need a commit-by time

Backups need a `commit_by` before the deadline. Each backs a listed contributor and is distinct
from every contributor and every other backup.

#### Only the Verifier relays signed calls

`auth_caller`, when set, must be the Verifier that holds the token: the objective trusts the signer
its caller names, and only the Verifier checks signatures.

### 7.2 Funding and slots

#### Only the sponsor funds

Funding comes only from the sponsor, through the Verifier. Anyone else's is refused and returned.

#### A contributor commits before the deadline

A listed contributor may commit to its empty slot before a verdict and the deadline.

#### A backup takes an empty slot only after commit-by

A backup may commit to its contributor's slot only once `commit_by` has passed, and only while the
slot is empty. Whoever holds the slot at the verdict is paid for it.

#### Only the holder acts for a slot

Only whoever holds a slot may withdraw from it or deliver for it.

#### A holder may withdraw until it delivers

Before delivering, a verdict and the deadline, a slot's holder may withdraw. The slot is then empty,
for its contributor or, after `commit_by`, its backup to take.

#### A delivery is final

A holder delivers once, by the SHA-256 of its report, before a verdict and the deadline. A delivery
cannot be withdrawn or replaced.

### 7.3 Verdict and settlement

#### One verdict

An objective resolves once. After that, every verdict, cancellation, funding, commitment,
withdrawal and delivery is refused.

#### The evaluator attests before the last moment to attest

The evaluator attests `achieved` or `failed` until the last moment to attest: the deadline,
extended by an acceptance window once everyone delivered. Nobody else attests `failed`; the only
other attestation is [the sponsor's release](#the-sponsor-may-release-but-never-fail), under the same
deadline.

#### Paying out needs every slot delivered

`achieved`, `accepted` and `released` pay the contributors, and each needs every slot to have
delivered.

#### The sponsor may release but never fail

The sponsor may attest `achieved` under the evaluator's conditions: it releases its own funding to
the contributors, and the objective resolves as `released`. The sponsor can never attest `failed`.

#### The sponsor may cancel until someone commits

While no slot is committed and there is no verdict, the sponsor may cancel: everything funded returns
to it, and the objective resolves as `cancelled`. A commitment locks the funding; withdrawals that
empty every slot unlock it again.

#### Silence fails closed unless the terms say otherwise

Once the last moment to attest has passed without a verdict, anyone may close the objective. It
resolves as `accepted` when `acceptance_window_secs` is set (at least one second) and every slot
delivered, and as `expired`, refunding the sponsor, otherwise.

#### Payouts are exact

`achieved`, `accepted` and `released` split the funded amount by shares, the rounding remainder to
the sponsor. `failed`, `expired` and `cancelled` return all of it to the sponsor. Each share goes to
whoever held the slot at resolution.

#### A failed payout stays owed until it is retried

A transfer that fails is owed again, and anyone may retry it with `ob_close`.

#### Deletion only at a zero balance

Once settled and past the last moment to attest, `ob_close` reads the objective's Verifier balance and
deletes the account only if it is zero. Anything else stays, since a balance does not prove whose it
is.

#### Publishing to an objective changes nothing

`__fastdata_kv` accepts any arguments as a no-op, so documents published to the objective succeed and
FastData indexes them. It reads nothing, changes nothing, and refuses an attached deposit.

### 7.4 Specs and reviews

#### A model is never the only gate

A spec has at most two `llm_judge` criteria and at least one other criterion.

#### A judge is one model or three

Each `llm_judge` names one model or three; its outcome is their majority answer.

#### A judged spec caps the report size

A spec with an `llm_judge` states `max_report_bytes`. A longer report fails the judged criteria
without any model being asked, so that `fail` carries no model calls; a judged `pass` always needs
every model's call.

#### A schema is draft 2020-12

A `schema` criterion's `json_schema` is JSON Schema draft 2020-12. It may name that dialect in
`$schema`, with or without the trailing `#`, and is refused if it names any other.

#### A criterion holds for the deliverable as a whole

With several reports, each criterion has one result for all of them, and their order never decides
it. `contains` reads the reports' joint text. For a labelled value (`numeric_match`, `live_url`, and
the figures `sources` checks), every report that states the label must pass, so a conflicting value
fails the criterion; a label no report states fails. For `schema`, every report's JSON block, or the
report itself if it is JSON, must pass; a report with neither isn't counted, and the criterion fails
if none has one. The minimums of `sources` and `media` are totals across the reports, and the links
fetched within the evaluator's cap are the first in sorted order.

#### One meaning has one hash

Specs and reviews are accepted only in normal form: no unknown fields, and no `null` for an omitted
optional field.

#### A verdict follows its results

`achieved` needs every criterion to pass and no report to be missing. `failed` needs a criterion to
fail or a contributor's report to be missing.

#### An outage is never a failed verdict

`skipped` is for the evaluator's own failure: its model, its network, an unresponsive host. Results
with something skipped and nothing failed or missing support neither verdict, so the evaluator does
not attest.

### 7.5 What is not guaranteed

The rules do **not** prove: that the work was achieved, its authorship or quality, that the
evaluator is honest or uncaptured, privacy (everything, including money, is public), or
independence from the Verifier's privileged roles (`DAO`, `UnrestrictedWithdrawer`). There is
no independent audit; use testnet funds only. See the README for known limits (lost payout
callback, plain transfers, gas ceiling, blocked deletion).

## 8. Evidence to date

Testnet (Tidepool's Verifier, same v0.4.5 build as mainnet `intents.near`, 2026-11-20):
ten scenarios, 170 of 170 checks, on global code
`4GxG7Nyek6NcaKqkGfDoXrBwspYPE7gA1ADigd3JoiTF`. A local sandbox against the mainnet Verifier
binary and mainnet agency-DAO code covers the same scenarios plus failed-payout retry.
That build has no release, cancel or withdrawal. Code
`FPkPcDq1zMgkWXtdH98F1uR292PTMSF6mSjDiUXnVXyB` (commit `541a4e8`, published 2026-11-23) adds
them and the no-op `__fastdata_kv`; it passed the 31 sandbox tests on its exact artifact, then all
thirteen testnet scenarios (the ten above, plus release, cancel and withdrawal), 207 of 207 checks.

## 9. Out of scope for now

- **Scoped spending authority** (policies, grants, caps, freeze). The Intents team points to
  wallet contracts and extensions for this; the platform (api.multiagency.ai) is where
  MultiAgency recreates it above the Verifier.
- **Disputes and partial verdicts.** One evaluator, one verdict.
- **Multi-sponsor funding**, collection, voting or donation flows. Several sponsors must
  agree on one sponsor account first.
- **Stake or slashing for commitments.** A commitment is a public statement of intent;
  withdrawal is a recorded exit.
- **Attendance and City Nodes integration.** The `attendance` criterion in `docs/citynode.md`
  is an unimplemented proposal.
- **Reputation.** No score or index; external readers can derive records from events.
- **Privacy, encrypted reports, attested evaluator** (provider signatures are verified, TEE
  execution is not), and a **global objective search**.
- **Cross-objective enforcement** of milestones and sub-objective deadlines (see sections 4
  and 5).

## 10. Questions for reviewers

1. Is a single evaluator DAO acceptable for the first agencies, given no dispute path?
2. Should cross-objective deadline checks (child before parent) move on chain, or stay an
   agency convention?
3. Is the `acceptance_window_secs` default of fail-closed right for contributors?
4. Which criteria do City Nodes need before `attendance` is worth building?
