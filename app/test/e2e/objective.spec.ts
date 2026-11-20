/** An objective's public page: what visitors see, and a contributor's commit, check and delivery. */
import AxeBuilder from "@axe-core/playwright";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, type Page } from "@playwright/test";

import { attestProposal, attestationOf } from "../../src/shared/attest.ts";
import { reportHash, buildReview, summarize, type CheckResult } from "../../src/shared/review.ts";
import { reviewHash } from "../../src/shared/spec.ts";
import { test, setup } from "./fixtures.ts";

const ADDRESS = "0s" + "ab".repeat(20);
const PARAMS = {
  sponsor: "customer.testnet",
  token: "nep245:verifier.tidepool-sandbox.testnet:nep141:usdc.tidepool-sandbox.testnet",
  evaluator: "agency.testnet",
  contributors: { "organizer.testnet": 700000, "venue.testnet": 300000 },
  deadline: "2027-03-01T00:00:00Z",
  spec_hash: "00".repeat(32),
  auth_caller: "verifier.tidepool-sandbox.testnet",
  salt: "11".repeat(32),
};
const SPEC = {
  v: 1,
  statement: "A NEAR builders meetup in New York City for at least 30 people",
  criteria: [
    {
      id: "page",
      description: "The public event page names New York",
      check: { kind: "live_url", label: "Event page", must_contain: "New York" },
    },
    { id: "attendance", description: "At least 30 people attend", check: { kind: "numeric_match", label: "Attendees", min: 30 } },
  ],
};

async function objective(page: Page, state: Record<string, unknown>, view: Record<string, unknown> = {}) {
  await page.route(`**/api/objective/${ADDRESS}`, (r) =>
    r.fulfill({ json: { deployed: true, state: { funded: "5000000", ...state }, documents: { params: PARAMS, spec: SPEC }, ...view } }),
  );
  // the checks, as the server streams them: both start, then each resolves
  await page.route("**/api/check", (r) => {
    const events = [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      ...SPEC.criteria.flatMap((c) => [
        { type: "TOOL_CALL_START", toolCallId: c.id, toolCallName: "check", parentMessageId: "m" },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: c.id,
          delta: JSON.stringify({ criterion_id: c.id, description: c.description, kind: c.check.kind }),
        },
        { type: "TOOL_CALL_END", toolCallId: c.id },
      ]),
      {
        type: "TOOL_CALL_RESULT",
        messageId: "r1",
        toolCallId: "attendance",
        content: JSON.stringify({ criterion_id: "attendance", outcome: "pass", detail: "Attendees: 34", evidence: [] }),
      },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "r2",
        toolCallId: "page",
        content: JSON.stringify({
          criterion_id: "page",
          outcome: "fail",
          detail: 'https://lu.ma/x loads but does not show "New York"',
          evidence: [],
        }),
      },
      { type: "RUN_FINISHED", threadId: "t", runId: "r", result: { passed: 1, failed: 1, skipped: 0, verdict: "failed" } },
    ];
    return r.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    });
  });
}

test("a visitor sees the live escrow and can check a report", async ({ page }) => {
  await setup(page);
  await objective(page, { committed: 1 });
  await page.goto(`/o/${ADDRESS}`);
  await expect(page.getByRole("heading", { name: "Live escrow" })).toBeVisible();
  await expect(page.getByText(SPEC.statement)).toBeVisible();
  const who = page.getByRole("region", { name: "Contributors" });
  await expect(who.getByRole("listitem").filter({ hasText: "organizer.testnet" })).toContainText("committed");
  await expect(who.getByRole("listitem").filter({ hasText: "venue.testnet" })).toContainText("not yet");

  await page.getByRole("textbox", { name: "Report" }).fill("Event page: https://lu.ma/x\nAttendees: 34");
  await page.getByRole("button", { name: "Check my work" }).click();
  const checks = page.getByRole("list", { name: "Checks" });
  await expect(checks.getByRole("listitem").filter({ hasText: "At least 30 people attend" })).toContainText("Attendees: 34");
  await expect(checks.getByRole("listitem").filter({ hasText: "names New York" })).toContainText("does not show");
  await expect(page.getByRole("status").filter({ hasText: "checks fail" })).toHaveText("1 of 2 checks fail. Fix them before you deliver.");
});

