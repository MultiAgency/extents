/** The spec's checks against deliverables, with the network faked. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";

import { labelled, publicUrl, runCheck, type CheckDeps, type Deliverable } from "../src/server/checks.ts";
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
