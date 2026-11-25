/**
 * The spec's checks, run against a deliverable: one result per criterion in
 * the review format (`crates/spec`), with the SHA-256 of everything fetched
 * as evidence, so a later check can run against the same bytes. Contributors
 * run them before delivering; the evaluator runs them to judge.
 */
import { sha256Hex } from "../shared/jcs.ts";
import { compileSchema, dataProblem } from "../shared/schema.ts";
import { readCapped } from "./bounded.ts";
import { BudgetError } from "./budget.ts";
import { MAX_EVIDENCE_BYTES, publicUrl } from "./evidence-fetch.ts";
import type { Criterion, Spec } from "../shared/spec.ts";
import type { CheckResult, LlmCall } from "../shared/review.ts";

export interface Deliverable {
  /** The report, in Markdown: `<label>: <value>` lines, links, fenced JSON. */
  text: string;
  /** Delivered files by relative path, for `files` criteria. */
  files?: Record<string, string>;
  /** Whose reports exceed the spec's `max_report_bytes`: judged criteria fail on them, as the contributors agreed. */
  oversized?: string[];
}

export interface CheckDeps {
  /** Applies its own per-page timeout (`evidenceFetch` does); `signal` is only the run's. */
  fetch: typeof fetch;
  signal?: AbortSignal;
  archive?: (bytes: Uint8Array) => Promise<void>;
  /** One model's answer to an `llm_judge` question about the deliverable; absent, those criteria are skipped. */
  judge?: (
    model: string,
    question: string,
    deliverable: Deliverable,
    signal?: AbortSignal,
    archive?: CheckDeps["archive"],
  ) => Promise<{ answer: boolean; detail: string; call?: Omit<LlmCall, "criterion_id"> }>;
}

const MAX_FETCHES = 10;

export { publicUrl } from "./evidence-fetch.ts";

interface Fetched {
  url: string;
  ok: boolean;
  contentType: string;
  text: string;
  sha256: string;
}

type Loaded = Fetched | string | { unavailable: string };
const evidenceCaches = new WeakMap<CheckDeps, Map<string, Promise<Loaded>>>();

/** Share exact evidence bytes within one run, never between drafts and evaluations. */
export function checksForRun(deps: CheckDeps): CheckDeps {
  const run = { ...deps };
  evidenceCaches.set(run, new Map());
  return run;
}

async function load(deps: CheckDeps, raw: string): Promise<Fetched | string | { unavailable: string }> {
  const url = publicUrl(raw);
  if (!url) return `${raw} is not a public http(s) address`;
  url.hash = ""; // never sent, so it names no other page: one run fetches and caches a page once
  const cache = evidenceCaches.get(deps);
  const previous = cache?.get(url.href);
  if (previous) return previous;
  const pending = fetchPage(deps, url, raw);
  cache?.set(url.href, pending);
  return pending;
}