test("a contributor commits with the objective's exact params", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "venue.testnet");
  await objective(page, { committed: 1 });
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Commit" }).click();
  await expect.poll(() => chain.txs.length).toBe(1);
  expect(chain.txs[0]!.calls[0]).toMatchObject({ receiver: ADDRESS, method: "ob_commit", args: { params: PARAMS } });
});

test("a committed contributor checks, then delivers the report and its hash", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "organizer.testnet");
  await objective(page, { committed: 1 });
  await page.goto(`/o/${ADDRESS}`);
  const report = "Event page: https://lu.ma/x\nAttendees: 34";
  await page.getByRole("textbox", { name: /Your report/ }).fill(report);
  await page.getByRole("button", { name: "Check my work" }).click();
  await expect(page.getByRole("status").filter({ hasText: "checks fail" })).toBeVisible();
  await page.getByRole("button", { name: "Deliver" }).click();
  await expect.poll(() => chain.txs.map((t) => t.calls[0]!.method)).toEqual(["ob_deliver", "__fastdata_kv"]);
  expect(chain.txs[1]!.calls[0]).toMatchObject({
    receiver: ADDRESS,
    args: { "extents/v1/deliverable": { text: report, delivery_tx: "TX-ob_deliver", delivery_signer: "organizer.testnet" } },
  });
  expect(chain.txs[0]!.calls[0]).toMatchObject({
    receiver: ADDRESS,
    args: { params: PARAMS, delivery: { hash: bytesToHex(sha256(new TextEncoder().encode(report))) } },
  });
});

const REPORT = "Event page: https://lu.ma/nyc\nAttendees: 34";
const PASSED: CheckResult[] = [
  { criterion_id: "attendance", outcome: "pass", detail: "Attendees: 34", evidence: [] },
  {
    criterion_id: "page",
    outcome: "pass",
    detail: "https://lu.ma/nyc loads",
    evidence: [{ url: "https://lu.ma/nyc", sha256: "ab".repeat(32) }],
  },
];
const DELIVERED = [
  {
    contributor: "organizer.testnet",
    text: REPORT,
    delivery_hash: reportHash(REPORT),
    delivery_tx: "DELIVERYTX",
    delivery_signer: "organizer.testnet",
  },
];
const REVIEW = buildReview(ADDRESS, SPEC as never, DELIVERED, PASSED)!;

function checkBody(results: CheckResult[], result: unknown): string {
  return [
    { type: "RUN_STARTED", threadId: "t", runId: "r" },
    ...SPEC.criteria.flatMap((c) => [
      { type: "TOOL_CALL_START", toolCallId: c.id, toolCallName: "check", parentMessageId: "m" },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: c.id,
        delta: JSON.stringify({ criterion_id: c.id, description: c.description, kind: c.check.kind }),
      },
      { type: "TOOL_CALL_END", toolCallId: c.id },
    ]),
    ...results.map((res, i) => ({
      type: "TOOL_CALL_RESULT",
      messageId: `r${i}`,
      toolCallId: res.criterion_id,
      content: JSON.stringify(res),
    })),
    { type: "RUN_FINISHED", threadId: "t", runId: "r", result },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

/** The evaluation as the server streams it, ending with these results' review (if any). */
async function evaluation(page: Page, results: CheckResult[]) {
  await page.route("**/__tx?**", (r) =>
    r.fulfill({
      json: {
        receipts_outcome: [
          {
            outcome: {
              executor_id: ADDRESS,
              status: { SuccessValue: "" },
              logs: [
                `EVENT_JSON:${JSON.stringify({
                  standard: "extents-objective",
                  event: "delivered",
                  data: { contributor: DELIVERED[0]!.contributor, hash: reportHash(DELIVERED[0]!.text) },
                })}`,
              ],
            },
          },
        ],
      },
    }),
  );
  const review = buildReview(ADDRESS, SPEC as never, DELIVERED, results);
  const summary = {
    passed: results.filter((r) => r.outcome === "pass").length,
    failed: results.filter((r) => r.outcome === "fail").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    verdict: review?.verdict ?? "undecided",
  };
  await page.route("**/api/evaluate", (r) => {
    return r.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: checkBody(results, { summary, delivered: DELIVERED, ...(review ? { review } : {}) }),
    });
  });
}

