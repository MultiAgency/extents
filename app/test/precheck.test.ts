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
};

function client(
  documents: unknown,
  opts: { state?: unknown; delivered?: Delivered[]; judge?: CheckDeps["judge"]; archive?: CheckDeps["archive"]; path?: string } = {},
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
      fetch: (async () => new Response("<h1>Meetup in New York</h1>")) as never,
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
  // a real Params from the contract's vectors, with this spec as its terms
  const base = (params as unknown as { name: string; params: Params }[]).reduce((a, b) =>
    Object.keys(b.params.contributors).length > Object.keys(a.params.contributors).length ? b : a,
  ).params;
  const p: Params = { ...base, spec_hash: specHash(SPEC as never) };
  const [first, second] = contributorsInOrder(p).map(([a]) => a);
  const OBJECTIVE = "0s" + "ab".repeat(20);
  const REPORT = "Event page: https://lu.ma/nyc\nAttendees: 34";
  const CALL = { model: "m", request_sha256: "1".repeat(64), response_sha256: "2".repeat(64) };
  const evaluate = (state: unknown, delivered: Delivered[], yes = true) =>
    check(
      client(
        { params: p, spec: SPEC },
        {
          state,
          delivered,
          path: "/api/evaluate",
          judge: async () => ({ answer: yes, detail: "clear enough", call: { ...CALL, answer: yes } }),
        },
      ),
      { objective: OBJECTIVE },
    );

  test("judges what was delivered and returns a review that validates, with its model call", async () => {
    const r = await evaluate({ delivered: 1 }, [{ contributor: first!, text: REPORT, delivery_hash: reportHash(REPORT) }]);
    expect(r.error).toBeUndefined();
    expect(r.summary.summary).toEqual({ passed: 3, failed: 0, skipped: 0, verdict: "achieved" });
    const review = parseReview(r.summary.review, SPEC as never);
    expect(review).toMatchObject({ objective: OBJECTIVE, verdict: "achieved", deliverables: [{ contributor: first }] });
    expect(review.results.map((x) => x.criterion_id)).toEqual(["page", "attendance", "useful"]);
    expect(review.llm_calls).toEqual([{ ...CALL, answer: true, criterion_id: "useful" }]);
    expect(reviewHash(review)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a failed criterion makes a failed review", async () => {
    const r = await evaluate({ delivered: 1 }, [{ contributor: first!, text: REPORT, delivery_hash: reportHash(REPORT) }], false);
    expect(r.summary.review.verdict).toBe("failed");
  });

  test("results that support no verdict come back without a review", async () => {
    const r = await check(
      client(
        { params: p, spec: SPEC },
        {
          state: { delivered: 1 },
          delivered: [{ contributor: first!, text: REPORT, delivery_hash: reportHash(REPORT) }],
          path: "/api/evaluate",
          judge: async () => {
            throw new Error("model down");
          },
        },
      ),
      { objective: OBJECTIVE },
    );
    expect(r.summary.summary.verdict).toBe("undecided");
    expect(r.summary.review).toBeUndefined();
  });

  test("only reports from contributors whose delivery is on chain are judged", async () => {
    expect(second).toBeDefined();
    const r = await evaluate({ delivered: 1 }, [
      { contributor: first!, text: REPORT, delivery_hash: reportHash(REPORT) },
      { contributor: second!, text: "Attendees: 1" },
    ]);
    expect(r.summary.delivered.map((d: Delivered) => d.contributor)).toEqual([first]);
  });

  test("a missing or changed report cannot produce an achieved review", async () => {
    const partial = await evaluate({ delivered: 3 }, [{ contributor: first!, text: REPORT, delivery_hash: reportHash(REPORT) }]);
    expect(partial.error).toMatch(/Every recorded delivery/);
    expect(partial.summary).toBeUndefined();
    const changed = await evaluate({ delivered: 1 }, [{ contributor: first!, text: REPORT, delivery_hash: "0".repeat(64) }]);
    expect(changed.error).toMatch(/Every recorded delivery/);
  });

  test("nothing delivered is refused", async () => {
    expect((await evaluate({ delivered: 0 }, [])).error).toMatch(/Nobody has delivered/);
    expect((await evaluate({ delivered: 1 }, [])).error).toMatch(/Every recorded delivery needs its exact report/);
  });
});
