/** Checking a deliverable live, through AG-UI's own client against the app. */
import { HttpAgent } from "@ag-ui/client";
import { describe, expect, test, vi } from "vitest";

import { createApp } from "../src/server/app.ts";
import type { CheckDeps } from "../src/server/checks.ts";
import type { Chain } from "../src/server/tools.ts";
import { reportHash } from "../src/shared/review.ts";
import type { Delivered } from "../src/shared/review.ts";
import { contributorsInOrder, type Params } from "../src/shared/params.ts";
import { parseReview, reviewHash, specHash } from "../src/shared/spec.ts";
import params from "../../contracts/objective/tests/vectors/params.json" with { type: "json" };

const SPEC = {
  v: 1,
  statement: "A NEAR builders meetup in NYC.",
  criteria: [
    { id: "page", description: "Public event page", check: { kind: "live_url", label: "Event page", must_contain: "New York" } },
    { id: "attendance", description: "At least 30 attendees", check: { kind: "numeric_match", label: "Attendees", min: 30 } },
    {
      id: "useful",
      description: "Someone else could run it",
      check: { kind: "llm_judge", question: "Could someone else run it?", models: ["m"] },
    },
  ],
  max_report_bytes: 20_000,
};

function client(
  documents: unknown,
  opts: {
    state?: unknown;
    delivered?: Delivered[];
    judge?: CheckDeps["judge"];
    archive?: CheckDeps["archive"];
    fetch?: typeof fetch;
    path?: string;
  } = {},
) {
  const chain: Chain = {
    accountExists: async () => true,
    verifierBalance: async () => 0n,
    describeObjective: async () => ({ deployed: true, ...(opts.state ? { state: opts.state } : {}), ...(documents ? { documents } : {}) }),
  };
  const app = createApp({
    model: { name: "unused", stream: () => (async function* () {})() },
    chain,
    deploy: async () => ({ accountId: "x" }),
    checks: {
      archive: opts.archive,
      fetch: opts.fetch ?? ((async () => new Response("<h1>Meetup in New York</h1>")) as never),
      judge: opts.judge ?? (async () => ({ answer: false, detail: "no venue or costs" })),
    },
    delivered: async (_, contributors) => (opts.delivered ?? []).filter((d) => contributors.includes(d.contributor)),
  });
  return new HttpAgent({
    url: `http://test${opts.path ?? "/api/check"}`,
    fetch: ((u: string, i: RequestInit) => app.fetch(new Request(u, i))) as never,
  });
}

async function check(agent: HttpAgent, forwardedProps: unknown) {
  const results: Record<string, { outcome: string; detail: string }> = {};
  let started = 0;
  let summary: any;
  let error: string | undefined;
  await agent.runAgent(
    { forwardedProps },
    {
      onToolCallStartEvent: () => void started++,
      onToolCallResultEvent: ({ event }) => {
        const r = JSON.parse(event.content as string);
        results[r.criterion_id] = r;
      },
      onRunFinishedEvent: ({ event }) => void (summary = (event as { result?: unknown }).result),
      onRunErrorEvent: ({ event }) => void (error = event.message),
    },
  );
  return { results, started, summary, error };
}

