/**
 * The customer flow in a real browser: the built app and its Bun server, a
 * scripted NEAR AI stand-in, and a fake wallet whose transactions the test
 * records and whose chain the test simulates, across reloads.
 */
import { expect, type Page } from "@playwright/test";

import { test, BROWSER_NOW, send, setup, type Chain } from "./fixtures.ts";

const methods = (chain: Chain) => chain.txs.map((t) => t.calls[0]!.method);
const card = (page: Page) => page.getByRole("region", { name: "Ready to sign" });

test("server tool errors appear as failures in the conversation", async ({ page }) => {
  await setup(page);
  await page.route("**/api/agent", (route) =>
    route.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: [
        { type: "RUN_STARTED", threadId: "t", runId: "r" },
        { type: "TOOL_CALL_START", toolCallId: "balance", toolCallName: "verifier_balance", parentMessageId: "m" },
        { type: "TOOL_CALL_ARGS", toolCallId: "balance", delta: JSON.stringify({ account: "customer.testnet" }) },
        { type: "TOOL_CALL_END", toolCallId: "balance" },
        {
          type: "TOOL_CALL_RESULT",
          messageId: "result",
          toolCallId: "balance",
          content: JSON.stringify({ error: "Balance service unavailable" }),
        },
        { type: "RUN_FINISHED", threadId: "t", runId: "r" },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    }),
  );
  await page.goto("/");
  await send(page, "Check my balance");
  const failure = page.getByRole("log").locator("p").filter({ hasText: "Balance service unavailable" });
  await expect(failure).toBeVisible();
  await expect(failure).toHaveClass(/text-alert/);
  await expect(page.getByText("Your balance: ? USDC", { exact: true })).toHaveCount(0);
});

test.describe("customer flow", () => {
  test("launch: terms on the card are exactly what the wallet signs", async ({ page }) => {
    const chain = await setup(page);
    await page.goto("/");
    await send(page, "I want a meetup in NYC, launch it");
    await expect(page.getByText("The spec checks out")).toBeVisible();
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByText("5 USDC", { exact: true })).toBeVisible();
    await expect(card(page).getByRole("listitem").filter({ hasText: "organizer.testnet" })).toContainText("70% · 3.5 USDC");
    await expect(card(page).getByRole("listitem").filter({ hasText: "venue.testnet" })).toContainText("30% · 1.5 USDC");
    const address = (await card(page).locator("code").innerText()).trim();
    expect(address).toMatch(/^0s[0-9a-f]{40}$/);

    await card(page)
      .getByRole("button", { name: /^Launch and fund/ })
      .click();
    await expect(page.getByRole("heading", { name: "Live escrow" })).toBeVisible();
    // the server believes the browser only as far as the chain shows: nothing was really deployed here
    await expect(page.getByText(/Launch result: .*"launched":false.*not funded on chain/)).toBeVisible();

    const [publish, fund] = chain.txs;
    expect(publish!.calls[0]).toMatchObject({ receiver: address, method: "__fastdata_kv" });
    const params = publish!.calls[0]!.args["extents/v1/params"] as Record<string, unknown>;
    expect(params).toMatchObject({
      sponsor: "customer.testnet",
      evaluator: "agency.testnet",
      contributors: { "organizer.testnet": 700000, "venue.testnet": 300000 },
    });
    expect(fund!.calls[0]).toMatchObject({
      receiver: "verifier.tidepool-sandbox.testnet",
      method: "mt_transfer_call",
      args: { receiver_id: address, amount: "5000000", token_id: "nep141:usdc.tidepool-sandbox.testnet" },
      opts: { attachedDeposit: "1 yocto" },
    });
    expect(JSON.parse(fund!.calls[0]!.args.msg as string)).toEqual({ params, action: { action: "fund" } });
  });

  test("decline: nothing is signed and the model hears why", async ({ page }) => {
    const chain = await setup(page);
    await page.goto("/");
    await send(page, "I want a meetup in NYC, launch it");
    await card(page).getByRole("button", { name: "Decline" }).click();
    await expect(page.getByRole("region", { name: "Draft" }).getByRole("status")).toHaveText(/^Not launched: the customer declined/);
    await expect(page.getByText(/Launch result: .*declined these terms/)).toBeVisible();
    expect(chain.txs).toHaveLength(0);
  });

  test("invalid terms go back to the model without a click", async ({ page }) => {
    const chain = await setup(page);
    await page.goto("/");
    await send(page, "launch with bad terms");
    await expect(page.getByText(/Launch result: .*shares must sum to exactly 100%/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Launch and fund/ })).toHaveCount(0);
    expect(chain.txs).toHaveLength(0);
  });

  test("a wallet rejection stops the launch at once, not after a timeout", async ({ page }) => {
    const chain = await setup(page, { txs: [], published: false, funded: false, reject: "__fastdata_kv" });
    await page.goto("/");
    await send(page, "I want a meetup in NYC, launch it");
    await card(page)
      .getByRole("button", { name: /^Launch and fund/ })
      .click();
    await expect(page.getByRole("alert")).toContainText("rejected", { timeout: 5_000 });
    await expect(card(page).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(methods(chain)).toEqual([]);
  });

  test("an objective already funded on chain is not funded again", async ({ page }) => {
    const chain = await setup(page, { txs: [], published: true, funded: true });
    await page.goto("/");
    await send(page, "I want a meetup in NYC, launch it");
    await card(page)
      .getByRole("button", { name: /^Launch and fund/ })
      .click();
    await expect(page.getByRole("heading", { name: "Live escrow" })).toBeVisible();
    expect(methods(chain)).toEqual([]);
  });

  test("after a reload, the same terms resume the same objective", async ({ page }) => {
    const chain = await setup(page, { txs: [], published: false, funded: false, reject: "mt_transfer_call" });
    await page.goto("/");
    await send(page, "I want a meetup in NYC, launch it");
    const address = (await card(page).locator("code").innerText()).trim();
    await card(page)
      .getByRole("button", { name: /^Launch and fund/ })
      .click();
    await expect(page.getByRole("alert")).toContainText("rejected");
    expect(methods(chain)).toEqual(["__fastdata_kv"]);

    await page.reload();
    await send(page, "I want a meetup in NYC, launch it");
    expect((await card(page).locator("code").innerText()).trim()).toBe(address);
    await expect(card(page).getByText("(done)")).toHaveCount(2);
    await card(page)
      .getByRole("button", { name: /^Launch and fund/ })
      .click();
    await expect(page.getByRole("heading", { name: "Live escrow" })).toBeVisible();
    // published once, funded once, at the same address
    expect(methods(chain)).toEqual(["__fastdata_kv", "mt_transfer_call"]);
    expect(chain.txs[1]!.calls[0]!.args.receiver_id).toBe(address);
  });
});

