/** axe on the states a customer sees, in both colour schemes. */
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";

import { test, send, setup } from "./fixtures.ts";

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme });

    test("landing", async ({ page }) => {
      await page.addInitScript(() => Object.assign(window, { __EXTENTS_TEST_WALLET__: undefined }));
      await page.goto("/");
      expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
    });

    test("ready to sign, then live escrow", async ({ page }) => {
      await setup(page);
      await page.goto("/");
      await send(page, "I want a meetup in NYC, launch it");
      await page.getByRole("region", { name: "Ready to sign" }).waitFor();
      expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
      await page.getByRole("button", { name: /^Launch and fund/ }).click();
      await page.getByRole("heading", { name: "Live escrow" }).waitFor();
      // focus follows the news
      await expect(page.getByRole("heading", { name: "Live escrow" })).toBeFocused();
      expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
    });
  });
}

test("objective page, for a contributor", async ({ page }) => {
  const address = "0s" + "cd".repeat(20);
  await setup(page, { txs: [], published: true, funded: true }, "organizer.testnet");
  await page.route(`**/api/objective/${address}`, (r) =>
    r.fulfill({
      json: {
        deployed: true,
        state: { funded: "5000000", committed: 1 },
        documents: {
          params: {
            sponsor: "customer.testnet",
            token: "nep245:verifier.tidepool-sandbox.testnet:nep141:usdc.tidepool-sandbox.testnet",
            evaluator: "agency.testnet",
            contributors: { "organizer.testnet": 1000000 },
            deadline: "2027-03-01T00:00:00Z",
            spec_hash: "00".repeat(32),
            salt: "11".repeat(32),
          },
          spec: {
            v: 1,
            statement: "A meetup",
            criteria: [{ id: "n", description: "Attendance", check: { kind: "numeric_match", label: "Attendees", min: 30 } }],
          },
        },
      },
    }),
  );
  await page.goto(`/o/${address}`);
  await page.getByRole("heading", { name: "Live escrow" }).waitFor();
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
});
