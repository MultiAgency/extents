/** The spec's checks against deliverables, with the network faked. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";

import { labelled, publicUrl, runCheck, type CheckDeps, type Deliverable } from "../src/server/checks.ts";
import { BudgetError } from "../src/server/budget.ts";
import { judgedText } from "../src/shared/judge.ts";
import type { Criterion, Spec } from "../src/shared/spec.ts";

const PAGES: Record<string, { body: string; type?: string; status?: number }> = {
  "https://lu.ma/nyc": { body: "<h1>NEAR builders meetup, New York</h1> 34 attendees" },
  "https://example.org/regs.csv": { body: "name\n...34 registered" },
  "https://example.org/1.jpg": { body: "jpg", type: "image/jpeg" },
  "https://example.org/2.jpg": { body: "jpg2", type: "image/jpeg" },
  "https://example.org/broken.jpg": { body: "nope", type: "text/html", status: 404 },
};
const fetched: string[] = [];
const deps: CheckDeps = {
  fetch: (async (input: URL | string) => {
    const url = String(input);
    fetched.push(url);
    const p = PAGES[url];
    if (!p) throw new Error("getaddrinfo ENOTFOUND");
    return new Response(p.body, { status: p.status ?? 200, headers: { "content-type": p.type ?? "text/html" } });
  }) as typeof fetch,
};

const REPORT: Deliverable = {
  text: `# Write-up

Event page: https://lu.ma/nyc
- Attendees: 34
**Average rating**: 87

## Agenda
Talks, then pizza. Sources: https://lu.ma/nyc and https://example.org/regs.csv

![](https://example.org/1.jpg) ![](https://example.org/2.jpg) ![](https://example.org/broken.jpg)

\`\`\`json
{ "count": 34 }
\`\`\`
`,
  files: { "writeup.md": "# Write-up", "data/attendance.csv": "" },
};

const crit = (check: Criterion["check"], id = "c"): Criterion => ({ id, description: "d", check });
const spec = (...criteria: Criterion[]): Spec => ({ v: 1, statement: "s", criteria });
const run = (check: Criterion["check"], d = REPORT, s?: Spec) => runCheck(crit(check), s ?? spec(crit(check)), d, deps);

describe("checks", () => {
  test("contains, and absent", async () => {
    expect((await run({ kind: "contains", phrase: "## agenda", absent: false })).outcome).toBe("pass");
    expect((await run({ kind: "contains", phrase: "lorem", absent: false })).outcome).toBe("fail");
    expect((await run({ kind: "contains", phrase: "lorem", absent: true })).outcome).toBe("pass");
  });

  test("labelled lines tolerate list markers and bold", () => {
    expect(labelled(REPORT.text, "attendees")).toBe("34");
    expect(labelled(REPORT.text, "Average rating")).toBe("87");
    expect(labelled("Attendees: 34\r\nVenue: Pier 17\r\n", "Venue")).toBe("Pier 17");
  });

  test("a label's value is on its own line, never the next one", () => {
    expect(labelled("Attendees:\nEvent page: https://lu.ma/nyc", "Attendees")).toBeUndefined();
    expect(labelled("Attendees:\n- Attendees: 34", "Attendees")).toBe("34");
  });

  test("labelled stays linear on long runs of spaces, at the report cap", () => {
    const text = `Attendees: 34${" ".repeat(199_000)}x`;
    const start = performance.now();
    expect(labelled(text, "Attendees")).toBe(`34${" ".repeat(199_000)}x`);
    expect(labelled("\n".repeat(200_000), "Attendees")).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(250);
  });

  test("a failing evidence archive is an error for the run, never an unreachable host", async () => {
    const archive = async () => {
      throw new Error("The private evidence archive is full; evaluation is paused");
    };
    const archived: CheckDeps = { ...deps, archive };
    // a page that loads fine: the archive is what fails, so the check must not report the page as unavailable
    for (const check of <Criterion["check"][]>[
      { kind: "live_url", label: "Event page", must_contain: "New York" },
      { kind: "sources", min: 1, figures: false },
    ]) {
      const c = crit(check);
      await expect(runCheck(c, spec(c), REPORT, archived)).rejects.toThrow(/archive is full/);
    }
    // an unreachable host is still the contributor's: unchanged
    const down = crit({ kind: "live_url", label: "Missing page" });
    const missing: Deliverable = { text: "Missing page: https://example.org/nowhere" };
    expect(await runCheck(down, spec(down), missing, archived)).toMatchObject({ outcome: "skipped", unavailable: true });
  });

  test("a spent service budget is an error for the run, never an unreachable host", async () => {
    // the evaluator's own ceiling, as evidenceFetch reports it: the contributor's page is never requested
    const spent: CheckDeps = {
      ...deps,
      fetch: (async () => {
        throw new BudgetError();
      }) as unknown as typeof fetch,
    };
    const checks: Criterion["check"][] = [
      { kind: "live_url", label: "Event page", must_contain: "New York" },
      { kind: "sources", min: 1, figures: false },
      { kind: "media", kinds: ["image"], min: 1 },
    ];
    for (const check of checks) {
      const c = crit(check);
      await expect(runCheck(c, spec(c), REPORT, spent)).rejects.toThrow(/Service budget reached/);
    }
    // any other failure to load is still the contributor's: unchanged
    const down = crit({ kind: "live_url", label: "Missing page" });
    const missing: Deliverable = { text: "Missing page: https://example.org/nowhere" };
    expect(await runCheck(down, spec(down), missing, deps)).toMatchObject({ outcome: "skipped", unavailable: true });
  });

  test("numeric_match within bounds", async () => {
    expect(await run({ kind: "numeric_match", label: "Attendees", min: 30 })).toMatchObject({ outcome: "pass", detail: "Attendees: 34" });
    expect(await run({ kind: "numeric_match", label: "Attendees", min: 40, max: 100 })).toMatchObject({
      outcome: "fail",
      detail: "Attendees: 34, needs at least 40 and at most 100",
    });
    expect((await run({ kind: "numeric_match", label: "Speakers", min: 1 })).outcome).toBe("fail");
  });

  test.each([
    ["30e-9", "fail"],
    ["3e1", "pass"],
    [".5", "fail"],
    ["+34", "pass"],
    ["34garbage", "fail"],
    ["30e", "fail"],
    ["Infinity", "fail"],
    ["1e999", "fail"],
  ])("numeric_match reads the complete value %s", async (value, outcome) => {
    expect((await run({ kind: "numeric_match", label: "Count", min: 30 }, { text: `Count: ${value}` })).outcome).toBe(outcome);
  });

  test("schema against a fenced JSON block", async () => {
    const schema = { type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 30 } } };
    expect((await run({ kind: "schema", json_schema: schema })).outcome).toBe("pass");
    expect(
      (await run({ kind: "schema", json_schema: { ...schema, properties: { count: { type: "integer", minimum: 50 } } } })).outcome,
    ).toBe("fail");
  });

  test("files must be delivered and non-empty", async () => {
    expect(await run({ kind: "files", paths: ["writeup.md", "data/attendance.csv"] })).toMatchObject({
      outcome: "fail",
      detail: "missing or empty: data/attendance.csv",
    });
    expect((await run({ kind: "files", paths: ["writeup.md"] })).outcome).toBe("pass");
  });

  test("live_url loads, shows the phrase, and records evidence", async () => {
    const r = await run({ kind: "live_url", label: "Event page", must_contain: "new york" });
    expect(r.outcome).toBe("pass");
    expect(r.evidence).toEqual([
      { url: "https://lu.ma/nyc", sha256: bytesToHex(sha256(new TextEncoder().encode(PAGES["https://lu.ma/nyc"]!.body))) },
    ]);
    expect((await run({ kind: "live_url", label: "Event page", must_contain: "Chicago" })).outcome).toBe("fail");
  });

  test("sources: enough load, and every figure appears on one", async () => {
    const attendees = crit({ kind: "numeric_match", label: "Attendees", min: 30 }, "n");
    const sources = crit({ kind: "sources", min: 2, figures: true });
    expect((await runCheck(sources, spec(attendees, sources), REPORT, deps)).outcome).toBe("pass");
    const rating = crit({ kind: "numeric_match", label: "Average rating", min: 0 }, "r");
    expect(await runCheck(sources, spec(attendees, rating, sources), REPORT, deps)).toMatchObject({
      outcome: "fail",
      detail: "not found on available cited pages: 87",
    });
  });

  test("sources: one page cited under several fragments counts once", async () => {
    const sources = crit({ kind: "sources", min: 2, figures: false });
    fetched.length = 0;
    const fragments = { text: "https://lu.ma/nyc#a https://lu.ma/nyc#b https://lu.ma/nyc" };
    const r = await runCheck(sources, spec(sources), fragments, deps);
    expect(r).toMatchObject({ outcome: "fail", detail: "1 of the needed 2 cited links load" });
    expect(r.evidence).toHaveLength(1);
    expect(fetched).toEqual(["https://lu.ma/nyc"]);
    const apart = { text: "https://lu.ma/nyc#a https://example.org/regs.csv#b" };
    expect((await runCheck(sources, spec(sources), apart, deps)).outcome).toBe("pass");
  });

  test("sources: the same bytes at two addresses count once", async () => {
    const sources = crit({ kind: "sources", min: 2, figures: false });
    const same: CheckDeps = { fetch: (async (_: URL | string) => new Response("same", { status: 200 })) as typeof fetch };
    const r = await runCheck(sources, spec(sources), { text: "https://a.example.org/x http://a.example.org/x" }, same);
    expect(r).toMatchObject({ outcome: "fail", detail: "1 of the needed 2 cited links load" });
  });

  test.each([
    ["3e1", "Only 3 people attended.", "fail"],
    ["30", "There were 130 attendees.", "fail"],
    ["30", "Attendance: 30.5", "fail"],
    ["30", "Attendance: 3e1", "pass"],
    ["3e1", "Attendance: 30", "pass"],
    ["1,000", "Attendance: 1000", "pass"],
    [".5", "Rating: 0.5", "pass"],
  ])("source figures compare complete numbers: %s in %s", async (value, page, outcome) => {
    const number = crit({ kind: "numeric_match", label: "Count", min: 0 }, "number");
    const sources = crit({ kind: "sources", min: 1, figures: true });
    const r = await runCheck(
      sources,
      spec(number, sources),
      { text: `Count: ${value}\nhttps://example.org/report` },
      {
        fetch: (async () => new Response(page)) as unknown as typeof fetch,
      },
    );
    expect(r.outcome).toBe(outcome);
  });

  test("media counts only what loads as that kind", async () => {
    expect(await run({ kind: "media", kinds: ["image"], min: 2 })).toMatchObject({ outcome: "pass", detail: "2 image items load" });
    expect((await run({ kind: "media", kinds: ["image"], min: 3 })).outcome).toBe("fail");
  });

  test("llm_judge is skipped without a judge, and asks one when given", async () => {
    expect((await run({ kind: "llm_judge", question: "Useful?", models: ["m"] })).outcome).toBe("skipped");
    const judged = await runCheck(crit({ kind: "llm_judge", question: "Useful?", models: ["m"] }), spec(), REPORT, {
      ...deps,
      judge: async () => ({ answer: true, detail: "it covers venue and agenda" }),
    });
    expect(judged).toMatchObject({ outcome: "pass", detail: "it covers venue and agenda" });
  });

  const call = (model: string, answer: boolean) => ({ model, answer, request_sha256: "1".repeat(64), response_sha256: "2".repeat(64) });

  test("llm_judge asks each of three models once and follows their majority, with every call", async () => {
    const asked: string[] = [];
    const judge = async (model: string) => (
      asked.push(model),
      { answer: model !== "c", detail: `${model} says`, call: call(model, model !== "c") }
    );
    const r = await runCheck(crit({ kind: "llm_judge", question: "Useful?", models: ["a", "b", "c"] }), spec(), REPORT, { ...deps, judge });
    expect(asked.sort()).toEqual(["a", "b", "c"]);
    expect(r.outcome).toBe("pass");
    expect(r.calls).toEqual(["a", "b", "c"].map((m) => ({ criterion_id: r.criterion_id, ...call(m, m !== "c") })));
  });

  test("llm_judge is skipped, keeping the calls it got, when any model fails", async () => {
    const judge = async (model: string) => {
      if (model === "b") throw new Error("model down");
      return { answer: true, detail: "yes", call: call(model, true) };
    };
    const r = await runCheck(crit({ kind: "llm_judge", question: "Useful?", models: ["a", "b", "c"] }), spec(), REPORT, { ...deps, judge });
    expect(r).toMatchObject({ outcome: "skipped", detail: "could not judge: model down" });
    expect(r.calls?.map((c) => c.model)).toEqual(["a", "c"]);
  });

  test("private addresses are refused before any request", async () => {
    for (const u of [
      "http://localhost/x",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest",
      "http://[::1]/",
      "http://intranet/",
      "file:///etc/passwd",
    ])
      expect(publicUrl(u), u).toBeUndefined();
    expect(publicUrl("https://lu.ma/nyc")?.href).toBe("https://lu.ma/nyc");
    fetched.length = 0;
    const r = await run({ kind: "live_url", label: "Event page" }, { text: "Event page: http://169.254.169.254/latest/meta-data" });
    expect(r).toMatchObject({ outcome: "fail" });
    expect(fetched).toEqual([]);
  });
});

test("a report over the spec's limit fails judged criteria without asking a model", async () => {
  let asked = 0;
  const c = { id: "u", description: "Useful", check: { kind: "llm_judge", question: "Useful?", models: ["m"] } } as never;
  const s = { v: 1, statement: "s", criteria: [c], max_report_bytes: 10 } as never;
  const r = await runCheck(
    c,
    s,
    { text: "x".repeat(11), oversized: ["organizer.testnet"] },
    {
      fetch,
      judge: async () => (asked++, { answer: true, detail: "fine" }),
    },
  );
  expect(r).toMatchObject({ outcome: "fail", detail: "over the spec's 10-byte report limit: organizer.testnet" });
  expect(asked).toBe(0);
});

// docs/spec.md, "A criterion holds for the deliverable as a whole"
describe("several reports, judged as one deliverable", () => {
  /** The deliverable the evaluator judges: every report, in the order given. */
  const joint = (...reports: [string, string][]): Deliverable => {
    const delivered = reports.map(([contributor, text]) => ({ contributor, text }));
    return { text: judgedText(delivered), reports: delivered };
  };
  const reversed = (d: Deliverable): Deliverable =>
    joint(...[...d.reports!].reverse().map((r): [string, string] => [r.contributor, r.text]));
  /** The result in the order given, after checking the reversed order gives the same outcome. */
  const both = async (check: Criterion["check"], d: Deliverable, s?: Spec) => {
    const [forward, backward] = [await run(check, d, s), await run(check, reversed(d), s)];
    expect(backward.outcome).toBe(forward.outcome);
    return forward;
  };

  test("contains holds across the joint text", async () => {
    const d = joint(["alice.near", "Nothing yet."], ["bob.near", "Tests passed: yes"]);
    expect((await both({ kind: "contains", phrase: "tests passed", absent: false }, d)).outcome).toBe("pass");
    expect((await both({ kind: "contains", phrase: "nothing yet", absent: true }, d)).outcome).toBe("fail");
  });

  test("numeric_match: every report that states the label must pass", async () => {
    const check = { kind: "numeric_match", label: "Attendees", min: 30 } as const;
    // agreeing; a report that doesn't state the label isn't counted
    const agreeing = joint(["alice.near", "Attendees: 34"], ["bob.near", "Attendees: 40"], ["carol.near", "Venue: Pier 17"]);
    expect(await both(check, agreeing)).toMatchObject({ outcome: "pass", detail: "alice.near: Attendees: 34; bob.near: Attendees: 40" });
    // conflicting: the unfavourable value is never outvoted, whichever report comes first
    const conflicting = joint(["alice.near", "Attendees: 50"], ["bob.near", "Attendees: 5"]);
    expect(await both(check, conflicting)).toMatchObject({ outcome: "fail", detail: "bob.near: Attendees: 5, needs at least 30" });
    expect(await both(check, joint(["alice.near", "Attendees: 50"], ["bob.near", "Attendees: lots"]))).toMatchObject({
      outcome: "fail",
      detail: 'bob.near: "Attendees: lots" is not a number',
    });
    // a label no report states still fails
    expect(await both(check, joint(["alice.near", "Venue: Pier 17"], ["bob.near", "Nothing yet."]))).toMatchObject({
      outcome: "fail",
      detail: 'no "Attendees: <number>" line',
    });
  });

  test("live_url: every report that states the label must pass", async () => {
    const check = { kind: "live_url", label: "Event page", must_contain: "New York" } as const;
    const page = "Event page: https://lu.ma/nyc";
    const agreeing = await both(check, joint(["alice.near", page], ["bob.near", page]));
    expect(agreeing.outcome).toBe("pass");
    expect(agreeing.evidence).toHaveLength(1);
    const conflicting = joint(["alice.near", "Event page: https://lu.ma/nyc"], ["bob.near", "Event page: https://example.org/regs.csv"]);
    expect(await both(check, conflicting)).toMatchObject({
      outcome: "fail",
      detail: 'bob.near: https://example.org/regs.csv loads but does not show "New York"',
    });
    expect(await both(check, joint(["alice.near", "Event page: https://lu.ma/nyc"], ["bob.near", "Event page: soon"]))).toMatchObject({
      outcome: "fail",
      detail: 'bob.near: no "Event page: <url>" line',
    });
    expect((await both(check, joint(["alice.near", "Nothing yet."], ["bob.near", "Event page: https://lu.ma/nyc"]))).outcome).toBe("pass");
    expect((await both(check, joint(["alice.near", "Nothing yet."], ["bob.near", "Nothing yet."]))).outcome).toBe("fail");
    // an unreachable host leaves it skipped only while nothing fails
    const down = joint(["alice.near", "Event page: https://lu.ma/nyc"], ["bob.near", "Event page: https://down.example.org/"]);
    expect(await both(check, down)).toMatchObject({ outcome: "skipped", unavailable: true });
  });

  test("schema: each report's JSON must pass; a report with none isn't counted", async () => {
    const json_schema = { type: "object", required: ["count"], properties: { count: { minimum: 30 } } };
    const check: Criterion["check"] = { kind: "schema", json_schema };
    const block = (count: number) => `Done.\n\`\`\`json\n{ "count": ${count} }\n\`\`\``;
    const agreeing = joint(["alice.near", block(34)], ["bob.near", '{ "count": 40 }'], ["carol.near", "No JSON here."]);
    expect((await both(check, agreeing)).outcome).toBe("pass");
    expect(await both(check, joint(["alice.near", block(34)], ["bob.near", block(5)]))).toMatchObject({
      outcome: "fail",
      detail: expect.stringMatching(/^bob\.near: the JSON is not valid: /),
    });
    expect(await both(check, joint(["alice.near", block(34)], ["bob.near", "Broken.\n```json\n{ count\n```"]))).toMatchObject({
      outcome: "fail",
      detail: "bob.near: the JSON block does not parse",
    });
    expect(await both(check, joint(["alice.near", "No JSON."], ["bob.near", "None here either."]))).toMatchObject({
      outcome: "fail",
      detail: "no JSON found in the deliverable",
    });
  });

  test("sources: the minimum is a total, and every report's figure must be on a cited page", async () => {
    const attendees = crit({ kind: "numeric_match", label: "Attendees", min: 30 }, "n");
    const sources = crit({ kind: "sources", min: 2, figures: true });
    const s = spec(attendees, sources);
    const agreeing = joint(["alice.near", "Attendees: 34\nhttps://lu.ma/nyc"], ["bob.near", "Attendees: 34\nhttps://example.org/regs.csv"]);
    expect(await both(sources.check, agreeing, s)).toMatchObject({ outcome: "pass", detail: "2 cited links load" });
    const conflicting = joint(
      ["alice.near", "Attendees: 34\nhttps://lu.ma/nyc"],
      ["bob.near", "Attendees: 90\nhttps://example.org/regs.csv"],
    );
    expect(await both(sources.check, conflicting, s)).toMatchObject({
      outcome: "fail",
      detail: "not found on available cited pages: bob.near: 90",
    });
  });

  test("which links fit the fetch cap never depends on report order", async () => {
    // twelve images, l.jpg down to a.jpg, split across two reports
    const urls = Array.from({ length: 12 }, (_, i) => `https://example.org/${String.fromCharCode(108 - i)}.jpg`);
    const asked: string[] = [];
    const any: CheckDeps = {
      fetch: (async (input: URL | string) => {
        asked.push(String(input));
        // a body of its own per link, so each counts as a page of its own
        return new Response(String(input), { headers: { "content-type": "image/jpeg" } });
      }) as typeof fetch,
    };
    const d = joint(["alice.near", urls.slice(0, 6).join("\n")], ["bob.near", urls.slice(6).join("\n")]);
    const fetchedFor = async (deliverable: Deliverable, check: Criterion["check"]) => {
      asked.length = 0;
      const r = await runCheck(crit(check), spec(crit(check)), deliverable, any);
      return { outcome: r.outcome, asked: [...asked].sort() };
    };
    for (const check of <Criterion["check"][]>[
      { kind: "sources", min: 10, figures: false },
      { kind: "media", kinds: ["image"], min: 10 },
    ]) {
      const forward = await fetchedFor(d, check);
      expect(forward).toEqual({ outcome: "pass", asked: [...urls].sort().slice(0, 10) });
      expect(await fetchedFor(reversed(d), check)).toEqual(forward);
    }
  });
});