test("editing a checked report marks its results stale until it is checked again", async ({ page }) => {
  await setup(page);
  await objective(page, { committed: 1 });
  const reports: string[] = [];
  await page.route("**/api/check", (route) => {
    const report = route.request().postDataJSON().forwardedProps.deliverable.text as string;
    reports.push(report);
    const results: CheckResult[] =
      report === REPORT ? PASSED : [{ ...PASSED[0]!, outcome: "fail", detail: "Attendees: 12, needs at least 30" }, PASSED[1]!];
    return route.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: checkBody(results, summarize(results)),
    });
  });
  await page.goto(`/o/${ADDRESS}`);
  const report = page.getByRole("textbox", { name: "Report", exact: true });
  await report.fill(REPORT);
  await page.getByRole("button", { name: "Check my work" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ready to deliver" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Checks" })).toBeVisible();

  const edited = REPORT.replace("34", "12");
  await report.fill(edited);
  await expect(page.getByRole("status").filter({ hasText: "Report changed" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Ready to deliver" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Checks" })).toHaveCount(0);

  await page.getByRole("button", { name: "Check my work" }).click();
  await expect(page.getByRole("status").filter({ hasText: "checks fail" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Checks" })).toContainText("Attendees: 12");
  await expect(page.getByRole("status").filter({ hasText: "Report changed" })).toHaveCount(0);
  expect(reports).toEqual([REPORT, edited]);
});

test("a check finishing after the report was edited remains stale", async ({ page }) => {
  await setup(page);
  await objective(page, { committed: 1 });
  let requested = false;
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/check", async (route) => {
    requested = true;
    await response;
    await route.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: checkBody(PASSED, summarize(PASSED)),
    });
  });
  await page.goto(`/o/${ADDRESS}`);
  const report = page.getByRole("textbox", { name: "Report", exact: true });
  await report.fill(REPORT);
  await page.getByRole("button", { name: "Check my work" }).click();
  await expect.poll(() => requested).toBe(true);
  await report.fill(REPORT.replace("34", "12"));
  release();
  await expect(page.getByRole("button", { name: "Check my work" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Report changed" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Ready to deliver" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Checks" })).toHaveCount(0);
});

test("reevaluation retains proposal status for the same review", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "member.testnet");
  await objective(page, { committed: 3, delivered: 1 }, { evaluator_dao: { proposal_bond: "1", proposers: ["member.testnet"] } });
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await page.getByRole("button", { name: "Propose achieved to agency.testnet" }).click();
  await expect(page.getByText("Proposed as #0.")).toBeVisible();

  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The results support achieved" })).toBeVisible();
  await expect(page.getByText("Proposed as #0.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Propose achieved to agency.testnet" })).toHaveCount(0);
  expect(chain.txs.filter((tx) => tx.calls[0]!.method === "add_proposal")).toHaveLength(1);
});

const FAILED: CheckResult[] = [{ ...PASSED[0]!, outcome: "fail", detail: "Attendance could not be established" }, PASSED[1]!];
const REVISED: CheckResult[] = [{ ...PASSED[0]!, detail: "Attendees: 34, verified again" }, PASSED[1]!];

