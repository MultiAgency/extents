import { describe, expect, test } from "vitest";
import { assertFundingMayStart, readLaunch, writeLaunch } from "../src/web/launch-store.ts";
import { deliveryHash, holders, openToContributors, verifyReports } from "../src/shared/delivery.ts";
import { reportHash } from "../src/shared/review.ts";
import { Budget } from "../src/server/budget.ts";
import { publicAddress, publicUrl, evidenceFetch } from "../src/server/evidence-fetch.ts";
import { runCheck } from "../src/server/checks.ts";
import { validateAppSpec, type Criterion, type Spec } from "../src/shared/spec.ts";
import type { Params } from "../src/shared/params.ts";

const record = { salt: "ab".repeat(32), done: {} };
const criterion = (check: Criterion["check"]): Criterion => ({ id: "c", description: "Check", check });
const spec = (c: Criterion): Spec => ({ v: 1, statement: "Work", criteria: [c] });

describe("funding recovery", () => {
  test("absence after any amount of waiting never authorizes a replacement", () => {
    expect(() => assertFundingMayStart({ ...record, fundAttemptAt: "2000-01-01T00:00:00Z" }, false)).toThrow(/unresolved/);
    expect(() => assertFundingMayStart({ ...record, done: { fund: "TX" } }, false)).toThrow(/unresolved/);
    expect(() => assertFundingMayStart({ ...record, fundTx: "TX" }, false)).toThrow(/unresolved/);
    expect(() => assertFundingMayStart(record, false)).not.toThrow();
    expect(() => assertFundingMayStart({ ...record, fundAttemptAt: "old" }, true)).not.toThrow();
  });
  test("unavailable or corrupt storage cannot silently create a fresh launch", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => "not JSON",
        setItem: () => {
          throw new Error("quota");
        },
      },
    });
    expect(() => readLaunch("key")).toThrow();
    expect(() => writeLaunch("key", record)).toThrow(/quota/);
    delete (globalThis as any).localStorage;
  });
});

describe("delivery provenance", () => {
  const contributor = "backup.testnet",
    objective = "objective.testnet",
    hash = reportHash("report");
  const event = `EVENT_JSON:${JSON.stringify({ standard: "extents-objective", event: "delivered", data: { contributor, hash } })}`;
  const outcome = (executor_id: string, status: unknown) => ({ receipts_outcome: [{ outcome: { executor_id, status, logs: [event] } }] });
  test("only the objective's successful receipt establishes a delivery", () => {
    expect(deliveryHash(outcome(objective, { SuccessValue: "" }), objective, contributor)).toBe(hash);
    expect(deliveryHash(outcome("attacker.testnet", { SuccessValue: "" }), objective, contributor)).toBeUndefined();
    for (const metadata of [{}, { final_execution_status: "FINAL", status: { Failure: {} } }])
      expect(
        deliveryHash({ ...outcome(objective, { Failure: {} }), ...metadata }, objective, contributor),
        JSON.stringify(metadata),
      ).toBeUndefined();
  });
  test("backups hold slots; a judged report must be its slot's exact on-chain delivery, once", () => {
    const params = { contributors: { "original.testnet": 1_000_000 }, backups: { "original.testnet": contributor } } as unknown as Params;
    expect(holders(params, 1)).toEqual([contributor]);
    const report = { contributor, text: "report", delivery_hash: hash };
    expect(() => verifyReports([contributor], [report])).not.toThrow();
    // a slot without a report is the review's `missing`, not an error here
    expect(() => verifyReports([contributor, "missing.testnet"], [report])).not.toThrow();
    expect(() => verifyReports(["other.testnet"], [report])).toThrow();
    expect(() => verifyReports([contributor], [{ ...report, text: "replacement" }])).toThrow();
    expect(() => verifyReports([contributor, "other.testnet"], [report, report])).toThrow();
  });
  // docs/spec.md, "A contributor commits before the deadline"; docs/spec.md, "A holder may withdraw until it delivers"; docs/spec.md, "A delivery is final"
  test("contributors act until the original deadline or a verdict", () => {
    const params = { deadline: "2027-03-01T00:00:00Z" } as Params;
    const deadline = Date.parse(params.deadline);
    expect(openToContributors(params, undefined, deadline)).toBe(true);
    expect(openToContributors(params, {}, deadline + 1)).toBe(false);
    expect(openToContributors(params, { outcome: "failed" }, deadline - 1)).toBe(false);
  });
});

describe("evidence and service budgets", () => {
  test("private addresses, mapped IPv4 and alternate ports are refused", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "100.64.0.1", "::ffff:127.0.0.1", "::1", "fd00::1"])
      expect(publicAddress(address), address).toBe(false);
    expect(publicUrl("http://[::ffff:127.0.0.1]/")).toBeUndefined();
    expect(publicUrl("http://example.org:8080/")).toBeUndefined();
    await expect(evidenceFetch("http://127.0.0.1/")).rejects.toThrow(/not public/);
  });
  test("network failure and server errors are unavailable, while a real 404 fails", async () => {
    const c = criterion({ kind: "live_url", label: "Page" });
    const d = { text: "Page: https://example.org/evidence" };
    expect(
      (
        await runCheck(c, spec(c), d, {
          fetch: (async () => {
            throw new Error("timeout");
          }) as unknown as typeof fetch,
        })
      ).outcome,
    ).toBe("skipped");
    for (const status of [429, 500, 503])
      expect(
        (await runCheck(c, spec(c), d, { fetch: (async () => new Response("", { status })) as unknown as typeof fetch })).outcome,
      ).toBe("skipped");
    expect(
      (await runCheck(c, spec(c), d, { fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch })).outcome,
    ).toBe("fail");
  });
  test("oversized streamed bodies are cancelled and never produce a verdict", async () => {
    let cancelled = false;
    const c = criterion({ kind: "live_url", label: "Page" });
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const r = await runCheck(
      c,
      spec(c),
      { text: "Page: https://example.org/" },
      { fetch: (async () => response) as unknown as typeof fetch },
    );
    expect(r.outcome).toBe("skipped");
    expect(cancelled).toBe(true);
  });
  test("unsupported file delivery is refused at launch and unavailable during legacy evaluation", async () => {
    const c = criterion({ kind: "files", paths: ["report.md"] });
    expect(() => validateAppSpec(spec(c))).toThrow(/does not support file delivery/);
    expect((await runCheck(c, spec(c), { text: "report.md" }, { fetch })).outcome).toBe("skipped");
  });
  test("concurrency is released once, and hourly use remains bounded", () => {
    let now = 100;
    const budget = new Budget(2, 1, 1000, () => now);
    const release = budget.acquire();
    expect(() => budget.acquire()).toThrow();
    release();
    release();
    budget.acquire()();
    expect(() => budget.acquire()).toThrow();
    now = 1100;
    expect(() => budget.acquire()()).not.toThrow();
  });
});
