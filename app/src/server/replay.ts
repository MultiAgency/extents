/**
 * Replay an evaluation from the private evidence archive: nothing is fetched and no model is asked.
 *
 * Given a review's hash, this checks that everything the review commits to is in the archive and unaltered, that each
 * model request is the one the spec's question and the archived reports produce, that each model receipt's signature
 * verifies, and that every criterion whose outcome can be derived from archived bytes comes out the same.
 *
 * What the archive does not keep cannot be replayed, and is reported as inconclusive instead of guessed at: the HTTP
 * status and content type of a fetched page (only its body is stored), and file deliverables.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";

import { sha256Hex } from "../shared/jcs.ts";
import { judgedText, judgeRequest, utf8Bytes } from "../shared/judge.ts";
import { reportHash } from "../shared/review.ts";
import { parseReview, parseSpec, reviewHash, type Review, type Spec } from "../shared/spec.ts";
import { runCheck, type CheckDeps } from "./checks.ts";

export interface Finding {
  status: "ok" | "inconclusive" | "problem";
  subject: string;
  detail: string;
}

export interface ReplayReport {
  review: string;
  findings: Finding[];
  /** No problem was found. Inconclusive findings are not problems: they name what the archive cannot show. */
  ok: boolean;
}

const HASH = /^[0-9a-f]{64}$/;
const MAX_RECEIPT_BYTES = 16 * 1024;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export async function replay(directory: string, hash: string): Promise<ReplayReport> {
  const findings: Finding[] = [];
  const note = (status: Finding["status"], subject: string, detail: string) => void findings.push({ status, subject, detail });
  const done = (): ReplayReport => ({ review: hash, findings, ok: !findings.some((f) => f.status === "problem") });

  /** One archived item by its hash, if it is there and its bytes still hash to its name. */
  const read = async (name: string): Promise<Uint8Array | undefined> => {
    if (!HASH.test(name)) return undefined;
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(directory, name));
    } catch {
      return undefined;
    }
    if (sha256Hex(bytes) !== name) {
      note("problem", `archive ${name.slice(0, 12)}`, "the archived bytes do not hash to their name");
      return undefined;
    }
    return bytes;
  };

  // the review, and the spec it was judged against
  const reviewBytes = await read(hash);
  if (!reviewBytes) {
    note("problem", "review", "not in the archive");
    return done();
  }
  let doc: unknown;
  let spec: Spec;
  let review: Review;
  try {
    doc = JSON.parse(text(reviewBytes));
    const specName = (doc as { spec_hash?: unknown }).spec_hash;
    const specBytes = typeof specName === "string" ? await read(specName) : undefined;
    if (!specBytes) {
      note("problem", "spec", "the spec this review names is not in the archive");
      return done();
    }
    spec = parseSpec(JSON.parse(text(specBytes)));
    review = parseReview(doc, spec);
  } catch (e) {
    note("problem", "review", `does not validate against its spec: ${e instanceof Error ? e.message : e}`);
    return done();
  }
  if (reviewHash(review) !== hash) note("problem", "review", "its canonical form does not hash to the name it is archived under");
  else note("ok", "review", `verdict ${review.verdict}; valid against the archived spec, in normal form`);

  // the reports each contributor delivered
  const delivered: { contributor: string; text: string }[] = [];
  let reportsComplete = true;
  for (const d of review.deliverables) {
    const bytes = await read(d.sha256);
    const report = bytes && text(bytes);
    if (report === undefined || reportHash(report) !== d.sha256) {
      reportsComplete = false;
      note("problem", `report of ${d.contributor}`, "not in the archive");
      continue;
    }
    delivered.push({ contributor: d.contributor, text: report });
    note("ok", `report of ${d.contributor}`, "archived and unaltered");
  }
  for (const m of review.missing ?? []) note("ok", `report of ${m}`, "none was published, as the review says");

  // evidence the criteria fetched, by criterion
  const pages = new Map<string, Map<string, Uint8Array>>();
  for (const r of review.results) {
    const found = new Map<string, Uint8Array>();
    for (const e of r.evidence) {
      const bytes = await read(e.sha256);
      if (bytes) found.set(e.url, bytes);
      else note("problem", `evidence of ${r.criterion_id}`, `${e.url} (${e.sha256.slice(0, 12)}) is not in the archive`);
    }
    pages.set(r.criterion_id, found);
    if (r.evidence.length && found.size === r.evidence.length) note("ok", `evidence of ${r.criterion_id}`, `${found.size} page(s) archived and unaltered`);
  }

  // model calls: the request, the answer and the receipt
  const answers = new Map<string, boolean>();
  let receiptNames: string[] | undefined;
  const findReceipt = async (expected: string): Promise<{ text: string; signature: string; signing_address: string } | undefined> => {
    receiptNames ??= (await readdir(directory)).filter((n) => HASH.test(n));
    for (const name of receiptNames) {
      const path = join(directory, name);
      if ((await stat(path)).size > MAX_RECEIPT_BYTES) continue;
      try {
        const candidate = JSON.parse(await readFile(path, "utf8")) as { text?: unknown; signature?: unknown; signing_address?: unknown };
        if (candidate.text === expected && typeof candidate.signature === "string" && typeof candidate.signing_address === "string")
          return candidate as { text: string; signature: string; signing_address: string };
      } catch {
        // not a receipt
      }
    }
    return undefined;
  };
  for (const call of review.llm_calls) {
    const subject = `model call ${call.criterion_id} / ${call.model}`;
    const check = spec.criteria.find((c) => c.id === call.criterion_id)?.check;
    if (check?.kind !== "llm_judge") {
      note("problem", subject, "the criterion is not an llm_judge in the spec");
      continue;
    }
    answers.set(`${call.criterion_id}/${call.model}`, call.answer);
    const request = await read(call.request_sha256);
    const response = await read(call.response_sha256);
    if (!request || !response) {
      note("problem", subject, "the request or the response is not in the archive");
      continue;
    }
    if (reportsComplete) {
      const rebuilt = judgeRequest(call.model, check.question, judgedText(delivered));
      if (text(request) === rebuilt) note("ok", subject, "the request is rebuilt byte for byte from the spec's question and the archived reports");
      else note("problem", subject, "the archived request is not the one the spec's question and the archived reports produce");
    }
    try {
      const content = (JSON.parse(text(response)) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
      const first = content.trim().split("\n")[0] ?? "";
      if (!/^(yes|no)$/i.test(first) || /^yes$/i.test(first) !== call.answer) note("problem", subject, `the archived response does not give the recorded answer (${call.answer ? "yes" : "no"})`);
      else note("ok", subject, `the archived response gives the recorded answer (${call.answer ? "yes" : "no"})`);
    } catch {
      note("problem", subject, "the archived response is not a model response");
    }
    const receipt = await findReceipt(`${call.model}:${call.request_sha256}:${call.response_sha256}`);
    if (!receipt) {
      note("problem", subject, "the receipt over this request and response is not in the archive");
      continue;
    }
    let verified = false;
    try {
      verified = ed25519.verify(hexToBytes(receipt.signature), new TextEncoder().encode(receipt.text), hexToBytes(receipt.signing_address));
    } catch {
      // malformed hex: not verified
    }
    const recorded = call.signature;
    if (!verified) note("problem", subject, "the archived receipt's signature does not verify");
    else if (recorded && (recorded.address !== receipt.signing_address || recorded.value !== receipt.signature))
      note("problem", subject, "the archived receipt is not the one the review records");
    else note("ok", subject, `receipt signature verifies for ${receipt.signing_address.slice(0, 12)}…; the key is not tied to an enclave`);
  }

  // criteria: re-run what archived bytes can decide
  const oversized = spec.max_report_bytes === undefined ? [] : delivered.filter((d) => utf8Bytes(d.text) > spec.max_report_bytes!).map((d) => d.contributor);
  for (const c of spec.criteria) {
    const result = review.results.find((r) => r.criterion_id === c.id)!;
    const kind = c.check.kind;
    const subject = `criterion ${c.id} (${kind})`;
    const network = kind === "live_url" || kind === "sources" || kind === "media";
    const original = result.outcome;
    if (!reportsComplete) note("inconclusive", subject, "a report is missing from the archive");
    else if (kind === "files") note("inconclusive", subject, "file deliverables are not evaluated by this app");
    else if (kind === "media") note("inconclusive", subject, "the content type of each item is not archived");
    else if (kind === "llm_judge" && original === "skipped") note("inconclusive", subject, "it was not judged in the original run");
    else if (network && original !== "pass" && (result.evidence.length > 0 || original === "skipped"))
      note("inconclusive", subject, `the HTTP status of a fetched page is not archived, so "${original}" cannot be told apart from the page's bytes`);
    else {
      const served = pages.get(c.id) ?? new Map<string, Uint8Array>();
      const deps: CheckDeps = {
        fetch: (async (input: URL | string) => {
          const bytes = served.get(String(input));
          if (!bytes) throw new Error("not in the archive");
          return new Response(bytes as BodyInit, { status: 200, headers: { "content-type": "text/html" } });
        }) as never,
        judge: async (model) => {
          const answer = answers.get(`${c.id}/${model}`);
          if (answer === undefined) throw new Error("no archived answer");
          return { answer, detail: "replayed from the archive" };
        },
      };
      const replayed = await runCheck(c, spec, { text: judgedText(delivered), oversized }, deps);
      if (replayed.outcome === original) note("ok", subject, `reproduced from archived bytes: ${original}`);
      else note("problem", subject, `replay gives ${replayed.outcome} (${replayed.detail}); the review says ${original} (${result.detail})`);
    }
  }
  return done();
}

export function formatReplay(report: ReplayReport): string {
  const mark = { ok: "  ok", inconclusive: "   ~", problem: "  !!" } as const;
  const count = (s: Finding["status"]) => report.findings.filter((f) => f.status === s).length;
  return [
    `replay of review ${report.review}`,
    ...report.findings.map((f) => `${mark[f.status]}  ${f.subject}: ${f.detail}`),
    `${count("ok")} ok, ${count("inconclusive")} inconclusive, ${count("problem")} problem(s)`,
  ].join("\n");
}
