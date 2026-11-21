/** Replaying a real evaluation from the archive it left behind. */
import { HttpAgent } from "@ag-ui/client";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createApp } from "../src/server/app.ts";
import { evidenceArchive } from "../src/server/archive.ts";
import { nearAiJudge } from "../src/server/judge.ts";
import { formatReplay, replay } from "../src/server/replay.ts";
import type { Chain } from "../src/server/tools.ts";
import { canonicalize } from "../src/shared/jcs.ts";
import { judgedText, judgeRequest } from "../src/shared/judge.ts";
import { contributorsInOrder, type Params } from "../src/shared/params.ts";
import { reportHash } from "../src/shared/review.ts";
import { parseReview, reviewHash, specHash } from "../src/shared/spec.ts";
import params from "../../contracts/objective/tests/vectors/params.json" with { type: "json" };

const SPEC = {
  v: 1,
  statement: "A NEAR builders meetup in NYC.",
  criteria: [
    { id: "page", description: "Public event page", check: { kind: "live_url", label: "Event page", must_contain: "New York" } },
    { id: "attendance", description: "At least 30 attendees", check: { kind: "numeric_match", label: "Attendees", min: 30 } },
    { id: "useful", description: "Someone else could run it", check: { kind: "llm_judge", question: "Could someone else run it?", models: ["m"] } },
  ],
  max_report_bytes: 20_000,
};
const base = (params as unknown as { name: string; params: Params }[]).find((c) => Object.keys(c.params.contributors).length === 2 && !c.params.backups)!.params;
const p: Params = { ...base, spec_hash: specHash(SPEC as never) };
const [first, second] = contributorsInOrder(p).map(([a]) => a) as [string, string];
const OBJECTIVE = "0s" + "ab".repeat(20);
const REPORT = "Event page: https://lu.ma/nyc\nAttendees: 34";
const BOTH = [first, second].map((contributor) => ({ contributor, text: REPORT, delivery_hash: reportHash(REPORT) }));

// a NEAR AI stand-in that signs what it served
const key = ed25519.utils.randomSecretKey();
const address = bytesToHex(ed25519.getPublicKey(key));
const hex = (b: string) => bytesToHex(sha256(new TextEncoder().encode(b)));
function cloud() {
  let served: { request: string; response: string } | undefined;
  return (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/chat/completions")) {
      const response = JSON.stringify({ id: "chat-1", choices: [{ finish_reason: "stop", message: { content: "Yes\nIt names a venue and an agenda." } }] });
      served = { request: init!.body as string, response };
      return new Response(response);
    }
    const text = `m:${hex(served!.request)}:${hex(served!.response)}`;
    return Response.json({ text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), key)), signing_address: address });
  }) as typeof fetch;
}

let directory: string;
beforeEach(() => void (directory = mkdtempSync(join(tmpdir(), "replay-"))));
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** A real evaluation of the objective, with the real archive and the signing stand-in; returns its review's hash. */
async function evaluate(page = "<h1>Meetup in New York</h1>"): Promise<string> {
  const chain: Chain = {
    accountExists: async () => true,
    verifierBalance: async () => 0n,
    describeObjective: async () => ({ deployed: true, state: { delivered: 3 }, documents: { params: p, spec: SPEC } }),
  } as never;
  const app = createApp({
    model: { name: "unused", stream: () => (async function* () {})() },
    chain,
    deploy: async () => ({ accountId: "x" }),
    checks: {
      archive: evidenceArchive(directory),
      fetch: (async () => new Response(page)) as never,
      judge: nearAiJudge({ apiKey: "k", baseUrl: "https://ai.test/v1", send: cloud() }),
    },
    delivered: async (_, contributors) => BOTH.filter((d) => contributors.includes(d.contributor)),
  });
  const agent = new HttpAgent({ url: "http://test/api/evaluate", fetch: ((u: string, i: RequestInit) => app.fetch(new Request(u, i))) as never });
  let result: { review?: unknown } | undefined;
  let error: string | undefined;
  await agent.runAgent(
    { forwardedProps: { objective: OBJECTIVE } },
    {
      onRunFinishedEvent: ({ event }) => void (result = (event as { result?: { review?: unknown } }).result),
      onRunErrorEvent: ({ event }) => void (error = event.message),
    },
  );
  expect(error).toBeUndefined();
  return reviewHash(parseReview((result as { review: unknown }).review, SPEC as never));
}

const archived = () => readdirSync(directory);
const problems = (r: Awaited<ReturnType<typeof replay>>) => r.findings.filter((f) => f.status === "problem").map((f) => `${f.subject}: ${f.detail}`);
const store = (bytes: string) => {
  const name = bytesToHex(sha256(new TextEncoder().encode(bytes)));
  writeFileSync(join(directory, name), bytes);
  return name;
};