describe("/api/check", () => {
  test("draft evidence and judge calls cannot fill the evaluation archive", async () => {
    let archived = 0;
    const agent = client(
      { spec: SPEC },
      {
        archive: async () => {
          archived++;
          throw new Error("archive full");
        },
        judge: async (_model, _question, _deliverable, _signal, archive) => {
          expect(archive).toBeUndefined();
          await archive?.(new Uint8Array());
          return { answer: true, detail: "yes" };
        },
      },
    );
    const r = await check(agent, { objective: "0sobj", deliverable: { text: "Event page: https://lu.ma/nyc\nAttendees: 34" } });
    expect(r.error).toBeUndefined();
    expect(r.summary.verdict).toBe("achieved");
    expect(archived).toBe(0);
  });
  test("every criterion starts, resolves, and the run sums them up", async () => {
    const r = await check(client({ spec: SPEC }), {
      objective: "0sobj",
      deliverable: { text: "Event page: https://lu.ma/nyc\nAttendees: 34" },
    });
    expect(r.error).toBeUndefined();
    expect(r.started).toBe(3);
    expect(r.results.page?.outcome).toBe("pass");
    expect(r.results.attendance).toMatchObject({ outcome: "pass", detail: "Attendees: 34" });
    expect(r.results.useful).toMatchObject({ outcome: "fail", detail: "no venue or costs" });
    expect(r.summary).toEqual({ passed: 2, failed: 1, skipped: 0, verdict: "failed" });
  });

  test("criteria share fetched evidence within a run, while later runs fetch fresh bytes", async () => {
    const { runChecks } = await import("../src/server/precheck.ts");
    const fetch = vi.fn(async () => new Response("New York"));
    const spec = { ...SPEC, criteria: [SPEC.criteria[0]!, { ...SPEC.criteria[0]!, id: "same-page" }] };
    const input = {
      threadId: "t",
      runId: "r",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: { objective: "objective.testnet", deliverable: { text: "Event page: https://example.org/" } },
    };
    const deps = {
      chain: {
        accountExists: async () => true,
        verifierBalance: async () => 0n,
        describeObjective: async () => ({ deployed: true, documents: { spec } }),
      },
      checks: { fetch: fetch as unknown as typeof globalThis.fetch },
      delivered: async () => [],
    };
    for await (const _ of runChecks(input, deps)) {
      /* consume the first run */
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    for await (const _ of runChecks(input, deps)) {
      /* consume a fresh run */
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("an objective without published terms is refused", async () => {
    expect((await check(client(undefined), { objective: "0sobj", deliverable: { text: "x" } })).error).toMatch(/no published terms/);
  });

  test("a malformed request is refused", async () => {
    expect((await check(client({ spec: SPEC }), { objective: "0sobj" })).error).toMatch(/objective and a deliverable/);
  });
});

describe("/api/evaluate", () => {
  // a real two-contributor Params from the contract's vectors, with this spec as its terms
  const base = (params as unknown as { name: string; params: Params }[]).find(
    (c) => Object.keys(c.params.contributors).length === 2 && !c.params.backups,
  )!.params;
  const p: Params = { ...base, spec_hash: specHash(SPEC as never) };
  const [first, second] = contributorsInOrder(p).map(([a]) => a) as [string, string];
  const OBJECTIVE = "0s" + "ab".repeat(20);
  const REPORT = "Event page: https://lu.ma/nyc\nAttendees: 34";
  const report = (contributor: string, text = REPORT): Delivered => ({ contributor, text, delivery_hash: reportHash(text) });
  const BOTH = [report(first), report(second)];
  const CALL = { model: "m", request_sha256: "1".repeat(64), response_sha256: "2".repeat(64) };
  const evaluate = (
    state: unknown,
    delivered: Delivered[],
    opts: { yes?: boolean; judge?: CheckDeps["judge"]; fetch?: typeof fetch } = {},
  ) =>
    check(
      client(
        { params: p, spec: SPEC },
        {
          state,
          delivered,
          path: "/api/evaluate",
          judge:
            opts.judge ?? (async () => ({ answer: opts.yes ?? true, detail: "clear enough", call: { ...CALL, answer: opts.yes ?? true } })),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        },
      ),
      { objective: OBJECTIVE },
    );

  test("judges every slot's delivered report and returns an achieved review that validates, with its model call", async () => {
    const r = await evaluate({ delivered: 3 }, BOTH);
    expect(r.error).toBeUndefined();
    expect(r.summary.summary).toEqual({ passed: 3, failed: 0, skipped: 0, verdict: "achieved" });
    const review = parseReview(r.summary.review, SPEC as never);
    expect(review).toMatchObject({
      objective: OBJECTIVE,
      verdict: "achieved",
      deliverables: [{ contributor: first }, { contributor: second }],
    });
    expect(review.missing).toBeUndefined();
    expect(review.results.map((x) => x.criterion_id)).toEqual(["page", "attendance", "useful"]);
    expect(review.llm_calls).toEqual([{ ...CALL, answer: true, criterion_id: "useful" }]);
    expect(reviewHash(review)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a failed criterion makes a failed review", async () => {
    const r = await evaluate({ delivered: 3 }, BOTH, { yes: false });
    expect(r.summary.review.verdict).toBe("failed");
  });

  test("results that support no verdict come back without a review", async () => {
    const r = await evaluate({ delivered: 3 }, BOTH, {
      judge: async () => {
        throw new Error("model down");
      },
    });
    expect(r.summary.summary.verdict).toBe("undecided");
    expect(r.summary.review).toBeUndefined();
  });

  test("a slot not delivered on chain is missing, even if a report was published for it", async () => {
    const r = await evaluate({ delivered: 1 }, BOTH);
    expect(r.summary.delivered.map((d: Delivered) => d.contributor)).toEqual([first]);
    expect(r.summary.missing).toEqual([second]);
    expect(parseReview(r.summary.review, SPEC as never)).toMatchObject({ verdict: "failed", missing: [second] });
  });

  test("a delivered slot with no published report is missing, and makes the review failed, never achieved", async () => {
    const r = await evaluate({ delivered: 3 }, [report(first)]);
    expect(r.summary.summary.verdict).toBe("achieved"); // the checks alone would pass
    expect(parseReview(r.summary.review, SPEC as never)).toMatchObject({ verdict: "failed", missing: [second] });
  });

  test("a delivered report over the spec's limit fails the judged criterion with a review the evaluator can attest", async () => {
    let asked = 0;
    const long = report(second, `${REPORT}\n${"x".repeat(SPEC.max_report_bytes)}`);
    const r = await evaluate({ delivered: 3 }, [report(first), long], { judge: async () => (asked++, { answer: true, detail: "x" }) });
    expect(r.error).toBeUndefined();
    expect(asked).toBe(0);
    expect(r.results.useful).toMatchObject({ outcome: "fail" });
    expect(parseReview(r.summary.review, SPEC as never)).toMatchObject({ verdict: "failed" });
  });

  test("with nothing delivered, no model is asked and the review fails on the missing reports", async () => {
    let asked = 0;
    const r = await evaluate({ delivered: 0 }, [], { judge: async () => (asked++, { answer: true, detail: "x" }) });
    expect(asked).toBe(0);
    expect(parseReview(r.summary.review, SPEC as never)).toMatchObject({ verdict: "failed", deliverables: [], missing: [first, second] });
  });

  test("a report that isn't its delivery's exact text stops the run", async () => {
    const changed = await evaluate({ delivered: 1 }, [{ ...report(first), delivery_hash: "0".repeat(64) }]);
    expect(changed.error).toMatch(/exact one its on-chain delivery committed/);
  });

  test("a contributor's unreachable host is recorded first, then fails once it outlasts the retry window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
      const down = (async () => new Response("unavailable", { status: 503 })) as never;
      const agent = client(
        { params: p, spec: SPEC },
        {
          state: { delivered: 3 },
          delivered: BOTH,
          path: "/api/evaluate",
          fetch: down,
          judge: async () => ({ answer: true, detail: "x", call: { ...CALL, answer: true } }),
        },
      );
      const firstRun = await check(agent, { objective: OBJECTIVE });
      expect(firstRun.results.page).toMatchObject({ outcome: "skipped" });
      expect(firstRun.results.page!.detail).toMatch(/Recorded/);
      expect(firstRun.summary.review).toBeUndefined();

      vi.setSystemTime(new Date("2026-11-20T10:05:00Z"));
      expect((await check(agent, { objective: OBJECTIVE })).results.page).toMatchObject({ outcome: "skipped" });

      vi.setSystemTime(new Date("2026-11-20T10:11:00Z"));
      const later = await check(agent, { objective: OBJECTIVE });
      expect(later.results.page).toMatchObject({ outcome: "fail" });
      expect(later.results.page!.detail).toMatch(/still unreachable 11 minutes/);
      expect(parseReview(later.summary.review, SPEC as never).verdict).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });
});
