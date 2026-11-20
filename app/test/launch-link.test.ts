import { expect, test } from "vitest";

import { launchFragment, parseLaunchFragment, type LaunchLink } from "../src/shared/launch-link.ts";

const LINK: LaunchLink = {
  proposal: {
    spec: {
      v: 1,
      statement: "Un café pour 30 personnes à Zürich ☕",
      criteria: [{ id: "n", description: "Attendance", check: { kind: "numeric_match", label: "Attendees", min: 30 } }],
    },
    contributors: { "organizer.testnet": 100 },
    evaluator: "agency.testnet",
    deadline: "2027-03-01T00:00:00Z",
    amount: "2",
  },
  sponsor: "customer.testnet",
  salt: "ab".repeat(32),
} as LaunchLink;

test("round-trips the terms through a URL-safe fragment, non-ASCII included", () => {
  const fragment = launchFragment(LINK);
  expect(fragment).toMatch(/^#launch=[A-Za-z0-9_-]+$/);
  expect(parseLaunchFragment(fragment)).toEqual(LINK);
});

test("no launch terms, or unreadable ones", () => {
  expect(parseLaunchFragment("")).toBeUndefined();
  expect(parseLaunchFragment("#other")).toBeUndefined();
  expect(parseLaunchFragment("#launch=%%%")).toBeInstanceOf(Error);
  const wrongSalt = launchFragment({ ...LINK, salt: "short" });
  expect(String(parseLaunchFragment(wrongSalt))).toMatch(/invalid/);
});
