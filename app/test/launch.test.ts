/** The launch's money-safety pieces: its identity, and how a funding transaction is read. */
import { describe, expect, test } from "vitest";

import { finalOutcome } from "../src/web/transaction-outcome.ts";
import { classifyFund } from "../src/shared/fund-outcome.ts";
import { buildObjective, launchKey, proposal } from "../src/shared/objective.ts";
import { validateSpec } from "../src/shared/spec.ts";
import { timestampNanos, validateParams, type Params } from "../src/shared/params.ts";

const P = proposal.parse({
  spec: {
    v: 1,
    statement: "A meetup.",
    criteria: [{ id: "n", description: "Attendance", check: { kind: "numeric_match", label: "Attendees", min: 30 } }],
  },
  contributors: { "organizer.testnet": 100 },
  evaluator: "agency.testnet",
  deadline: "2027-03-01T00:00:00Z",
  amount: "5",
});

describe("launchKey", () => {
  test("the same terms, sponsor and code are the same launch", () => {
    expect(launchKey(proposal.parse(structuredClone(P)), "a.testnet", "H")).toBe(launchKey(P, "a.testnet", "H"));
  });
  test("any difference is a different launch", () => {
    const base = launchKey(P, "a.testnet", "H");
    expect(launchKey({ ...P, amount: "6" }, "a.testnet", "H")).not.toBe(base);
    expect(launchKey(P, "b.testnet", "H")).not.toBe(base);
    expect(launchKey(P, "a.testnet", "H2")).not.toBe(base);
  });
});

const receipt = (executor_id: string, logs: string[] = [], status: unknown = { SuccessValue: "" }) => ({
  outcome: { executor_id, logs, status },
});
const FUNDED = 'EVENT_JSON:{"standard":"extents-objective","version":"0.1.0","event":"funded","data":{}}';

describe("classifyFund", () => {
  test("the objective's funded event", () => {
    expect(classifyFund({ receipts_outcome: [receipt("verifier"), receipt("0sobj", [FUNDED]), receipt("verifier")] }, "0sobj")).toEqual({
      kind: "funded",
    });
  });
  test("the objective ran without accepting", () => {
    expect(classifyFund({ receipts_outcome: [receipt("verifier"), receipt("0sobj")] }, "0sobj")).toMatchObject({ kind: "refused" });
  });
  test("the objective failed", () => {
    const r = classifyFund({ receipts_outcome: [receipt("0sobj", [], { Failure: { ActionError: { kind: "x" } } })] }, "0sobj");
    expect(r).toMatchObject({ kind: "refused", reason: expect.stringContaining("ActionError") });
  });
  test("an event from another contract does not count", () => {
    expect(classifyFund({ receipts_outcome: [receipt("other", [FUNDED]), receipt("0sobj")] }, "0sobj")).toMatchObject({ kind: "refused" });
  });
  test("logs from a failed receipt do not prove successful funding, even when final", () => {
    for (const metadata of [{}, { final_execution_status: "FINAL", status: { Failure: {} } }]) {
      const reverted = {
        ...metadata,
        receipts_outcome: [receipt("0sobj", [FUNDED], { Failure: { OutOfGas: {} } })],
      };
      expect(classifyFund(reverted, "0sobj"), JSON.stringify(metadata)).toMatchObject({ kind: "refused" });
    }
    expect(classifyFund({ status: { Failure: {} } }, "0sobj")).toMatchObject({ kind: "unknown" });
    expect(classifyFund({ final_execution_status: "FINAL", status: { Failure: {} } }, "0sobj")).toMatchObject({ kind: "refused" });
  });
  test("a failed downstream resolver cannot erase successful funding", () => {
    expect(
      classifyFund({ final_execution_status: "FINAL", status: { Failure: {} }, receipts_outcome: [receipt("0sobj", [FUNDED])] }, "0sobj"),
    ).toEqual({ kind: "funded" });
  });
  test("no receipt from the objective is unknown, never refused", () => {
    expect(classifyFund({ receipts_outcome: [receipt("verifier")] }, "0sobj")).toEqual({ kind: "unknown" });
    expect(classifyFund({}, "0sobj")).toEqual({ kind: "unknown" });
  });
});

test("final receipt reconciliation preserves a successful deposit even if the SDK would throw on the final status", async () => {
  const result = {
    final_execution_status: "FINAL",
    transaction: { hash: "TX", signer_id: "sponsor.testnet" },
    status: { Failure: {} },
    receipts_outcome: [receipt("objective.testnet", [FUNDED])],
  };
  const send = (async (_url: unknown, init: RequestInit) => {
    expect(JSON.parse(init.body as string).params.wait_until).toBe("FINAL");
    return Response.json({ result });
  }) as unknown as typeof fetch;
  expect(classifyFund(await finalOutcome("TX", "sponsor.testnet", send), "objective.testnet")).toEqual({ kind: "funded" });
  await expect(finalOutcome("DIFFERENT", "sponsor.testnet", send)).rejects.toThrow(/not finalized/);
});

describe("buildObjective deadline", () => {
  const build = (deadline: string) => () =>
    buildObjective(
      proposal.parse({ ...P, deadline }),
      "customer.testnet",
      "ab".repeat(32),
      "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa",
      Date.parse("2026-11-20T00:00:00Z"),
    );

  test.each([
    "2027-02-30T00:00:00Z",
    "2027-04-31T12:00:00Z",
    "2027-02-29T00:00:00Z",
    "2027-01-15T24:00:00Z",
    "2027-01-15T18:00:00+00:00",
    "2027-01-15T18:00:00.5Z",
  ])("refuses %s", (d) => expect(build(d)).toThrow(/RFC 3339 UTC to the second/));

  test.each(["2027-01-15T18:00:00Z", "2028-02-29T00:00:00Z", "2027-12-31T23:59:59Z"])("accepts %s", (d) =>
    expect(build(d)().params.deadline).toBe(d),
  );
});