for (const [change, results] of [
  ["different verdict", FAILED],
  ["same verdict, different hash", REVISED],
] as const) {
  test(`proposal status follows the exact review: ${change}`, async ({ page }) => {
    const chain = await setup(page, { txs: [], published: true, funded: true }, "member.testnet");
    await objective(page, { committed: 3, delivered: 1 }, { evaluator_dao: { proposal_bond: "1", proposers: ["member.testnet"] } });
    await evaluation(page, PASSED);
    await page.goto(`/o/${ADDRESS}`);
    await page.getByRole("button", { name: "Check the deliveries" }).click();
    await page.getByRole("button", { name: "Propose achieved to agency.testnet" }).click();
    await expect(page.getByText("Proposed as #0.")).toBeVisible();

    const nextReview = buildReview(ADDRESS, SPEC as never, DELIVERED, results)!;
    await evaluation(page, results);
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByRole("status").filter({ hasText: `The results support ${nextReview.verdict}` })).toBeVisible();
    await expect(page.getByText("Proposed as #0.")).toHaveCount(0);
    await expect(page.getByText(reviewHash(nextReview))).toBeVisible();
    await page.getByRole("button", { name: `Propose ${nextReview.verdict} to agency.testnet` }).click();
    await expect(page.getByText("Proposed as #1.")).toBeVisible();

    await evaluation(page, PASSED);
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByRole("status").filter({ hasText: "The results support achieved" })).toBeVisible();
    await expect(page.getByText("Proposed as #0.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Propose achieved to agency.testnet" })).toHaveCount(0);
    expect(chain.txs.filter((tx) => tx.calls[0]!.method === "add_proposal")).toHaveLength(2);
  });
}

test("a hashless filing override belongs only to its review", async ({ page }) => {
  const chain = await setup(
    page,
    { txs: [], published: true, funded: true, uncertain: "add_proposal", proposalsHidden: true },
    "member.testnet",
  );
  await objective(page, { committed: 3, delivered: 1 }, { evaluator_dao: { proposal_bond: "1", proposers: ["member.testnet"] } });
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  const propose = page.getByRole("button", { name: "Propose achieved to agency.testnet" });
  await propose.click();
  await expect(page.getByRole("alert").filter({ hasText: "Connection closed" })).toBeVisible();
  await propose.click();
  const override = page.getByRole("button", { name: /File again anyway/ });
  await expect(override).toBeVisible();

  await evaluation(page, FAILED);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("button", { name: "Propose failed to agency.testnet" })).toBeVisible();
  await expect(override).toHaveCount(0);

  await evaluation(page, PASSED);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The results support achieved" })).toBeVisible();
  await expect(override).toBeVisible();
  expect(chain.txs.filter((tx) => tx.calls[0]!.method === "add_proposal")).toHaveLength(1);
});

test("a late filing completion stays attached to the review that was signed", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "member.testnet");
  await objective(page, { committed: 3, delivered: 1 }, { evaluator_dao: { proposal_bond: "1", proposers: ["member.testnet"] } });
  await evaluation(page, PASSED);
  let requested = false;
  let release!: () => void;
  const proof = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/__tx?**", async (route) => {
    requested = true;
    await proof;
    await route.fallback();
  });
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await page.getByRole("button", { name: "Propose achieved to agency.testnet" }).click();
  await expect.poll(() => requested).toBe(true);

  await evaluation(page, FAILED);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The results support failed" })).toBeVisible();
  release();
  await expect.poll(() => chain.txs.filter((tx) => tx.calls[0]!.method === "add_proposal").length).toBe(1);
  const proposeFailed = page.getByRole("button", { name: "Propose failed to agency.testnet" });
  await expect(proposeFailed).toBeVisible();
  await expect(proposeFailed).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("Proposed as #0.")).toHaveCount(0);
  expect(chain.txs.find((tx) => tx.calls[0]!.method === "add_proposal")!.calls[0]!.args).toEqual(
    attestProposal(ADDRESS, PARAMS as never, attestationOf(REVIEW)),
  );

  await evaluation(page, PASSED);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The results support achieved" })).toBeVisible();
  await expect(page.getByText("Proposed as #0.")).toBeVisible();
});

