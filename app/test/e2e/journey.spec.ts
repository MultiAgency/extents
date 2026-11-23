/** The walk-through: every page says which step the objective is at and whose move it is. */
import { expect, type Page } from "@playwright/test";

import { test, setup } from "./fixtures.ts";

const ADDRESS = "0s" + "cd".repeat(20);
const PARAMS = {
  sponsor: "customer.testnet",
  token: "nep245:verifier.tidepool-sandbox.testnet:nep141:usdc.tidepool-sandbox.testnet",
  evaluator: "judge.testnet",
  contributors: { "organizer.testnet": 700000, "venue.testnet": 300000 },
  deadline: "2027-03-01T00:00:00Z",
  spec_hash: "00".repeat(32),
  auth_caller: "verifier.tidepool-sandbox.testnet",
  salt: "11".repeat(32),
};
const SPEC = {
  v: 1,
  statement: "A NEAR builders meetup in New York City for at least 30 people",
  criteria: [{ id: "attendance", description: "At least 30 people attend", check: { kind: "numeric_match", label: "Attendees", min: 30 } }],
};

/** Serves the objective in `state`; returns a setter, as if another wallet acted. */
async function objective(page: Page, state: Record<string, unknown>) {
  let current = state;
  await page.route(`**/api/objective/${ADDRESS}`, (r) =>
    r.fulfill({ json: { deployed: true, state: { funded: "5000000", ...current }, documents: { params: PARAMS, spec: SPEC } } }),
  );
  return (next: Record<string, unknown>) => void (current = next);
}

const step = (page: Page, name: string) => page.getByRole("region", { name: "Progress" }).getByText(new RegExp(`^${name} \\(`));
const next = (page: Page) => page.getByRole("region", { name: "Progress" }).getByRole("status");

