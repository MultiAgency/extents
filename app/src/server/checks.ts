/**
 * The spec's checks, run against a deliverable: one result per criterion in
 * the review format (`crates/spec`), with the SHA-256 of everything fetched
 * as evidence, so a later check can run against the same bytes. Contributors
 * run them before delivering; the evaluator runs them to judge.
 */
import { sha256Hex } from "../shared/jcs.ts";
import { compileSchema, dataProblem } from "../shared/schema.ts";
import { readCapped, withTimeout } from "./bounded.ts";
import { MAX_EVIDENCE_BYTES, publicUrl } from "./evidence-fetch.ts";
import type { Criterion, Spec } from "../shared/spec.ts";
import type { CheckResult, LlmCall } from "../shared/review.ts";

export interface Deliverable {
  /** The report, in Markdown: `<label>: <value>` lines, links, fenced JSON. */
  text: string;
  /** Delivered files by relative path, for `files` criteria. */
  files?: Record<string, string>;
}

export interface CheckDeps {
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

const TIMEOUT_MS = 10_000;
const MAX_FETCHES = 10;

export { publicUrl } from "./evidence-fetch.ts";

interface Fetched {
  url: string;
  ok: boolean;
  contentType: string;
  text: string;
  sha256: string;
}

async function load(deps: CheckDeps, raw: string): Promise<Fetched | string | { unavailable: string }> {
  const url = publicUrl(raw);
  if (!url) return `${raw} is not a public http(s) address`;
  try {
    const signal = withTimeout(deps.signal, TIMEOUT_MS);
    const res = await deps.fetch(url, { signal, redirect: "manual" });
    const encoding = res.headers.get("content-encoding");
    if (encoding && encoding !== "identity") return { unavailable: `${raw} returned an unsupported content encoding` };
    if ([408, 425, 429].includes(res.status) || res.status >= 500 || (res.status >= 300 && res.status < 400))
      return { unavailable: `${raw} could not be checked (HTTP ${res.status})` };
    const bytes = await readCapped(res, MAX_EVIDENCE_BYTES);
    if (!bytes) return { unavailable: `${raw} exceeds the evidence size limit` };
    await deps.archive?.(bytes);
    return {
      url: url.href,
      ok: res.ok,
      contentType: res.headers.get("content-type") ?? "",
      text: new TextDecoder().decode(bytes),
      sha256: sha256Hex(bytes),
    };
  } catch (e) {
    return { unavailable: `${raw} did not load (${e instanceof Error ? e.message : String(e)})` };
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The value on a `<label>: <value>` line, case-insensitive, list markers allowed. */
export function labelled(text: string, label: string): string | undefined {
  const m = new RegExp(`^\\s*(?:[-*]\\s*)?\\**${escape(label)}\\**\\s*:\\s*(.+?)\\s*$`, "im").exec(text);
  return m?.[1];
}

const LINK = /https?:\/\/[^\s)<>\]"']+/g;
const links = (text: string) => [...new Set(text.match(LINK) ?? [])];

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
      const value = raw.replace(/[, _]/g, "");
      const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
      const n = numeric ? Number(value) : NaN;
      if (!Number.isFinite(n)) return result(c, "fail", `"${check.label}: ${raw}" is not a number`);
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
      if ("unavailable" in page) return result(c, "skipped", page.unavailable);
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
      const pages = fetched.filter((p): p is Fetched => typeof p !== "string" && "ok" in p && p.ok);
      const evidence = pages.map((p) => ({ url: p.url, sha256: p.sha256 }));
      if (pages.length < check.min)
        return result(
          c,
          unavailable ? "skipped" : "fail",
          `${pages.length} of the needed ${check.min} cited links load${unavailable ? "; some evidence is unavailable" : ""}`,
          evidence,
        );
      if (check.figures) {
        const figures = spec.criteria.flatMap((k) =>
          k.check.kind === "numeric_match" ? [labelled(d.text, k.check.label)?.match(/-?\d[\d,]*(\.\d+)?/)?.[0]].filter(Boolean) : [],
        ) as string[];
        const unsupported = figures.filter((f) => !pages.some((p) => p.text.includes(f)));
        if (unsupported.length)
          return result(c, unavailable ? "skipped" : "fail", `not found on available cited pages: ${unsupported.join(", ")}`, evidence);
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
        : result(
            c,
            unavailable ? "skipped" : "fail",
            `${loaded.length} of the needed ${check.min} ${check.kinds.join(" or ")} items load`,
            evidence,
          );
    }
    case "llm_judge": {
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
