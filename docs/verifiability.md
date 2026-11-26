# What a pass shows

An objective pays out when its evaluator attests `achieved`. The contract cannot see the work: it checks roles, timing
and hashes ([spec §3](spec.md#3-how-the-outcome-is-judged)). So what a verdict is worth depends on what each check can
and cannot establish. This page says that, check by check, and then layer by layer. Each claim names how it is known:
**source** (`app/src/server/checks.ts` at the commit this page was written against) or **docs** (another page here).

Reading it: the *contributor* wrote the report the checks run on, so "the contributor can write that" means a check
cannot tell the real thing from the contributor's say-so.

## The checks

| Check | A pass shows | A pass does not show | Trust it relies on |
| --- | --- | --- | --- |
| `contains` | The report includes (or, with `absent`, omits) a phrase, case-insensitively. | That anything the phrase refers to happened. | None beyond the report hash. The contributor chooses the report. |
| `schema` | The report's JSON block (or the whole report) is valid against the spec's JSON Schema. | That the values are true. A schema constrains shape and ranges, not facts. | The spec's author wrote a schema that excludes bad answers. |
| `numeric_match` | A `<label>: <number>` line exists and the number is within `min` and `max`. | That the number is real. The contributor wrote the line. | Pair it with `sources` and `figures` to tie it to cited pages. |
| `files` | Named paths are present and non-empty in the delivered files. | That the files are correct. The text-report evaluator refuses file criteria at launch, and the check is skipped without file contents. | Only usable where file delivery exists ([docs/documents.md](documents.md)). |
| `live_url` | The page cited on the `<label>: <url>` line loads, and shows `must_contain` if set. | That the page is anyone's but the contributor's. A contributor can host a page that says whatever `must_contain` asks for. | The host the contributor cites. No origin pin exists ([#5](https://github.com/MultiAgency/extents/issues/5)). |
| `sources` | At least `min` distinct cited pages load: links that differ only by `#fragment`, or that answer with the same bytes, count once. With `figures`, every `numeric_match` figure also appears as a number on a cited page. | That the pages support the claim, or that they are independent of the contributor. | The hosts the contributor cites. |
| `media` | At least `min` cited links with a matching extension load and answer with a matching content type. | That the media is of the thing described, original, or from the event. | The hosts the contributor cites. |
| `llm_judge` | One model, or the majority of three, answered yes to the spec's question about the report. Each call is recorded with its provider signature. | That the answer is right. What is judged is the report and what the spec's question asks of it, not the world. | The model provider, and (when a signature is checked) the provider's signing key. |

Two rules limit how much weight any one check carries: [a model is never the only gate](spec.md#a-model-is-never-the-only-gate)
and [a judged spec caps the report size](spec.md#a-judged-spec-caps-the-report-size).

With several contributors, "the report" above is all of their reports together, and their order never decides a
result: [a criterion holds for the deliverable as a whole](spec.md#a-criterion-holds-for-the-deliverable-as-a-whole). So
one contributor's report can satisfy `contains` for everyone, while a value one report states that fails its criterion
fails it for everyone (source: `reportsOf` in `checks.ts`).

An unreachable cited host does not fail the contributor immediately: the check is `skipped` with `unavailable`, and the
evaluator's retry rule may turn that into a fail, because the contributor answers for the hosts it cites (source:
`unreachable` in `checks.ts`).

## What the evidence record holds

Each `live_url`, `sources` and `media` result records the evidence it fetched: the URL cited and the SHA-256 of the
response body. Beside them it records, each only when the fetch had it, the HTTP `status`, the `content_type` header
verbatim, and the `final_url` where a redirect ended (kept apart from the cited URL, which replay looks pages up by)
([#25](https://github.com/MultiAgency/extents/issues/25)). A field the fetch did not have is left out of the review,
never filled with a default: a page with no content type has no `content_type`, and one that answered itself has no
`final_url`. Reviews written before these fields keep their hashes.

These are the evaluator's record of what the server said, not archived bytes: the archive keeps only the body. A replay
checks that the body hashes to the same value and can re-decide from the recorded status and content type what it
could not before; it cannot check what the server said
([#1](https://github.com/MultiAgency/extents/issues/1)). (source: `fetchPage` and `evidenceOf` in `checks.ts`,
`finalUrl` in `evidence-fetch.ts`, `review.rs`, `replay.ts`.)

## The layers around the checks

| Layer | What it commits to or shows | What it does not |
| --- | --- | --- |
| `Params.spec_hash` on chain | The exact criteria contributors agreed to be judged against, before they commit. | That the criteria are good ones. A criterion that anyone can satisfy is a valid spec. |
| Delivery hash on chain (`ob_deliver`) | That the holder of a slot recorded a report with this SHA-256, before the deadline. | That the report is true. Delivery is final and cannot be withdrawn. |
| `review_hash` on chain (`ob_attest`) | That the evaluator's published review has this hash, and that the verdict follows from its results ([spec §7.4](spec.md#a-verdict-follows-its-results)). | That the results are right. A `skipped` outcome supports neither verdict. |
| FastData rows | Public copies of the params, spec, deliverables and review under `extents/v1/…` ([docs/documents.md](documents.md)). | Anyone can write there. A reader trusts a row only if its writer holds a role in `Params` and its value matches the on-chain hash. |
| The evaluator | One agreed authority judges once. A spec may pin `evaluator_build`, and a review must record the same build. | That it is honest, uncaptured, or running that program: TEE attestation is not verified ([#2](https://github.com/MultiAgency/extents/issues/2)). |
| Sponsor release | The sponsor can concede with its own `achieved`, which needs nobody else's word. | That the sponsor's concession is a verdict on the work. |

## What is not covered

[Spec §7.5](spec.md#75-what-is-not-guaranteed) already lists what the rules do not prove: that the work was achieved, its
authorship or quality, that the evaluator is honest, privacy, and independence from the Verifier's privileged roles.
There is no dispute path and no partial verdict ([§9](spec.md#9-out-of-scope-for-now)).

## Using this page

- Writing a spec: a criterion whose only evidence is a page or report the contributor controls is a statement of intent,
  not a check. Prefer evidence from a source the contributor does not host, and say so in the criterion.
- Proposing a new check or a pin: say which row of the table it improves and which "does not show" cell it closes.
- Worked case: [a coding objective](coding-objective.md), where the same check passes or fails depending on whether it reads a GitHub page or its API.