describe("raw Params, as deploy and the agent API receive them", () => {
  const params = (deadline: string, commit_by?: string) =>
    ({
      sponsor: "customer.testnet",
      token: "nep245:verifier.tidepool-sandbox.testnet:nep141:usdc.tidepool-sandbox.testnet",
      evaluator: "agency.testnet",
      contributors: { "organizer.testnet": 1_000_000 },
      deadline,
      ...(commit_by ? { commit_by, backups: { "organizer.testnet": "backup.testnet" } } : {}),
      spec_hash: "00".repeat(32),
      salt: "11".repeat(32),
    }) as never;

  test.each(["2027-02-30T00:00:00Z", "2027-02-28T25:00:00Z", "2027-02-28T10:00:00+24:00", "2027-02-30T00:00:00.5+02:00"])(
    "refuses impossible deadline %s",
    (d) => expect(validateParams(params(d))).toMatch(/deadline is not a real/),
  );

  test("refuses an impossible commit_by", () =>
    expect(validateParams(params("2027-03-01T00:00:00Z", "2027-02-29T00:00:00Z"))).toMatch(/commit_by is not a real/));

  test.each(["2027-03-01T00:00:00Z", "2027-03-01T00:00:00.123456789+05:30", "2028-02-29T23:59:59-08:00"])("accepts %s", (d) =>
    expect(validateParams(params(d))).toBeUndefined(),
  );

  test("the parser never rolls a date over", () => expect(() => timestampNanos("2027-02-30T00:00:00+01:00")).toThrow(/not a date/));
});

describe("auth_caller", () => {
  const p = {
    sponsor: "customer.testnet",
    token: "nep245:verifier.tidepool-sandbox.testnet:nep141:usdc.tidepool-sandbox.testnet",
    evaluator: "agency.testnet",
    contributors: { "organizer.testnet": 1_000_000 },
    deadline: "2027-03-01T00:00:00Z",
    spec_hash: "00".repeat(32),
    salt: "11".repeat(32),
  } as never as Params;

  // a sponsor who names itself could call on_auth as any role, e.g. attest failed as the evaluator and take the funds back
  test.each(["customer.testnet", "agency.testnet", "intents.near"])("refuses %s, which isn't the token's Verifier", (caller) =>
    expect(validateParams({ ...p, auth_caller: caller })).toBe("auth_caller must be the token's Verifier"),
  );

  test("accepts the token's Verifier, or none", () => {
    expect(validateParams({ ...p, auth_caller: "verifier.tidepool-sandbox.testnet" })).toBeUndefined();
    expect(validateParams(p)).toBeUndefined();
  });
});

describe("deadline range", () => {
  const p = {
    sponsor: "customer.testnet",
    token: "nep245:verifier.tidepool-sandbox.testnet:nep141:usdc.tidepool-sandbox.testnet",
    evaluator: "agency.testnet",
    contributors: { "organizer.testnet": 1_000_000 },
    spec_hash: "00".repeat(32),
    salt: "11".repeat(32),
  } as never as Params;

  // i64 nanoseconds end at 2262-04-11T23:47:16.854775807Z and start at 1677-09-21T00:12:43.145224192Z
  test.each(["2262-04-11T23:47:17Z", "2300-01-01T00:00:00Z", "1677-09-21T00:12:43Z", "1600-01-01T00:00:00Z"])("refuses %s", (deadline) =>
    expect(validateParams({ ...p, deadline })).toMatch(/outside the time range/),
  );

  test.each(["2262-04-11T23:47:16Z", "2262-04-11T23:47:16.854775807Z", "1677-09-21T00:12:43.145224192Z"])(
    "accepts the edge %s",
    (deadline) => expect(validateParams({ ...p, deadline })).toBeUndefined(),
  );
});

describe("max_report_bytes against the judge's input", () => {
  const judged = (max_report_bytes: number, contributors: Record<string, number>) =>
    proposal.parse({
      spec: {
        v: 1,
        statement: "A meetup.",
        criteria: [
          { id: "n", description: "Attendance", check: { kind: "numeric_match", label: "Attendees", min: 30 } },
          { id: "u", description: "Useful", check: { kind: "llm_judge", question: "Useful?", models: ["m"] } },
        ],
        max_report_bytes,
      },
      contributors,
      evaluator: "agency.testnet",
      deadline: "2027-03-01T00:00:00Z",
      amount: "5",
    });
  const build = (p: ReturnType<typeof judged>) => () =>
    buildObjective(
      p,
      "customer.testnet",
      "ab".repeat(32),
      "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa",
      Date.parse("2026-11-20T00:00:00Z"),
    );
  const four = { "a.testnet": 25, "b.testnet": 25, "c.testnet": 25, "d.testnet": 25 };

  test("refuses a limit whose reports can't all fit one judgement, and names the largest that can", () =>
    expect(build(judged(20_000, four))).toThrow(/use at most 9929/));

  test("accepts the largest limit that fits, and a single contributor up to the whole input", () => {
    expect(build(judged(9_929, four))).not.toThrow();
    expect(build(judged(40_000, { "a.testnet": 100 }))).not.toThrow();
  });

  test("a judged spec without a limit is refused by the format itself", () =>
    expect(() => validateSpec({ ...judged(8_000, four).spec, max_report_bytes: undefined })).toThrow(/needs a positive max_report_bytes/));
});
