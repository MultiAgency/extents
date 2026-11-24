# A coding objective: what can be expressed today

The question from the team: real-world outcomes are hard to verify, and code is an easier place to start, because the
evidence (a merged pull request) lives on a service the contributor does not control. This page takes one such
objective, writes it with the checks that exist, runs those checks against real GitHub pages, and records what holds and
what does not. It is a prototype and a findings write-up, not a spec change. The check-by-check reasoning is in
[verifiability.md](verifiability.md).

## Findings

1. **Page text is the wrong evidence on GitHub.** `live_url` with `must_contain: "Merged"` on a pull request's web page
   passes for a closed, unmerged pull request and for an open one. The word is on every pull request page, inside the
   page's embedded configuration (feature-flag names such as `…pull_request_merged_trigger`).
2. **The API response is usable.** `https://api.github.com/repos/<owner>/<repo>/pulls/<n>` is JSON with `"merged": true`
   for a merged pull request and `"merged": false` otherwise. With `must_contain: "\"merged\": true"` the existing
   `live_url` check separates the three cases correctly, when the request carries a `User-Agent` (see
   [What was run](#what-was-run)).
3. **It is still only as good as where the contributor points the check.** Nothing makes the contributor cite
   `api.github.com`. A page the contributor hosts that contains `"merged": true` passes in exactly the same way
   ([#5](https://github.com/MultiAgency/extents/issues/5)).
4. **"All checks passed" cannot be expressed.** `must_contain` is a substring test on one page. A page can show that
   something passed, not that nothing failed, and the check-run API lists passes and failures together.

## The objective

[`examples/coding-objective.spec.json`](examples/coding-objective.spec.json) has two criteria:

| Criterion | Check | What it asks |
| --- | --- | --- |
| `merged` | `live_url`, label `Pull request API`, `must_contain: "\"merged\": true"` | The cited page loads and contains that text. |
| `summary` | `contains`, `## Summary` | The report has a Summary section (a convention check). |

It parses with `parseSpec` (`app/src/shared/spec.ts`). Its `spec_hash` is
`a94be1a0cd0099ef24a96eeab8372451606763025197bdc10814b6aeac43b0cb`. It was validated by the TypeScript parser only, not
the Rust crate.

## What was run

The real `runCheck` with the real evidence transport (`evidenceFetch`), on 2026-11-24, with the report citing each
pull request's API URL. The script was run with Bun (`bun script.ts`, Bun 1.3.14), not Node.

**Runtime matters.** `evidenceFetch` sets no `User-Agent`. Bun's `node:https` adds a default one, so GitHub's API
answered 200. Node (v24.22.0) sends none, and GitHub answers `403 Request forbidden by administrative rules`; the check
is then `fail`, "did not load". I confirmed both with the same request on 2026-11-24. The app server runs on Bun
(`bun src/server/index.ts`), so the results below hold there, but not under Node, for example in a test that runs the real
transport. The web-page results in finding 1 do not depend on this.

| Pull request | State | Result of `merged` |
| --- | --- | --- |
| `MultiAgency/extents/pulls/13` | merged | pass |
| `MultiAgency/extents/pulls/14` | closed, not merged | fail |
| `MultiAgency/platform/pulls/98` | open | fail |

The review that follows from the merged pull request is checked in as
[`examples/coding-objective.review.json`](examples/coding-objective.review.json): built with `buildReview` and
validated against the spec, verdict `achieved`, `review_hash`
`c41c5aa9fdaf…` (full hash: `reviewHash` of that file). The same objective on the closed, unmerged pull request builds a
valid review with verdict `failed`. The evidence entry holds the SHA-256 of GitHub's API response body.

That hash is only as stable as the page. The response includes fields such as `updated_at` and `comments`, so a new
comment or label on the pull request changes the body, and a replay of the archived bytes is the only way to reproduce
the original result later. Two fetches a few seconds apart gave the same hash.

The same criterion with the web page URL and `must_contain: "Merged"` passes for all three. This was a script run
against live pages, not a funded objective on a Verifier: no testnet objective was created, funded, delivered or
attested for it.

## What a contributor could still fake

| Claim | Faked by | Closed by |
| --- | --- | --- |
| "The pull request is merged" | Citing a page the contributor hosts that contains `"merged": true`. | Holding the evidence to a source the contributor does not host. |
| The pull request is the right one | Citing any merged pull request. The spec cannot name the repository or number the evidence must come from. | The same: a pin that names the repository. |
| Checks passed | Not expressible (finding 4). | A new check kind, or evaluator-side lookup. |
| Authorship | Citing someone else's merged pull request. | Nothing in the current checks. |

## The smallest changes that would close it

Each option is a design for the maintainers to weigh; none is implemented here.

1. **Pin where `live_url` evidence may come from.** An optional prefix on the criterion
   ([#5](https://github.com/MultiAgency/extents/issues/5), tried in [#14](https://github.com/MultiAgency/extents/pull/14)),
   for example `https://api.github.com/repos/<owner>/<repo>/pulls/`. That closes the first two rows above. #14 was closed
   because a redirect can leave the prefix (the final URL would have to stay under it, see
   [#25](https://github.com/MultiAgency/extents/issues/25)) and because of how new fields are versioned
   ([#26](https://github.com/MultiAgency/extents/issues/26)).
2. **A dedicated check kind for pull requests.** The evaluator asks the forge's API itself, instead of reading a page the
   contributor cites, and could also assert that no check failed. It needs a new check kind, with the same versioning
   question.
3. **Evaluator-side evidence the contributor does not cite.** The spec names the repository and the evaluator looks up the
   merged pull request, so the contributor hosts and cites nothing. It changes who supplies the evidence.

Option 1 is the lightest and applies to any third-party source. Option 2 is the most direct for code.

## Limits

- Anonymous requests to `api.github.com` are rate limited by GitHub; an evaluator would need to account for that.
- `evidenceFetch` sends no `User-Agent`, which GitHub's API refuses; sending one would make the API run work under Node
  as well. That is a separate change and is not made here.
- A merged pull request shows that a change landed, not that it is correct.
- No testnet run (see above): the review is built and validated off chain. Attesting it and paying out needs a funded
  testnet objective, which needs the e2e tool's testnet account and a manual faucet step.
