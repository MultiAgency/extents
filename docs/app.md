# Extents app

Extents uses Bun and Hono for the API, React and rsbuild for the browser, and NEAR AI Cloud for model calls.

## Stack rules

| Layer | Rule |
| --- | --- |
| Server | Bun, Hono and Zod; validate tool input before execution |
| Agent | Explicit model/tool loop with AG-UI events |
| Model receipts | Verify the provider signature against exact request/response hashes |
| Frontend | React and rsbuild, with `/` and `/o/<address>` routes |
| Components | Plain HTML and Tailwind; retain keyboard focus, focusable signing actions and polite progress announcements |
| Wallet | near-connect and near-kit; preserve submitted transaction hashes |
| Encoding | `@zorsh/zorsh`, pinned against Rust contract vectors |

## Layout

| Path | Holds |
| --- | --- |
| `app/src/shared/` | `Params` and the objective address, spec and review hashing, canonical JSON, objective building, reviews, attestation calls, config |
| `app/src/server/` | Hono routes, the NEAR AI model adapter, the customer agent loop and its tools, the checks and the verified judge, chain and FastData reads, the agent API, the `StateInit` deploy |
| `app/src/web/` | The chat, the objective plat, the objective page, the wallet |
| `app/test/` | Contract and spec vectors, the agent loop against a scripted model, browser tests against a scripted NEAR AI endpoint |

## The agent loop

One run per user message, emitting AG-UI 1.0 events as it goes:

1. `RUN_STARTED`.
2. Ask the model, with the instructions, the tool definitions and the conversation.
3. Emit its text (`TEXT_MESSAGE_*`) and each tool call (`TOOL_CALL_START`, `ARGS`, `END`), all under one assistant message per step.
4. Run each server tool after validating its input with its Zod schema. An invalid input or an unknown tool goes back to the model as an error result (`TOOL_CALL_RESULT`), never into a tool.
5. Leave a browser tool (`launch_objective`) unanswered and end with `RUN_FINISHED`, success, `pendingToolCallIds`. The browser shows the card, the wallet signs, and the result starts the next run.
6. Stop on a final answer, or after a step budget. Any error becomes `RUN_ERROR` with a generic message; the detail is logged on the server.

Agent rules:

- **The server reconstructs history from conversation text and chain-confirmed launch results.** Client-supplied server tool results are discarded. A launch result is checked on chain against its sponsor and proposed terms before it is treated as fact.
- **A launch the conversation moved past is answered as not launched.** Models refuse a history holding an unanswered tool call.
- **Tool results are data.** They hold text written by others, and the instructions say so.
- **The user's input stays usable while a reply streams,** and submission waits until the reply finishes.

## The workspace

The conversation sits beside the objective plat: the objective drawn as it takes shape. The agent records terms with
`update_draft` as the customer states them and streams its draft as AG-UI `STATE_SNAPSHOT`s; the plat shows the draft,
then the exact terms to sign, then the live escrow. Its contour map is drawn from the objective's address (a hash of the
draft until there is one), so every objective has its own terrain, and the map inks in when the objective is funded.
Design tokens are in `app/src/web/globals.css`; `test/e2e/a11y.spec.ts` runs axe on each state in both colour schemes,
and `SCREENS=<dir> pnpm capture:screens` takes screenshots for review.

## The objective page

`/o/<address>` is public: the plat, who has committed and delivered, and a part for whoever is looking.