async function fetchPage(deps: CheckDeps, url: URL, raw: string): Promise<Loaded> {
  let res: Response;
  let bytes: Uint8Array;
  try {
    // The transport owns the per-page clock, which starts when the fetch does, not while it waits for a slot.
    res = await deps.fetch(url, { signal: deps.signal, redirect: "manual" });
    const encoding = res.headers.get("content-encoding");
    if (encoding && encoding !== "identity") return { unavailable: `${raw} returned an unsupported content encoding` };
    if ([408, 425, 429].includes(res.status) || res.status >= 500 || (res.status >= 300 && res.status < 400))
      return { unavailable: `${raw} could not be checked (HTTP ${res.status})` };
    const body = await readCapped(res, MAX_EVIDENCE_BYTES);
    if (!body) return { unavailable: `${raw} exceeds the evidence size limit` };
    bytes = body;
  } catch (e) {
    // The evaluator's own ceiling, not a host the contributor cited: like the archive failure below, it must reach the
    // run as an error, never as an unreachable host, which the retry rule turns into a failure.
    if (e instanceof BudgetError) throw e;
    return { unavailable: `${raw} did not load (${e instanceof Error ? e.message : String(e)})` };
  }
  // Outside the fetch's try: a failing archive is the evaluator's fault, not the contributor's. It must reach the
  // run as an error, which `streamChecks` records as a skipped check, never as an unreachable host: the retry rule
  // turns those into failures.
  await deps.archive?.(bytes);
  return {
    url: url.href,
    ok: res.ok,
    contentType: res.headers.get("content-type") ?? "",
    text: new TextDecoder().decode(bytes),
    sha256: sha256Hex(bytes),
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The value on a `<label>: <value>` line, case-insensitive, list markers allowed. */
export function labelled(text: string, label: string): string | undefined {
  // One line at a time, each anchored at its start and trimmed after: linear in the report. A pattern over the whole
  // text rescanned a long run of spaces for every candidate end of the value, and let a label with nothing after its
  // colon take the next line as its value.
  const line = new RegExp(`^\\s*(?:[-*]\\s*)?\\**${escape(label)}\\**\\s*:(.*)$`, "i");
  for (const l of text.split(/\r\n?|\n|\u2028|\u2029/)) {
    const value = line.exec(l)?.[1]!.trim();
    if (value) return value;
  }
  return undefined;
}

const LINK = /https?:\/\/[^\s)<>\]"']+/g;
/** The cited links, once each: two that differ only by `#fragment` name the same page. */
const links = (text: string) => [...new Set((text.match(LINK) ?? []).map((l) => l.replace(/#.*$/s, "")))];

/** The complete value accepted by numeric_match, including grouped and scientific notation. */
function numberValue(raw: string): number | undefined {
  const value = raw.replace(/[, _]/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Whole numeric tokens: 30 cannot be supported by 130, 30.5 or an identifier containing 30. */
function sourceNumbers(text: string): Set<number> {
  const numbers = new Set<number>();
  const tokens = /[+-]?(?:(?:\d{1,3}(?:[,_ ]\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g;
  const word = /[\p{L}\p{N}_.]/u;
  for (const token of text.matchAll(tokens)) {
    if (word.test(text[token.index - 1] ?? "") || word.test(text[token.index + token[0].length] ?? "")) continue;
    const n = numberValue(token[0]);
    if (n !== undefined) numbers.add(n);
  }
  return numbers;
}

const MEDIA_EXT: Record<string, RegExp> = {
  image: /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i,
  video: /\.(mp4|webm|mov)(\?|$)/i,
  audio: /\.(mp3|wav|ogg|m4a)(\?|$)/i,
};

const result = (c: Criterion, outcome: CheckResult["outcome"], detail: string, evidence: CheckResult["evidence"] = []): CheckResult => ({
  criterion_id: c.id,
  outcome,
  detail,
  evidence,
});

/**
 * Skipped because something the contributor cited couldn't be reached. The
 * evaluator's retry rule may make it a fail: the contributor answers for the
 * hosts it cites.
 */
const unreachable = (c: Criterion, detail: string, evidence: CheckResult["evidence"] = []): CheckResult => ({
  ...result(c, "skipped", detail, evidence),
  unavailable: true,
});

export async function runCheck(c: Criterion, spec: Spec, d: Deliverable, deps: CheckDeps): Promise<CheckResult> {
  const check = c.check;
  switch (check.kind) {
    case "contains": {
      const found = d.text.toLowerCase().includes(check.phrase.toLowerCase());
      const pass = check.absent ? !found : found;
      return result(c, pass ? "pass" : "fail", `"${check.phrase}" ${found ? "found" : "not found"}`);
    }
    case "schema": {
      const block = /```json\s*([\s\S]*?)```/i.exec(d.text)?.[1] ?? d.text;
      let data: unknown;
      try {
        data = JSON.parse(block);
      } catch {
        return result(c, "fail", "no JSON found in the deliverable");
      }
      const tooBig = dataProblem(block, data);
      if (tooBig) return result(c, "fail", tooBig);
      let validate: ReturnType<typeof compileSchema>;
      try {
        validate = compileSchema(check.json_schema);
      } catch (e) {
        return result(c, "skipped", `the schema can't be used: ${e instanceof Error ? e.message : e}`);
      }
      return validate(data)
        ? result(c, "pass", "the JSON is valid")
        : result(c, "fail", `the JSON is not valid: ${validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}`);
    }
    case "numeric_match": {
      const raw = labelled(d.text, check.label);
      if (raw === undefined) return result(c, "fail", `no "${check.label}: <number>" line`);
      const n = numberValue(raw);
      if (n === undefined) return result(c, "fail", `"${check.label}: ${raw}" is not a number`);
      const inRange = (check.min === undefined || n >= check.min) && (check.max === undefined || n <= check.max);
      const bounds = [check.min !== undefined && `at least ${check.min}`, check.max !== undefined && `at most ${check.max}`]
        .filter(Boolean)
        .join(" and ");
      return result(c, inRange ? "pass" : "fail", `${check.label}: ${n}${inRange ? "" : `, needs ${bounds}`}`);
    }
    case "files": {
      if (!d.files) return result(c, "skipped", "File contents are unavailable; this text-report evaluator cannot judge file delivery");
      const missing = check.paths.filter((p) => !d.files?.[p]?.length);
      return missing.length
        ? result(c, "fail", `missing or empty: ${missing.join(", ")}`)
        : result(c, "pass", `${check.paths.length} file${check.paths.length === 1 ? "" : "s"} delivered`);
    }
    case "live_url": {
      const url = labelled(d.text, check.label)?.match(LINK)?.[0];
      if (!url) return result(c, "fail", `no "${check.label}: <url>" line`);
      const page = await load(deps, url);
      if (typeof page === "string") return result(c, "fail", page);
      if ("unavailable" in page) return unreachable(c, page.unavailable);
      const evidence = [{ url: page.url, sha256: page.sha256 }];
      if (!page.ok) return result(c, "fail", `${url} did not load`, evidence);
      if (check.must_contain && !page.text.toLowerCase().includes(check.must_contain.toLowerCase()))
        return result(c, "fail", `${url} loads but does not show "${check.must_contain}"`, evidence);
      return result(c, "pass", `${url} loads${check.must_contain ? ` and shows "${check.must_contain}"` : ""}`, evidence);
    }
    case "sources": {
      const cited = links(d.text).slice(0, MAX_FETCHES);
      // load never throws, so every link is fetched at once
      const fetched = await Promise.all(cited.map((url) => load(deps, url)));
      const unavailable = fetched.some((p) => typeof p !== "string" && "unavailable" in p);
      // a page counts once: the same bytes behind two addresses (a mirror, http and https) are one source
      const pages = fetched
        .filter((p): p is Fetched => typeof p !== "string" && "ok" in p && p.ok)
        .filter((p, i, all) => all.findIndex((q) => q.sha256 === p.sha256) === i);
      const evidence = pages.map((p) => ({ url: p.url, sha256: p.sha256 }));
      if (pages.length < check.min)
        return unavailable
          ? unreachable(c, `${pages.length} of the needed ${check.min} cited links load; some evidence is unavailable`, evidence)
          : result(c, "fail", `${pages.length} of the needed ${check.min} cited links load`, evidence);
      if (check.figures) {
        const figures = spec.criteria.flatMap((k) => {
          if (k.check.kind !== "numeric_match") return [];
          const raw = labelled(d.text, k.check.label);
          return [{ label: k.check.label, raw, value: raw === undefined ? undefined : numberValue(raw) }];
        });
        const numbers = pages.map((p) => sourceNumbers(p.text));
        const unsupported = figures
          .filter((f) => f.value === undefined || !numbers.some((page) => page.has(f.value!)))
          .map((f) => f.raw ?? f.label);
        if (unsupported.length)
          return unavailable
            ? unreachable(c, `not found on available cited pages: ${unsupported.join(", ")}`, evidence)
            : result(c, "fail", `not found on available cited pages: ${unsupported.join(", ")}`, evidence);
      }
      return result(c, "pass", `${pages.length} cited link${pages.length === 1 ? "" : "s"} load`, evidence);
    }
    case "media": {
      const candidates = links(d.text)
        .filter((u) => check.kinds.some((k) => MEDIA_EXT[k]!.test(u)))
        .slice(0, MAX_FETCHES);
      const fetched = await Promise.all(candidates.map((url) => load(deps, url)));
      const unavailable = fetched.some((p) => typeof p !== "string" && "unavailable" in p);
      const loaded = fetched.filter(
        (p): p is Fetched => typeof p !== "string" && "ok" in p && p.ok && check.kinds.some((k) => p.contentType.startsWith(`${k}/`)),
      );
      const evidence = loaded.map((p) => ({ url: p.url, sha256: p.sha256 }));
      return loaded.length >= check.min
        ? result(c, "pass", `${loaded.length} ${check.kinds.join(" or ")} item${loaded.length === 1 ? "" : "s"} load`, evidence)
        : unavailable
          ? unreachable(c, `${loaded.length} of the needed ${check.min} ${check.kinds.join(" or ")} items load`, evidence)
          : result(c, "fail", `${loaded.length} of the needed ${check.min} ${check.kinds.join(" or ")} items load`, evidence);
    }
    case "llm_judge": {
      if (d.oversized?.length)
        return result(c, "fail", `over the spec's ${spec.max_report_bytes}-byte report limit: ${d.oversized.join(", ")}`);
      if (!deps.judge) return result(c, "skipped", "judged by the evaluator's model, not in this check");
      // every named model answers once; the outcome is their majority
      const judge = deps.judge;
      const answers = await Promise.allSettled(check.models.map((m) => judge(m, check.question, d, deps.signal, deps.archive)));
      const given = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
      const calls = given.flatMap((a) => (a.call ? [{ criterion_id: c.id, ...a.call }] : []));
      const withCalls = (r: CheckResult): CheckResult => (calls.length ? { ...r, calls } : r);
      const failed = answers.find((a): a is PromiseRejectedResult => a.status === "rejected");
      if (failed)
        return withCalls(
          result(c, "skipped", `could not judge: ${failed.reason instanceof Error ? failed.reason.message : failed.reason}`),
        );
      const yes = given.filter((a) => a.answer).length;
      const detail =
        given.length === 1 ? given[0]!.detail : `${yes} of ${given.length} models answered yes. ${given.map((a) => a.detail).join(" ")}`;
      return withCalls(result(c, yes * 2 > given.length ? "pass" : "fail", detail));
    }
  }
}