test("an unknown funding outcome blocks retries and survives reload", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: false, funded: false, uncertain: "mt_transfer_call" });
  await page.goto("/");
  await send(page, "I want a meetup in NYC, launch it");
  await card(page)
    .getByRole("button", { name: /^Launch and fund/ })
    .click();
  await expect(page.getByRole("alert")).toContainText("Connection closed");
  await card(page).getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert")).toContainText("unresolved");
  await page.reload();
  await send(page, "I want a meetup in NYC, launch it");
  await card(page)
    .getByRole("button", { name: /^Launch and fund/ })
    .click();
  await expect(page.getByRole("alert")).toContainText("unresolved");
  expect(methods(chain).filter((method) => method === "mt_transfer_call")).toHaveLength(1);
});

test("two tabs cannot sign funding for the same launch concurrently", async ({ page, context }) => {
  let finish!: () => void;
  const holdFunding = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const chain = await setup(page, { txs: [], published: false, funded: false, holdFunding });
  await page.goto("/");
  await send(page, "I want a meetup in NYC, launch it");
  await card(page)
    .getByRole("button", { name: /^Launch and fund/ })
    .click();
  await expect.poll(() => methods(chain).includes("mt_transfer_call")).toBe(true);
  const second = await context.newPage();
  await second.clock.setFixedTime(new Date(BROWSER_NOW));
  await setup(second, chain);
  await second.goto("/");
  await send(second, "I want a meetup in NYC, launch it");
  await card(second)
    .getByRole("button", { name: /^Launch and fund/ })
    .click();
  await expect(second.getByRole("alert")).toContainText("another tab");
  finish();
  await expect(page.getByRole("heading", { name: "Live escrow" })).toBeVisible();
  expect(methods(chain).filter((method) => method === "mt_transfer_call")).toHaveLength(1);
});

test("a successful funding receipt survives a failed downstream resolver during reconciliation", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: true, funded: false, uncertain: "mt_transfer_call" });
  await page.goto("/");
  await send(page, "I want a meetup in NYC, launch it");
  const address = (await card(page).locator("code").innerText()).trim();
  await card(page)
    .getByRole("button", { name: /^Launch and fund/ })
    .click();
  await expect(page.getByRole("alert")).toContainText("Connection closed");
  // Simulate the adapter having persisted the wallet's hash before the SDK's finality lookup failed.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith("extents:launch:"))!;
    const record = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...record, fundTx: "KNOWN" }));
  });
  await page.route("https://rpc.testnet.near.org/**", (route) =>
    route.fulfill({
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST, OPTIONS",
      },
      json: {
        result: {
          final_execution_status: "FINAL",
          transaction: { hash: "KNOWN", signer_id: "customer.testnet" },
          status: { Failure: { resolver: "failed" } },
          receipts_outcome: [
            {
              outcome: {
                executor_id: address,
                status: { SuccessValue: "" },
                logs: ['EVENT_JSON:{"standard":"extents-objective","event":"funded","data":{}}'],
              },
            },
          ],
        },
      },
    }),
  );
  await card(page).getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Live escrow" })).toBeVisible();
  expect(methods(chain).filter((method) => method === "mt_transfer_call")).toHaveLength(1);
});
