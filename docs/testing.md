# Testing

Use Playwright for repeatable browser regressions, agent-browser for exploratory
walkthroughs, and e2e (the separate e2e-inc/e2e tool) for a few bounded agent goals.
The Rust `e2e/` directory is a public-testnet harness, not that browser tool.

## Repeatable checks

`scripts/check`, from the repository root, runs every one of them, cheapest first (see AGENTS.md);
CI runs the same, without the Docker sandbox. From `app`, `pnpm test`, `pnpm typecheck` and
`pnpm exec playwright test` run the app's alone. Every rule in [`docs/spec.md`](spec.md#7-rules) is
cited by a test that checks it, and `pnpm test` fails when one is not. The contract is also modelled
in Quint, and the contract replays the model's runs ([`contracts/objective/model`](../contracts/objective/model/README.md)).
Browser tests use a mock wallet, chain responses and model server. They verify UI
behavior without sending real transactions. The shared Playwright fixture fixes
wall time at 2027-01-01 while leaving timers running. Import `test` from
`test/e2e/fixtures.ts`; use `page.clock.setFixedTime` to exercise expiry.
Keep financial and authorization
assertions exact, including transaction counts and refusal outcomes.

Concurrent browser runs need separate ports, build directories and results:

```sh
E2E_APP_PORT=3344 E2E_LLM_PORT=3345 \
E2E_DIST_DIR=dist-e2e-qa \
PLAYWRIGHT_OUTPUT_DIR=/tmp/extents-browser-results \
pnpm exec playwright test --workers=2
```

For real contract execution, build a WASM, record its SHA-256, then run:

```sh
EXTENTS_OBJECTIVE_WASM=/absolute/path/to/extents_objective.wasm \
cargo nextest run -p extents-sandbox --run-ignored only
```

This needs Docker. Pinning the artifact keeps a concurrent rebuild from changing
what a run tests. Public-testnet scenarios are separately invoked and spend funds.

## Exploratory and agent checks

Use a named agent-browser session against a local fixture, inspect desktop and
mobile layouts, and exercise recovery paths such as wallet rejection followed by
retry. Save screenshots and a recording that reproduces any reported issue.
Refresh element references after navigation and scroll controls into view before
clicking. Close only the sessions created for the check.

The e2e-inc/e2e experiment verified NEAR AI browser-agent integration, but its
only scenario duplicated Playwright's decline check. Its runner, separate
lockfile and fixture server have been removed. Add a maintained agent suite only
when it exercises a distinct behavior worth its model cost and maintenance.

Screenshot capture is separate from the regression suite:

```sh
# From app; defaults to test-results/screens
pnpm capture:screens
# Or select an artifact directory:
SCREENS=/tmp/extents-design pnpm capture:screens
```

These five captures support manual design review. They have no visual baselines
and are not counted as visual regression coverage.

## Coverage and limits

- Pinned Rust/TypeScript vectors protect wire formats, hashes, addresses and calls.
- Unit tests cover validation, receipt trust, uncertainty recovery, evidence
  boundaries and resource budgets. Keep refusal and adversarial cases distinct.
- Playwright covers UI wiring, wallet refusals, reload and cross-tab recovery,
  DAO proposal deduplication, expiry and automated accessibility checks.
- Docker sandbox tests cover real execution, payout/refund accounting, failed
  payouts, DAO and intent routes, gas margins, backups and acceptance windows.
  Deadline helpers require block-time progress and have a 15-minute wall timeout.

Mock-wallet browser tests do not prove settlement. Axe checks do not establish
complete accessibility. Screenshot captures do not detect visual regressions.
The retired agent smoke test established provider compatibility, not extra
product coverage. Public-testnet runs remain a separately authorized check.

Keep fast unit and browser regressions available without model credentials. Run
real-chain coverage when changing the contract, client calls, gas rules or sandbox
helpers. Report skipped optional checks separately; avoid presenting capture
counts or repeated parameter cases as additional user journeys.
