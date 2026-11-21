# NEAR Extents: specification (draft for review)

Status: draft for review. Closes product-board #23, part of #21.
Sources: `README.md`, `docs/design-notes.md`, `docs/documents.md`, `docs/citynode.md`, `crates/spec`.
Where this draft and the code disagree, the code and the pinned vectors win; please flag it.

## 1. Purpose

The NEAR Intents Verifier settles economic intents: transfers, withdrawals and `token_diff`
swaps that net to zero. Extents extends it to social outcomes that need commitments from
several parties, for example "I have USDC on NEAR, I want an event organized in NYC."

Extents is a set of companion contracts. The Verifier is not modified.

## 2. Model

An **objective** is one contract with:

| Role | Who | Power |
| --- | --- | --- |
| Sponsor | the party funding the objective (customer, or a DAO) | funds; may cancel while nobody has committed; may release once every slot has delivered; can never attest `failed` |
| Contributors (up to 10) | the parties doing the work, with shares in pips summing to 100% | commit, deliver, withdraw before delivering |
| Backups | optional named stand-ins for a slot | may take an empty slot after `commit_by` |
| Evaluator | the single judge (may equal the sponsor; never a contributor or backup) | attests `achieved` or `failed`, once |

- **Address.** Each objective is its own account at a predictable address derived from its
  `Params` and the code hash (NEP-616). Clients derive it, never accept one.
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

Rules:

- All criteria except `llm_judge` are meant to be checked by a script.
- At most two `llm_judge` criteria, and at least one non-`llm_judge` criterion, so a model's
  answer is never the only gate.
- Each `llm_judge` names one or three models; its outcome is their majority answer.
- A spec with an `llm_judge` states `max_report_bytes`; a longer report fails.
- A spec may pin `evaluator_build`, the hash of an attested evaluator program.
- Documents are accepted only in normal form (no unknown fields, no `null` for an omitted
  optional field), so one meaning has one hash. Shared vectors in `crates/spec/tests/vectors`
  pin the hashes for other languages.

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
`resolved` event so anyone can verify the verdict later.

A review records: the objective account, the spec hash, each contributor's deliverable by
hash, one result per criterion (`pass`, `fail`, `skipped`), the evidence fetched (URL and
SHA-256 of each response body), and every model call (criterion, model, answer, request and
response hashes, provider signature).

A review is valid only if its verdict follows from its results:

- `achieved`: every criterion passed and no report is missing.
- `failed`: at least one criterion failed, or a contributor's report was never published.
- `skipped` is for the evaluator's own failure (its model, network, an unresponsive host).
  Results with something skipped and nothing failed or missing support neither verdict, so the
  evaluator does not attest. An outage is never recorded as a failed verdict.

### 3.4 When the evaluator is silent

Set by `Params.acceptance_window_secs`, visible before anyone commits:

- `None` (default): silence until the deadline resolves as `expired` and refunds the sponsor.
  The escrow fails closed.
- `Some(secs)`: once every contributor has delivered, the evaluator has until the later of the
  deadline and `secs` after the last delivery. Without a verdict, `ob_close` resolves as
  `accepted` and pays as if achieved. If not everyone delivered, silence still expires.

A `failed` verdict is final. There is no dispute path.

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

## 7. Guarantees and non-guarantees

The contract guarantees: role checks, timing, share arithmetic (remainder to the sponsor),
one verdict, an achieved verdict only after every slot delivered, exact payouts, retry of
failed transfers, and deletion only at a zero Verifier balance.

It does **not** prove: that the work was achieved, its authorship or quality, that the
evaluator is honest or uncaptured, privacy (everything, including money, is public), or
independence from the Verifier's privileged roles (`DAO`, `UnrestrictedWithdrawer`). There is
no independent audit; use testnet funds only. See the README for known limits (lost payout
callback, plain transfers, gas ceiling, blocked deletion).

## 8. Evidence to date

Testnet (Tidepool's Verifier, same v0.4.5 build as mainnet `intents.near`, 2026-11-20):
ten scenarios, 170 of 170 checks, on global code
`4GxG7Nyek6NcaKqkGfDoXrBwspYPE7gA1ADigd3JoiTF`. A local sandbox against the mainnet Verifier
binary and mainnet agency-DAO code covers the same scenarios plus failed-payout retry.
Release, cancel and withdrawal are not in the published build; they are covered by unit
tests and the sandbox only.

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
