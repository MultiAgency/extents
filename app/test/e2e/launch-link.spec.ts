/** A launch link: the sponsor opens the objective's page with its terms in the fragment and launches it there. */
import { expect, type Page } from "@playwright/test";

import { launchFragment, type LaunchLink } from "../../src/shared/launch-link.ts";
import { buildObjective } from "../../src/shared/objective.ts";
import { test, setup, type Chain } from "./fixtures.ts";

const CODE_HASH = "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa"; // the e2e build's, as in playwright.config.ts
const LINK = {
  proposal: {
    spec: {
      v: 1,
      statement: "A NEAR builders meetup in New York City for at least 30 people",
      criteria: [
        { id: "attendance", description: "At least 30 people attend", check: { kind: "numeric_match", label: "Attendees", min: 30 } },
      ],
    },
    contributors: { "organizer.testnet": 100 },
    evaluator: "customer.testnet",
    deadline: "2027-03-01T00:00:00Z",
    amount: "2",
  },
  sponsor: "customer.testnet",
  salt: "ab".repeat(32),
} as LaunchLink;
const O = buildObjective(LINK.proposal, LINK.sponsor, LINK.salt, CODE_HASH, Date.parse("2027-01-01T00:00:00Z"));
const URL_ = `/o/${O.accountId}${launchFragment(LINK)}`;

/** The objective as the chain shows it: nothing until published, then its terms, funded once the wallet funds it. */
async function objective(page: Page, chain: Chain) {
  await page.route(`**/api/objective/${O.accountId}`, (r) =>
    r.fulfill({
      json: {
        deployed: chain.published,
        ...(chain.published ? { documents: { params: JSON.parse(JSON.stringify(O.params)), spec: O.spec } } : {}),
        state: { funded: chain.funded ? "2000000" : "0" },
      },
    }),
  );
}

const next = (page: Page) => page.getByRole("region", { name: "Progress" }).getByRole("status");

test("the sponsor launches a drafted objective from its link", async ({ page }) => {
  const chain = await setup(page);
  await objective(page, chain);
  await page.goto(URL_);
  await expect(next(page)).toContainText("Your turn: sign the terms and fund the escrow.");
  const card = page.getByRole("region", { name: "Ready to sign" });
  await expect(card.locator("code")).toHaveText(O.accountId);
  await card.getByRole("button", { name: /^Launch and fund/ }).click();

  await expect(page.getByRole("heading", { name: "Live escrow" })).toBeVisible();
  expect(chain.txs.map((t) => t.calls[0]!.method)).toEqual(["__fastdata_kv", "mt_transfer_call"]);
  expect(chain.txs[1]!.calls[0]).toMatchObject({ args: { receiver_id: O.accountId, amount: "2000000" } });
  // once launched, the address bar holds the plain link to share with the contributors
  expect(new URL(page.url()).hash).toBe("");
  await expect(next(page)).toContainText("Waiting for organizer.testnet to commit to the work.");
});

test("anyone else is asked to switch to the sponsor, with nothing to sign", async ({ page }) => {
  const chain = await setup(page, { txs: [], published: false, funded: false }, "organizer.testnet");
  await objective(page, chain);
  await page.goto(URL_);
  await expect(next(page)).toContainText("Waiting for customer.testnet to sign the terms and fund the escrow.");
  await expect(next(page).getByRole("button", { name: "Switch to customer.testnet" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Launch and fund/ })).toHaveCount(0);
});

test("terms that don't derive the page's address offer nothing to sign", async ({ page }) => {
  const chain = await setup(page);
  await objective(page, chain);
  const tampered = launchFragment({ ...LINK, proposal: { ...LINK.proposal, contributors: { "thief.testnet": 100 } } });
  await page.goto(`/o/${O.accountId}${tampered}`);
  await expect(page.getByRole("alert")).toContainText("derive a different address");
  await expect(page.getByRole("button", { name: /^Launch and fund/ })).toHaveCount(0);
});