test("unencodable attestation terms are reported without crashing the evaluator", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "member.testnet");
  // Unknown Params fields do not affect address derivation, but are still returned by the document reader.
  await objective(
    page,
    { committed: 3, delivered: 1 },
    {
      documents: { params: { ...PARAMS, padding: "x".repeat(1_000_000) }, spec: SPEC },
      evaluator_dao: { proposal_bond: "1", proposers: ["member.testnet"] },
    },
  );
  await evaluation(page, PASSED);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "can't be attested" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Evaluate", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Propose achieved/ })).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(chain.txs).toHaveLength(0);
});

test("the evaluator checks the deliveries, publishes the review and attests its hash", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "agency.testnet");
  await objective(page, { committed: 3, delivered: 1 });
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await expect(page.getByRole("list", { name: "Checks" }).getByRole("listitem").filter({ hasText: "names New York" })).toContainText(
    "loads",
  );
  await expect(page.getByRole("status").filter({ hasText: "support" })).toContainText("The results support achieved: 2 passed, 0 failed.");
  await expect(page.getByText(reviewHash(REVIEW))).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
  }
  await page.getByRole("button", { name: "Attest achieved" }).click();
  await expect.poll(() => chain.txs.map((t) => t.calls[0]!.method)).toEqual(["__fastdata_kv", "ob_attest"]);
  expect(chain.txs[0]!.calls[0]).toMatchObject({ receiver: ADDRESS, args: { "extents/v1/review": REVIEW } });
  expect(chain.txs[1]!.calls[0]).toMatchObject({
    receiver: ADDRESS,
    args: { params: PARAMS, attestation: { verdict: "achieved", review_hash: reviewHash(REVIEW) } },
    opts: { gas: "90 Tgas" },
  });
});

test("a DAO member proposes the verdict to the evaluator DAO, with its bond", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "member.testnet");
  const dao = { proposal_bond: "100000000000000000000000", proposers: ["member.testnet"] };
  await objective(page, { committed: 3, delivered: 1 }, { evaluator_dao: dao });
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await page.getByRole("button", { name: "Propose achieved to agency.testnet" }).click();
  await expect.poll(() => chain.txs.map((t) => t.calls[0]!.method)).toEqual(["__fastdata_kv", "add_proposal"]);
  expect(chain.txs[1]!.calls[0]).toMatchObject({
    receiver: "agency.testnet",
    args: attestProposal(ADDRESS, PARAMS as never, attestationOf(REVIEW)),
    opts: { attachedDeposit: `${dao.proposal_bond} yocto` },
  });
  await expect(page.getByText("Proposed as #0.")).toBeVisible();
});

test("a lost wallet response files no second proposal, and the DAO's record settles it", async ({ page }) => {
  const chain = await setup(
    page,
    { txs: [], published: true, funded: true, uncertain: "add_proposal", proposalsHidden: true },
    "member.testnet",
  );
  const dao = { proposal_bond: "100000000000000000000000", proposers: ["member.testnet"] };
  await objective(page, { committed: 3, delivered: 1 }, { evaluator_dao: dao });
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  const propose = page.getByRole("button", { name: "Propose achieved to agency.testnet" });
  await propose.click();
  await expect(page.getByRole("alert").filter({ hasText: "Connection closed" })).toBeVisible();
  const filings = () => chain.txs.filter((t) => t.calls[0]!.method === "add_proposal").length;
  expect(filings()).toBe(1);

  // retrying, even after a reload, while the filing isn't visible sends nothing
  await page.reload();
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await propose.click();
  await expect(page.getByRole("alert").filter({ hasText: "no second one" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "File again anyway: posts another bond and may create a duplicate proposal" }),
  ).toBeVisible();
  expect(filings()).toBe(1);

  // once the DAO shows it, the page recognises it as filed, still without a second send
  chain.proposalsHidden = false;
  await propose.click();
  await expect(page.getByText("Proposed as #0.")).toBeVisible();
  expect(filings()).toBe(1);
});