describe("replay", () => {
  test("an honest evaluation replays from its archive with nothing wrong", async () => {
    const hash = await evaluate();
    const report = await replay(directory, hash);
    expect(problems(report)).toEqual([]);
    expect(report.ok).toBe(true);
    const lines = formatReplay(report);
    expect(lines).toContain("the request is rebuilt byte for byte");
    expect(lines).toContain("receipt signature verifies");
    expect(lines).toContain("page (live_url): reproduced from archived bytes: pass");
    expect(lines).toContain("attendance (numeric_match): reproduced from archived bytes: pass");
    expect(lines).toContain("useful (llm_judge): reproduced from archived bytes: pass");
  });

  test("an unknown review is not in the archive", async () => {
    expect(problems(await replay(directory, "0".repeat(64)))).toEqual(["review: not in the archive"]);
  });

  test("bytes altered under their name are caught", async () => {
    const hash = await evaluate();
    const page = archived().find((n) => readFileSync(join(directory, n), "utf8").includes("Meetup in New York"))!;
    writeFileSync(join(directory, page), "<h1>Meetup in Paris</h1>");
    const report = await replay(directory, hash);
    expect(report.ok).toBe(false);
    expect(problems(report).join("\n")).toMatch(/do not hash to their name/);
    expect(problems(report).join("\n")).toMatch(/evidence of page.*not in the archive/);
  });

  test("a missing model receipt is caught", async () => {
    const hash = await evaluate();
    const receipt = archived().find((n) => readFileSync(join(directory, n), "utf8").includes('"signing_address"'))!;
    rmSync(join(directory, receipt));
    expect(problems(await replay(directory, hash))).toEqual([expect.stringMatching(/model call useful \/ m: the receipt .* is not in the archive/)]);
  });

  test("a receipt whose signature does not verify is caught", async () => {
    const hash = await evaluate();
    const name = archived().find((n) => readFileSync(join(directory, n), "utf8").includes('"signing_address"'))!;
    const receipt = JSON.parse(readFileSync(join(directory, name), "utf8"));
    rmSync(join(directory, name));
    // the same text, signed by a key that is not the recorded one: archived under its own name
    receipt.signature = bytesToHex(ed25519.sign(new TextEncoder().encode(receipt.text), ed25519.utils.randomSecretKey()));
    store(JSON.stringify(receipt));
    expect(problems(await replay(directory, hash)).join("\n")).toMatch(/signature does not verify/);
  });

  test("a model request that is not the spec's question over the archived reports is caught", async () => {
    const hash = await evaluate();
    const review = JSON.parse(readFileSync(join(directory, hash), "utf8"));
    // the evaluator asked something else than the spec's question, and the review points at that request
    const other = store(judgeRequest("m", "Is this a good meetup?", judgedText(BOTH)));
    review.llm_calls[0].request_sha256 = other;
    const changed = store(canonicalize(review));
    expect(problems(await replay(directory, changed)).join("\n")).toMatch(/not the one the spec's question and the archived reports produce/);
  });

  test("a missing report is caught", async () => {
    const hash = await evaluate();
    rmSync(join(directory, reportHash(REPORT)));
    const report = await replay(directory, hash);
    expect(report.ok).toBe(false);
    expect(problems(report).join("\n")).toMatch(/report of .*: not in the archive/);
  });

  test("a review that claims a pass the archived page does not support is caught", async () => {
    const hash = await evaluate();
    const review = JSON.parse(readFileSync(join(directory, hash), "utf8"));
    // an evaluator that says the page showed "New York" but points at evidence that says Paris
    const paris = store("<h1>Meetup in Paris</h1>");
    review.results[0].evidence = [{ url: review.results[0].evidence[0].url, sha256: paris }];
    const lie = store(canonicalize(review));
    expect(parseReview(review, SPEC as never).results[0]!.outcome).toBe("pass"); // a valid review, as far as its format goes
    const report = await replay(directory, lie);
    expect(report.ok).toBe(false);
    expect(problems(report).join("\n")).toMatch(/criterion page \(live_url\): replay gives fail .*; the review says pass/);
  });

  test("what the archive cannot show is inconclusive, not guessed", async () => {
    // a page that did not load is recorded with its bytes but not its HTTP status
    const hash = await evaluate("<h1>Not Found</h1>");
    const report = await replay(directory, hash);
    expect(report.findings).toContainEqual(expect.objectContaining({ status: "inconclusive", subject: "criterion page (live_url)" }));
    expect(report.ok).toBe(true);
  });
});
