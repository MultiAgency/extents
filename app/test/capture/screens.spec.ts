/** Screenshots for design review, not a check: `pnpm capture:screens`. */

import { test, send, setup } from "../e2e/fixtures.ts";

const dir = process.env.SCREENS ?? "test-results/screens";

for (const scheme of ["light", "dark"] as const) {
  test(`landing and flow, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => Object.assign(window, { __EXTENTS_TEST_WALLET__: undefined }));
    await page.goto("/");
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/landing-${scheme}.png` });
  });
}

test("flow: ready to sign, then sealed", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");
  await send(page, "I want a NEAR builders meetup in NYC, launch it");
  await page.getByRole("region", { name: "Ready to sign" }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/ready.png` });
  await page.getByRole("button", { name: /^Launch and fund/ }).click();
  await page.getByRole("heading", { name: "Live escrow" }).waitFor();
  await page.waitForTimeout(1900);
  await page.screenshot({ path: `${dir}/sealed.png` });
});

test("mobile: ready to sign", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await send(page, "I want a NEAR builders meetup in NYC, launch it");
  await page.getByRole("region", { name: "Ready to sign" }).waitFor();
  await page.screenshot({ path: `${dir}/mobile.png`, fullPage: true });
});

test("objective page: a contributor's live checks", async ({ page }) => {
  const ADDRESS = "0s" + "ab".repeat(20);
  await setup(page, { txs: [], published: true, funded: true }, "organizer.testnet");
  const spec = {
    v: 1,
    statement: "A NEAR builders meetup in New York City for at least 30 people",
    criteria: [
      {
        id: "page",
        description: "The public event page names New York",
        check: { kind: "live_url", label: "Event page", must_contain: "New York" },
      },
      { id: "attendance", description: "At least 30 people attend", check: { kind: "numeric_match", label: "Attendees", min: 30 } },
      { id: "photos", description: "Three photos from the evening", check: { kind: "media", kinds: ["image"], min: 3 } },
    ],
  };
  const params = {
    sponsor: "customer.testnet",
    token: "nep245:verifier.tidepool-sandbox.testnet:nep141:usdc.tidepool-sandbox.testnet",
    evaluator: "newyork.citynode.testnet",
    contributors: { "organizer.testnet": 700000, "venue.testnet": 300000 },
    deadline: "2027-03-01T00:00:00Z",
    spec_hash: "00".repeat(32),
    salt: "11".repeat(32),
  };
  await page.route(`**/api/objective/${ADDRESS}`, (r) =>
    r.fulfill({ json: { deployed: true, state: { funded: "500000000", committed: 3 }, documents: { params, spec } } }),
  );
  await page.route("**/api/check", (r) => {
    const results = [
      ["attendance", "pass", "Attendees: 34"],
      ["page", "pass", 'https://lu.ma/nyc-builders loads and shows "New York"'],
      ["photos", "fail", "2 of the needed 3 image items load"],
    ];
    const events = [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      ...spec.criteria.flatMap((c) => [
        { type: "TOOL_CALL_START", toolCallId: c.id, toolCallName: "check", parentMessageId: "m" },
        { type: "TOOL_CALL_ARGS", toolCallId: c.id, delta: JSON.stringify({ criterion_id: c.id, description: c.description }) },
        { type: "TOOL_CALL_END", toolCallId: c.id },
      ]),
      ...results.map(([id, outcome, detail], i) => ({
        type: "TOOL_CALL_RESULT",
        messageId: `r${i}`,
        toolCallId: id,
        content: JSON.stringify({ criterion_id: id, outcome, detail, evidence: [] }),
      })),
      { type: "RUN_FINISHED", threadId: "t", runId: "r", result: { passed: 2, failed: 1, skipped: 0, verdict: "failed" } },
    ];
    return r.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`/o/${ADDRESS}`);
  await page
    .getByRole("textbox", { name: /Your report/ })
    .fill("Event page: https://lu.ma/nyc-builders\nAttendees: 34\n![](https://example.org/1.jpg) ![](https://example.org/2.jpg)");
  await page.getByRole("button", { name: "Check my work" }).click();
  await page.getByRole("status").filter({ hasText: "checks fail" }).waitFor();
  await page.screenshot({ path: `${dir}/objective.png` });
});