test("a lost response with a transaction hash is settled from its final receipt, never by resending", async ({ page }) => {
  const chain = await setup(
    page,
    { txs: [], published: true, funded: true, uncertain: "add_proposal", uncertainWithHash: true, proposalsHidden: true },
    "member.testnet",
  );
  let receipt: unknown = { final_execution_status: "INCLUDED" };
  await page.route("https://rpc.testnet.near.org/**", (r) => r.fulfill({ json: { jsonrpc: "2.0", id: "proposal", result: receipt } }));
  await objective(page, { committed: 3, delivered: 1 }, { evaluator_dao: { proposal_bond: "1", proposers: ["member.testnet"] } });
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  const propose = page.getByRole("button", { name: "Propose achieved to agency.testnet" });
  await propose.click();
  await expect(page.getByRole("alert").filter({ hasText: "Connection closed" })).toBeVisible();

  // not final yet: nothing is resent, and no override is offered while a transaction can settle it
  await propose.click();
  await expect(page.getByRole("alert").filter({ hasText: "outcome is not finalized" })).toBeVisible();
  await expect(page.getByRole("button", { name: /File again anyway/ })).toHaveCount(0);

  receipt = {
    final_execution_status: "FINAL",
    transaction: { hash: "TX-add_proposal", signer_id: "member.testnet" },
    receipts_outcome: [{ outcome: { executor_id: "agency.testnet", logs: [], status: { SuccessValue: btoa("0") } } }],
  };
  await propose.click();
  await expect(page.getByText("Proposed as #0.")).toBeVisible();
  expect(chain.txs.filter((t) => t.calls[0]!.method === "add_proposal")).toHaveLength(1);
});

test("filing again anyway shows duplicates from the DAO without a local history", async ({ page }) => {
  const chain = await setup(
    page,
    { txs: [], published: true, funded: true, uncertain: "add_proposal", proposalsHidden: true, revealAt: 2 },
    "member.testnet",
  );
  await objective(page, { committed: 3, delivered: 1 }, { evaluator_dao: { proposal_bond: "1", proposers: ["member.testnet"] } });
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  const propose = page.getByRole("button", { name: "Propose achieved to agency.testnet" });
  await propose.click();
  await expect(page.getByRole("alert").filter({ hasText: "Connection closed" })).toBeVisible();
  await propose.click();
  await page.getByRole("button", { name: "File again anyway: posts another bond and may create a duplicate proposal" }).click();
  expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.endsWith(":set-aside")))).toBe(false);

  await propose.click();
  await expect(page.getByText(/Proposed as #0\..*#1 duplicates it; ask agency\.testnet to reject the extra proposals\./)).toBeVisible();
  expect(chain.txs.filter((t) => t.calls[0]!.method === "add_proposal")).toHaveLength(2);
});

test("a filing the DAO refused may be filed again", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true, refuseProposal: true }, "member.testnet");
  await objective(page, { committed: 3, delivered: 1 }, { evaluator_dao: { proposal_bond: "1", proposers: ["member.testnet"] } });
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  const propose = page.getByRole("button", { name: "Propose achieved to agency.testnet" });
  await propose.click();
  await expect(page.getByRole("alert").filter({ hasText: "refused the proposal" })).toBeVisible();
  await propose.click();
  await expect(page.getByText("Proposed as #0.")).toBeVisible();
  expect(chain.txs.filter((t) => t.calls[0]!.method === "add_proposal")).toHaveLength(2);
});

test("an attestation already proposed by someone else isn't filed again", async ({ page }) => {
  const filed = attestProposal(ADDRESS, PARAMS as never, attestationOf(REVIEW)).proposal.kind;
  const chain = await setup(
    page,
    {
      txs: [],
      published: true,
      funded: true,
      proposals: [
        { id: 0, status: "Rejected", kind: filed },
        { id: 1, status: "InProgress", kind: { Transfer: {} } },
        { id: 2, status: "InProgress", kind: filed },
      ],
    },
    "member.testnet",
  );
  await objective(page, { committed: 3, delivered: 1 }, { evaluator_dao: { proposal_bond: "1", proposers: ["member.testnet"] } });
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await page.getByRole("button", { name: "Propose achieved to agency.testnet" }).click();
  await expect(page.getByText("Proposed as #2.")).toBeVisible();
  expect(chain.txs.map((t) => t.calls[0]!.method)).not.toContain("add_proposal");
});