test("a visitor sees whose move it is, and can switch to their wallet", async ({ page }, info) => {
  await setup(page);
  await objective(page, { committed: 1 });
  await page.goto(`/o/${ADDRESS}`);
  await expect(step(page, "Fund")).toHaveText("Fund (done)");
  await expect(step(page, "Commit")).toHaveText("Commit (now)");
  await expect(next(page)).toContainText("Waiting for venue.testnet to commit to the work.");
  await expect(next(page).getByRole("button", { name: "Switch to venue.testnet" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("visitor.png"), fullPage: true });
});

test("the contributor whose turn it is is taken to their part", async ({ page }, info) => {
  await setup(page, { txs: [], published: true, funded: true }, "organizer.testnet");
  await objective(page, { committed: 3, delivered: 2 });
  await page.goto(`/o/${ADDRESS}`);
  await expect(next(page)).toContainText("Your turn: deliver a report.");
  await next(page).getByRole("link", { name: "Go to your part" }).click();
  await expect(page.getByRole("region", { name: "Your part" })).toBeInViewport();
  await page.screenshot({ path: info.outputPath("contributor.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  // on a phone only the current step keeps its label; the bar never scrolls sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("contributor-phone.png") });
});

test("the page follows the objective as other wallets act", async ({ page }) => {
  await page.clock.install({ time: new Date("2027-01-01T00:00:00Z") });
  await setup(page, { txs: [], published: true, funded: true }, "judge.testnet");
  const set = await objective(page, { committed: 3, delivered: 1 });
  await page.goto(`/o/${ADDRESS}`);
  await expect(next(page)).toContainText("Waiting for venue.testnet to deliver a report.");
  set({ committed: 3, delivered: 3 });
  await page.clock.runFor(9000);
  await expect(next(page)).toContainText("Your turn: judge the deliveries and attest a verdict.");
});

test("a settled objective says how it ended", async ({ page }, info) => {
  await setup(page);
  await objective(page, { committed: 3, delivered: 3, funded: "0", outcome: "achieved", owed: {}, in_flight: 0 });
  await page.goto(`/o/${ADDRESS}`);
  await expect(step(page, "Paid")).toHaveText("Paid (done)");
  await expect(next(page)).toHaveText("Settled: achieved, and every share is paid.");
  await page.screenshot({ path: info.outputPath("settled.png"), fullPage: true });
});

test("a failed objective shows the refund", async ({ page }) => {
  await setup(page);
  await objective(page, { committed: 3, delivered: 1, funded: "0", outcome: "failed", owed: {}, in_flight: 0 });
  await page.goto(`/o/${ADDRESS}`);
  await expect(step(page, "Refunded")).toHaveText("Refunded (done)");
  await expect(next(page)).toHaveText("Settled: failed, and the sponsor is refunded.");
});

test("the workspace starts from a brief in one click", async ({ page }, info) => {
  await setup(page);
  await page.goto("/");
  await expect(next(page)).toHaveText("Your turn: describe the outcome you want funded.");
  await page.screenshot({ path: info.outputPath("workspace.png"), fullPage: true });
  await page.getByRole("button", { name: /^I have 2 USDC/ }).click();
  await expect(page.getByRole("log", { name: "Conversation" })).toContainText("I have 2 USDC");
});

test("once everyone delivered, the sponsor may release the payment without the evaluator", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "customer.testnet");
  const set = await objective(page, { committed: 3, delivered: 1 });
  await page.goto(`/o/${ADDRESS}`);
  await expect(next(page)).toContainText("Waiting for venue.testnet to deliver a report.");
  await expect(page.getByRole("region", { name: "Release payment" })).toHaveCount(0);

  set({ committed: 3, delivered: 3 });
  await page.reload();
  await expect(next(page)).toContainText("Waiting for judge.testnet to judge the deliveries and attest a verdict.");
  await next(page).getByRole("link", { name: "Release payment" }).click();
  const release = page.getByRole("region", { name: "Release payment" });
  await expect(release).toBeInViewport();
  await release.getByRole("button", { name: "Release payment" }).click();
  await expect.poll(() => chain.txs.map((t) => t.calls[0]!.method)).toEqual(["ob_attest"]);
  expect(chain.txs[0]!.calls[0]).toMatchObject({ receiver: ADDRESS, args: { params: PARAMS, attestation: { verdict: "achieved" } } });
});

test("while nobody has committed, the sponsor may cancel and take the funding back", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "customer.testnet");
  const set = await objective(page, {});
  await page.goto(`/o/${ADDRESS}`);
  const cancel = page.getByRole("region", { name: "Cancel" });
  await cancel.getByRole("button", { name: "Cancel and refund" }).click();
  await expect.poll(() => chain.txs.map((t) => t.calls[0]!.method)).toEqual(["ob_cancel"]);
  expect(chain.txs[0]!.calls[0]).toMatchObject({ receiver: ADDRESS, args: { params: PARAMS } });

  set({ committed: 1 });
  await page.reload();
  await expect(next(page)).toContainText("Waiting for venue.testnet to commit");
  await expect(page.getByRole("region", { name: "Cancel" })).toHaveCount(0);

  set({ funded: "0", outcome: "cancelled" });
  await page.reload();
  await expect(next(page)).toHaveText("Settled: cancelled, and the sponsor is refunded.");
  await expect(step(page, "Commit")).toHaveText("Commit (not needed)");
});

test("a committed contributor may withdraw before delivering", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: true }, "organizer.testnet");
  await objective(page, { committed: 1 });
  await page.goto(`/o/${ADDRESS}`);
  const part = page.getByRole("region", { name: "Your part" });
  await expect(page.getByRole("region", { name: "Cancel" })).toHaveCount(0);
  await part.getByRole("button", { name: "Withdraw" }).click();
  await expect.poll(() => chain.txs.map((t) => t.calls[0]!.method)).toEqual(["ob_withdraw"]);
  expect(chain.txs[0]!.calls[0]).toMatchObject({ receiver: ADDRESS, args: { params: PARAMS } });
});
