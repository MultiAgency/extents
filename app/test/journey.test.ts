import { describe, expect, test } from "vitest";

import type { Params } from "../src/shared/params.ts";
import { launchJourney, nextLine, objectiveJourney } from "../src/web/journey.ts";

const PARAMS = {
  sponsor: "customer.testnet",
  evaluator: "judge.testnet",
  contributors: { "a.testnet": 500000, "b.testnet": 500000 },
  backups: { "a.testnet": "backup.testnet" },
  deadline: "2027-03-01T00:00:00Z",
} as unknown as Params;
const BEFORE = Date.parse("2027-01-01T00:00:00Z");
const AFTER = Date.parse("2027-04-01T00:00:00Z");

describe("objective journey", () => {
  test.each([
    ["unfunded", { funded: "0" }, "fund", ["customer.testnet"]],
    ["funded, nobody committed", { funded: "1" }, "commit", ["a.testnet", "b.testnet"]],
    ["one committed", { funded: "1", committed: 0b01 }, "commit", ["b.testnet"]],
    ["all committed", { funded: "1", committed: 0b11 }, "deliver", ["a.testnet", "b.testnet"]],
    ["one delivered", { funded: "1", committed: 0b11, delivered: 0b10 }, "deliver", ["a.testnet"]],
    ["all delivered", { funded: "1", committed: 0b11, delivered: 0b11 }, "judge", ["judge.testnet"]],
  ])("%s", (_, state, current, actors) => {
    expect(objectiveJourney(PARAMS, state, BEFORE)).toMatchObject({ current, actors });
  });

  test("a slot a backup took is the backup's move", () => {
    expect(objectiveJourney(PARAMS, { funded: "1", committed: 0b10, taken: 0b01 }, BEFORE).actors).toEqual(["backup.testnet"]);
  });

  test("past the effective deadline, anyone settles and the verdict is skipped", () => {
    const j = objectiveJourney(PARAMS, { funded: "1", committed: 0b11, deadline: "2027-03-15T00:00:00Z" }, AFTER);
    expect(j).toMatchObject({ current: "settle", actors: [], skipped: ["judge"] });
    // delivery extended the deadline past now: still the contributors' move
    expect(objectiveJourney(PARAMS, { funded: "1", committed: 0b11, deadline: "2027-05-01T00:00:00Z" }, AFTER).current).toBe("deliver");
  });

  test("resolved with payouts owed is still settling; with none, it is over", () => {
    expect(objectiveJourney(PARAMS, { outcome: "achieved", owed: { "contributor:0": "5" } }, BEFORE).current).toBe("settle");
    expect(objectiveJourney(PARAMS, { outcome: "achieved", in_flight: 1 }, BEFORE).current).toBe("settle");
    expect(objectiveJourney(PARAMS, { outcome: "achieved", owed: { "contributor:0": "0" } }, BEFORE).current).toBeUndefined();
    expect(objectiveJourney(PARAMS, { outcome: "accepted" }, BEFORE).skipped).toEqual(["judge"]);
    // the sponsor's own release: no verdict was needed, and the contributors are paid
    const released = objectiveJourney(PARAMS, { outcome: "released" }, BEFORE);
    expect(released.skipped).toEqual(["judge"]);
    expect(nextLine(released, false)).toBe("Settled: released, and every share is paid.");
  });
});

describe("the next line", () => {
  test("names whose move it is", () => {
    const j = objectiveJourney(PARAMS, { funded: "1" }, BEFORE);
    expect(nextLine(j, false)).toBe("Waiting for a.testnet and b.testnet to commit to the work.");
    expect(nextLine(j, true)).toBe("Your turn: commit to the work.");
    expect(nextLine(objectiveJourney(PARAMS, { funded: "1" }, AFTER), false)).toBe("Anyone can now close it and settle the escrow.");
  });

  test("says how it ended", () => {
    expect(nextLine(objectiveJourney(PARAMS, { outcome: "achieved" }, BEFORE), false)).toBe("Settled: achieved, and every share is paid.");
    expect(nextLine(objectiveJourney(PARAMS, { outcome: "expired" }, BEFORE), false)).toBe(
      "Settled: expired, and the sponsor is refunded.",
    );
  });
});

test("the workspace hands over to the contributors once launched", () => {
  expect(launchJourney("drafting", "s.testnet", []).current).toBe("draft");
  expect(launchJourney("ready", "s.testnet", []).actors).toEqual(["s.testnet"]);
  expect(launchJourney("launched", "s.testnet", ["a.testnet"])).toMatchObject({ current: "commit", actors: ["a.testnet"] });
});