test("results with a skipped check offer no attestation", async ({ page }) => {
  await setup(page, { txs: [], published: true, funded: true }, "agency.testnet");
  await objective(page, { committed: 3, delivered: 1 });
  await evaluation(page, [PASSED[0]!, { criterion_id: "page", outcome: "skipped", detail: "could not check", evidence: [] }]);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await expect(page.getByRole("status").filter({ hasText: "no verdict" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Attest/ })).toHaveCount(0);
});

test("achieved can't be attested until every contributor committed", async ({ page }) => {
  await setup(page, { txs: [], published: true, funded: true }, "agency.testnet");
  await objective(page, { committed: 1, delivered: 1 });
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await expect(page.getByRole("alert")).toContainText("Not every contributor committed");
  await expect(page.getByRole("button", { name: /Attest/ })).toHaveCount(0);
});

test("a visitor who can't propose to the evaluator DAO sees the checker", async ({ page }) => {
  await setup(page, undefined, "stranger.testnet");
  await objective(page, { committed: 3 }, { evaluator_dao: { proposal_bond: "1", proposers: ["member.testnet"] } });
  await page.goto(`/o/${ADDRESS}`);
  await expect(page.getByRole("button", { name: "Check my work" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Evaluate" })).toHaveCount(0);
});

test("an allocated outcome does not claim that pending payouts were paid", async ({ page }, testInfo) => {
  const chain = await setup(page, { txs: [], published: true, funded: true });
  await objective(page, { outcome: "achieved", funded: "0", owed: { "contributor:0": "3500000" }, in_flight: 0 });
  await page.goto(`/o/${ADDRESS}`);
  await expect(page.getByText("Some payouts need a retry.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Objective resolved" })).toBeVisible();
  await expect(page.getByText("Awaiting funding")).toHaveCount(0);
  await expect(page.getByText("the contributors were paid", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("settlement-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Close or retry payouts" }).click();
  await expect.poll(() => chain.txs.map((t) => t.calls[0]!.method)).toEqual(["ob_close"]);
});

test("the effective acceptance deadline keeps attestation available", async ({ page }) => {
  await setup(page, { txs: [], published: true, funded: true }, "agency.testnet");
  await objective(
    page,
    { committed: 3, delivered: 1, deadline: "2027-03-02T00:00:00Z" },
    {
      documents: { params: { ...PARAMS, deadline: "2020-01-01T00:00:00Z", acceptance_window_secs: 3600 }, spec: SPEC },
    },
  );
  await evaluation(page, PASSED);
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await expect(page.getByRole("button", { name: "Attest achieved" })).toBeVisible();
});

test("delivery-proof recovery remains accessible on mobile", async ({ page }, testInfo) => {
  await setup(page, { txs: [], published: true, funded: true }, "organizer.testnet");
  await objective(page, { committed: 1, delivered: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/o/${ADDRESS}`);
  await expect(page.getByRole("textbox", { name: "Delivered report" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Delivery transaction hash" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish delivery proof" })).toBeDisabled();
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("delivery-recovery-mobile.png"), fullPage: true });
});

test("after the effective deadline, attestation is blocked and closing is available", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "agency.testnet");
  await objective(page, { committed: 3, delivered: 1 });
  await evaluation(page, PASSED);
  await page.clock.setFixedTime(new Date("2028-01-01T00:00:00Z"));
  await page.goto(`/o/${ADDRESS}`);
  await page.getByRole("button", { name: "Check the deliveries" }).click();
  await expect(page.getByRole("alert")).toContainText("The deadline has passed");
  await expect(page.getByRole("button", { name: /^Attest / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close or retry payouts" })).toBeVisible();
  expect(chain.txs).toHaveLength(0);
});