- **A contributor** commits, checks a report, then sends its SHA-256 with `ob_deliver` and waits for finality.
  The browser persists the report before signing, then publishes `deliverable = {text, delivery_tx, delivery_signer}`
  to FastData. If publication fails, the contributor can republish the exact report and its delivery proof on the page.
  Until it delivers, it can withdraw ([rule](spec.md#a-holder-may-withdraw-until-it-delivers)).
- **The sponsor**, until someone commits, can cancel ([rule](spec.md#the-sponsor-may-cancel-until-someone-commits)).
- **The evaluator** checks what was delivered (`/api/evaluate`). The reader fetches each report's finalized transaction,
  requires a successful objective receipt with a matching `delivered` event and SHA-256, and resolves backup holders
  from `taken`. Every recorded delivery must be available. The page validates the review and repeats receipt verification
  through the wallet's RPC before publishing the review and signing `ob_attest`. When the
  evaluator is a Sputnik DAO, any member allowed to propose files the same call as an `add_proposal` with the DAO's
  bond, and the DAO settles it on approval.
- **Anyone else** can check a report against the terms.

Both runs are AG-UI: each criterion is a `check` tool call that starts at once and resolves as its result arrives.
Draft check results belong to the exact report and objective submitted. Editing the report hides those results and
marks them stale until the current report is checked, including when an earlier check finishes after the edit.
Attestation feedback, proposal ids and hashless-filing overrides belong to the exact attestation call. Reevaluating
the same review retains that feedback; a different review has its own state, including when an earlier filing finishes later.
If the review or attestation call cannot be prepared, the page reports the error and offers no attestation.

A verdict follows the results: `achieved` only when every criterion passed, `failed` when one failed. A skipped check cannot support achievement. If no check failed and at least one was skipped, there is no verdict to attest. The contract refuses `achieved`
unless every contributor delivered, and any attestation after the effective deadline. The page uses the live state's
extended deadline, distinguishes allocation from completed payment, and offers permissionless close/retry controls.

Each `llm_judge` names one model or three. Each model answers once on NEAR AI Cloud, without streaming, and the outcome
is their majority; if any model can't answer, the criterion is skipped. The request is exactly `crates/spec`'s
`judge_request` (`app/src/shared/judge.ts`), canonical JSON with the deliverable fenced by a line derived from its own
hash, so anyone holding the deliverables can rebuild it. The judge hashes the exact request and response bytes, fetches
NEAR AI's ed25519 signature over `<model>:<sha256(request)>:<sha256(response)>`, and refuses the answer unless the
signature verifies against those hashes. Each call, with its model, answer and signature, goes into the review's
`llm_calls` under its criterion. This app's evaluator is not an attested build, so new objectives cannot pin an
`evaluator_build`. The signing key comes from provider HTTPS unless the operator pins it with `NEARAI_SIGNING_KEYS`. It
is not tied to a TEE attestation report. During evaluation, raw request, response, receipt and fetched evidence bytes are archived privately by SHA-256, so a review can
be checked against the same bytes. `bun scripts/replay.ts` replays a review from the archive (see docs/documents.md). Draft checks do not write to this archive; a full archive pauses affected evaluation checks rather than dropping evidence.

## For agents

- The agent API, plain JSON: `POST /api/tools/:name` (the customer agent's tools), `POST /api/draft` (exact `Params`,
  address, unsigned transactions, and a launch link whose fragment carries the terms to the sponsor's browser), `POST /api/deploy` (with the spec, the deployer also publishes the terms; the reader accepts the spec from the sponsor or the deployer, pinned by `spec_hash` either way, so changing `DEPLOYER_ACCOUNT_ID` leaves terms the old deployer published unread), `POST /api/objective/:id/contribute` (a contributor's commit, withdrawal, delivery and report publication, one step at a time), `POST /api/objective/:id/sponsor` (the sponsor's [cancel](spec.md#the-sponsor-may-cancel-until-someone-commits) while nobody has committed, and its [release](spec.md#the-sponsor-may-release-but-never-fail) once every slot delivered, offered under `PUBLIC_SPONSOR_RELEASE` as on the page; each also as a Verifier `auth_call` intent when the terms name an [`auth_caller`](spec.md#only-the-verifier-relays-signed-calls)), and `POST /api/objective/:id/review` (the review and the
  unsigned calls that publish and attest it, or propose it to a DAO evaluator). Agents prepare; wallets and DAOs sign.
  Every answer about an objective links its page, `/o/<objective>`, where people act in their own wallets.
  Every unsigned call also carries `near_call`: the same call with gas in gas units and deposit in yoctoNEAR, under the
  field names of the NEAR Intents Agent API's `native/near/call`. That API is mainnet-only, so the hand-off is checked
  against its published body limits (`app/test/calls.test.ts`) and has not been run.
- `/llms.txt` and `/skill.md`: the protocol and the launch and evaluation recipes, for agents and coding assistants.
- `/api/agent`: the customer agent itself, for any AG-UI client.

## Money

Money rules:

- Amounts are decimal strings and BigInt atomic units, never floating point.
- A funding attempt marker is persisted before wallet submission, and its transaction hash as soon as the wallet returns it.
- Approval is never settlement.
- An uncertain outcome blocks a replacement.

Funding is sponsor-only ([rule](spec.md#only-the-sponsor-funds)): the sponsor's `mt_transfer_call`, or a `transfer` intent with the fund message from the sponsor's Verifier balance, credits `funded` at once, and anyone else's is refused and refunded. Unattributed balances are retained: elapsed blocks cannot prove a pending refund belongs to the sponsor. `ob_close`
deletes only once accounted payouts have settled ([rule](spec.md#deletion-only-at-a-zero-balance)).

## Open decisions

- [ ] The default NEAR AI model for the customer chat: `Qwen/Qwen3.6-35B-A3B-FP8` is fast but drafts weak specs; model choice remains an operator decision.
- [ ] Which account deploys objectives (`StateInit`), until wallets can sign it.
- [ ] Whether to verify NEAR AI's signing key against its TEE attestation report before trusting a receipt.

## Resource and release controls

Every API request holds one of four concurrent response slots until its response is consumed. Costly work
(an agent run, checks, an evaluation or review, and a deploy) also spends one
of 200 per hour, charged only once its input is valid; reads spend nothing. The body limit is 256 KiB;
agent runs have 12 steps, a two-minute deadline and 4,096 output tokens per model step. Production deployment calls
share a separate budget of 10 per hour and one concurrent operation. Evidence transport names itself in a fixed `User-Agent`, permits eight concurrent
connections and 10,000 requests per hour, pins public DNS at connection time, validates redirects and caps streamed
bodies at 2 MiB. Model outages, ambiguous answers, unavailable evidence and archive failures produce skipped checks. Only a host the contributor cited and that stays unreachable can later fail a check; an archive failure, or the server's own fetch budget running out, is the evaluator's, so it never does.

Chain reads use finalized state, a 15-second deadline and a 4 MiB response cap. Run cancellation reaches chain and
evidence requests; closing an event stream cancels its work. Evidence waits for a connection before admission, and
criteria in one run share the exact bytes fetched from the same URL. Numeric source checks compare complete parsed
numbers, including grouped and scientific notation, rather than substrings.

These limits are per process, reset on restart, and are service ceilings rather than authenticated account quotas.
Multi-process/public deployments need equivalent shared gateway limits and restricted network egress. The private
archive defaults to `app/var/evidence` with a 256 MiB ceiling, of which each objective may add at most 64 MiB per
process; set `EVIDENCE_ARCHIVE_DIR` to private persistent storage.
Apply retention and access policy to these potentially sensitive reports, and monitor archive capacity.

Browser launch persistence is required. Web Locks coordinate tabs, typed wallet refusals permit retry, and any
unknown funding outcome blocks replacement. Returned transaction hashes are saved for finalized receipt reconciliation;
if the wallet loses the response before returning a hash, chain absence alone never authorizes another send.

A `schema` criterion's patterns run on RE2 (`re2js`), in linear time, so no pattern can backtrack catastrophically;
patterns RE2 can't run (backreferences, lookaround) are refused when the spec is drafted. Schemas are capped at 16 KiB
and 32 levels, and validated JSON at 256 KiB and 64 levels. A schema that uses `$dynamicRef` is refused: the app
resolves one only when a value reaches it. These are the app's execution limits, not the protocol's,
and they are checked before anything is compiled: when drafting, and when reading published terms, where a spec beyond
them is still matched to its committed hash, without parsing, and marked unsupported. The page says so, and checks and
evaluation refuse to run on it. FastData reads stream against a 4 MiB page cap and 16 MiB
across pages, and delivery-proof transactions against 4 MiB, before anything is parsed. Canonical JSON refuses lone
surrogates, which have no UTF-8 form and so no hash.

Document discovery requests only the Params key; spec and report reads also name the authorized writer. Verified
immutable Params/spec pairs are cached per process by objective address and code hash, capped at 16 MiB and 256
entries. Cached terms remain available during an indexer outage; cold discovery still requires the indexer.

A DAO evaluator's attestation is filed once: the page searches the DAO's proposals for an open or approved one making
the exact `ob_attest` call, and a marker persisted before signing, held under a Web Lock, blocks a second filing and
bond while an earlier one's outcome is unknown. Only the filing transaction's final receipts lift it: the DAO's receipt
returns the new proposal's id, or fails, which returns the bond. Time passing never does. When the wallet lost the
response before naming a transaction, nothing can settle it but the proposal appearing on the DAO; the page then offers
an explicit "file again anyway", labelled as posting another bond and possibly duplicating the proposal. That sets the
unresolved marker aside, and the DAO search reports every matching proposal, so a duplicate the
override caused is shown with the request to reject the extra one.

`files` is still a protocol format but is refused for new objectives in this text-report app; legacy file criteria
without file contents are skipped. Source/media minima above the evaluator's ten-fetch limit are also refused.

Deployment uses `PUBLIC_OBJECTIVE_CODE_HASH`, with the same value in the browser build and server.
The server derives StateInit from Params and this immutable code hash. It needs neither Rust source
nor a local WASM at runtime. Build and sandbox-test the exact WASM before publishing its hash.
`app/scripts/create-release.ts` can generate offline artifact/source metadata for release records;
that metadata is not a runtime gate or proof that tests ran.

`PUBLIC_SPONSOR_RELEASE=1` shows the sponsor a "Release payment" control once every contributor delivered: an
`ob_attest` achieved signed by the sponsor, which resolves the objective as `released`. Set it only with the code hash of
a build that has that outcome, such as `FPkPcDq1…` (commit `541a4e8`); the earlier `4GxG7Nye…` build refuses a sponsor's
attestation. A sponsor who may propose to an evaluator DAO sees the control beside the evaluator's part; one who is
the evaluator itself does not, since the contract takes its attestation as the verdict.

## Delivery proof

A contributor keeps its report, calls `ob_deliver` with the SHA-256 of its UTF-8 bytes, waits for finality, and then
publishes a FastData row:

```json
{"extents/v1/deliverable":{"text":"the exact report","delivery_tx":"<base58 hash>","delivery_signer":"contributor.testnet"}}
```

The server fetches that finalized transaction and accepts a hash only from a successful receipt executed by this
objective, whose own `delivered` event names the slot's actual holder. A signed intent may have a relayer as
`delivery_signer`; the event still names the contributor. A contributor can republish proof if the first publication
failed. If FastData replaces a report, text that doesn't match the proven hash is refused, and the original report can be
republished with its original proof.
