/**
 * The off-chain documents behind `spec_hash` and `review_hash`, mirroring
 * `crates/spec`. A document's hash is the SHA-256 of its RFC 8785 canonical
 * JSON, and a document is accepted only in normal form, so one meaning has
 * one hash.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import { canonicalize, jcsHash } from "./jcs.ts";
import { compileSchema, specLimitProblem } from "./schema.ts";

export const VERSION = 1;
export const MAX_CRITERIA = 32;
export const MAX_JUDGES = 2;
export const MAX_FILES = 60;

const u32 = z.number().int().min(0).max(0xffff_ffff);
const hash = z.string().regex(/^[0-9a-f]{64}$/, "not 64 lowercase hex digits");
export const accountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "not a NEAR account id");

export const check = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("contains"), phrase: z.string(), absent: z.boolean() }),
  z.strictObject({ kind: z.literal("schema"), json_schema: z.json() }),
  z.strictObject({
    kind: z.literal("numeric_match"),
    label: z.string(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.strictObject({ kind: z.literal("files"), paths: z.array(z.string()) }),
  z.strictObject({
    kind: z.literal("live_url"),
    label: z.string(),
    must_contain: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("sources"), min: u32, figures: z.boolean() }),
  z.strictObject({
    kind: z.literal("media"),
    kinds: z.array(z.enum(["image", "video", "audio"])),
    min: u32,
  }),
  z.strictObject({ kind: z.literal("llm_judge"), question: z.string(), models: z.array(z.string()) }),
]);

export const criterion = z.strictObject({
  id: z.string(),
  description: z.string(),
  check,
});

export const spec = z.strictObject({
  v: u32,
  statement: z.string(),
  criteria: z.array(criterion),
  /** SHA-256 of the evaluator program, for an attested evaluator; a review must record the same build. */
  evaluator_build: hash.optional(),
  /** UTF-8 bytes allowed per contributor report; required, and positive, whenever a criterion is `llm_judge`. */
  max_report_bytes: u32.optional(),
});

export const outcome = z.enum(["pass", "fail", "skipped"]);
export const verdict = z.enum(["achieved", "failed"]);

export const review = z.strictObject({
  v: u32,
  objective: accountId,
  spec_hash: hash,
  evaluator_build: hash.optional(),
  deliverables: z.array(z.strictObject({ contributor: accountId, sha256: hash })),
  /** Slots whose report was never published: judged as failed, never as achieved. Omitted when empty. */
  missing: z.array(accountId).optional(),
  results: z.array(
    z.strictObject({
      criterion_id: z.string(),
      outcome,
      detail: z.string(),
      evidence: z.array(z.strictObject({ url: z.string(), sha256: hash })),
    }),
  ),
  llm_calls: z.array(
    z.strictObject({
      criterion_id: z.string(),
      model: z.string(),
      answer: z.boolean(),
      request_sha256: hash,
      response_sha256: hash,
      signature: z.strictObject({ algo: z.string(), address: z.string(), value: z.string() }).optional(),
    }),
  ),
  verdict,
});

export type Check = z.infer<typeof check>;
export type Criterion = z.infer<typeof criterion>;
export type Spec = z.infer<typeof spec>;
export type Review = z.infer<typeof review>;

export class SpecError extends Error {}

const fail = (message: string): never => {
  throw new SpecError(message);
};

/** Parses a document in normal form; anything else is a different hash. */
function fromJson<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return fail(`not in normal form: ${z.prettifyError(parsed.error)}`);
  }
  let same: boolean;
  try {
    same = canonicalize(parsed.data) === canonicalize(raw);
  } catch (e) {
    return fail(`not in normal form: ${e instanceof Error ? e.message : e}`);
  }
  if (!same) return fail("not in normal form: an unknown field, or null where a field should be left out");
  return parsed.data;
}

const nonEmpty = (field: string, value: string) => {
  if (value.trim() === "") fail(`${field} is empty`);
};

const checkVersion = (v: number) => {
  if (v !== VERSION) fail(`unsupported version ${v}`);
};

/** The value for `Params::spec_hash`. */
export const specHash = (s: Spec): string => jcsHash(s);

/** The value for `Attestation::review_hash`. */
export const reviewHash = (r: Review): string => jcsHash(r);

export function parseSpec(raw: unknown): Spec {
  const s = fromJson(spec, raw);
  validateSpec(s);
  return s;
}

export function validateSpec(s: Spec): void {
  checkVersion(s.v);
  nonEmpty("statement", s.statement);
  if (s.criteria.length === 0) fail("no criteria");
  if (s.criteria.length > MAX_CRITERIA) fail(`more than ${MAX_CRITERIA} criteria`);
  const judges = s.criteria.filter((c) => c.check.kind === "llm_judge").length;
  if (judges > MAX_JUDGES) fail(`more than ${MAX_JUDGES} llm_judge criteria`);
  // a model's answer is never the only gate: achieved needs every criterion, so a script-checked one stands with it
  if (judges === s.criteria.length) fail("every criterion is llm_judge: at least one must be checked by a script");
  const ids = new Set<string>();
  for (const c of s.criteria) {
    if (ids.has(c.id)) fail(`criterion id ${JSON.stringify(c.id)} appears twice`);
    ids.add(c.id);
    if (!/^[a-z0-9_-]{1,32}$/.test(c.id)) {
      fail(`criterion id ${JSON.stringify(c.id)} is not 1 to 32 of a-z, 0-9, '-' or '_'`);
    }
    nonEmpty("description", c.description);
    const reason = checkProblem(c.check);
    if (reason) fail(`criterion ${c.id}: ${reason}`);
  }
  // a judged report must fit what the judge reads, so the spec bounds it up front
  if (s.max_report_bytes === 0 || (s.max_report_bytes === undefined && judges > 0))
    fail("a spec with an llm_judge needs a positive max_report_bytes");
}

/** Capabilities of this app's text-report evaluator, distinct from the protocol format. */
export function validateAppSpec(s: Spec): void {
  // the app's limits first: validateSpec compiles every schema
  const tooBig = specLimitProblem(s);
  if (tooBig) fail(tooBig);
  validateSpec(s);
  if (s.criteria.some((c) => c.check.kind === "files"))
    fail("This app does not support file delivery yet. Use report, URL or schema criteria.");
  if (s.criteria.some((c) => (c.check.kind === "sources" || c.check.kind === "media") && c.check.min > 10))
    fail("This evaluator supports at most 10 sources or media items per criterion.");
  if (s.evaluator_build !== undefined) fail("This app's evaluator is not an attested build. Leave evaluator_build out.");
  for (const c of s.criteria) {
    if (c.check.kind !== "schema") continue;
    try {
      compileSchema(c.check.json_schema);
    } catch (e) {
      fail(`criterion ${c.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

function checkProblem(c: Check): string | undefined {
  const text = (field: string, value: string) => (value.trim() === "" ? `${field} is empty` : undefined);

  switch (c.kind) {
    case "contains":
      return text("phrase", c.phrase);
    case "schema": {
      if (typeof c.json_schema !== "object" || c.json_schema === null || Array.isArray(c.json_schema)) {
        return "json_schema is not an object";
      }
      try {
        new Ajv2020({ strict: false }).compile(c.json_schema);
        return undefined;
      } catch (e) {
        return `json_schema does not compile: ${(e as Error).message}`;
      }
    }
    case "numeric_match":
      if (text("label", c.label)) return text("label", c.label);
      if (c.min === undefined && c.max === undefined) return "neither min nor max is set";
      if (c.min !== undefined && c.max !== undefined && c.min > c.max) return "min is above max";
      return undefined;
    case "files": {
      if (c.paths.length < 1 || c.paths.length > MAX_FILES) return `needs 1 to ${MAX_FILES} paths`;
      const seen = new Set<string>();
      for (const path of c.paths) {
        const relative =
          path !== "" && !path.startsWith("/") && !path.includes("\\") && path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
        if (!relative) return `${JSON.stringify(path)} is not a relative path`;
        if (seen.has(path)) return `${JSON.stringify(path)} appears twice`;
        seen.add(path);
      }
      return undefined;
    }
    case "live_url":
      return text("label", c.label) ?? (c.must_contain === undefined ? undefined : text("must_contain", c.must_contain));
    case "sources":
      return c.min === 0 ? "min is 0" : undefined;
    case "media":
      if (c.kinds.length === 0) return "kinds is empty";
      if (new Set(c.kinds).size !== c.kinds.length) return "kinds repeats a kind";
      return c.min === 0 ? "min is 0" : undefined;
    case "llm_judge": {
      if (text("question", c.question)) return text("question", c.question);
      if (c.models.length !== 1 && c.models.length !== 3) return "needs one model or three";
      for (const m of c.models) if (text("model", m)) return text("model", m);
      return new Set(c.models).size === c.models.length ? undefined : "models repeats a model";
    }
  }
}

export function parseReview(raw: unknown, s: Spec): Review {
  const r = fromJson(review, raw);
  validateReview(r, s);
  return r;
}

/**
 * Every call judged an `llm_judge` criterion with one of its models, once
 * per model; a judged outcome has every model's answer and follows their
 * majority. A skipped one may have some.
 */
function validateCalls(r: Review, s: Spec, outcomes: Map<string, z.infer<typeof outcome>>): void {
  const answers = new Map<string, Map<string, boolean>>();
  for (const call of r.llm_calls) {
    const check = s.criteria.find((c) => c.id === call.criterion_id)?.check;
    if (check?.kind !== "llm_judge") fail(`llm call for ${call.criterion_id}: not an llm_judge criterion`);
    if (!(check as Extract<Check, { kind: "llm_judge" }>).models.includes(call.model))
      fail(`llm call for ${call.criterion_id}: a model the spec does not name`);
    const byModel = answers.get(call.criterion_id) ?? new Map<string, boolean>();
    if (byModel.has(call.model)) fail(`llm call for ${call.criterion_id}: two calls to one model`);
    answers.set(call.criterion_id, byModel.set(call.model, call.answer));
  }
  for (const c of s.criteria) {
    if (c.check.kind !== "llm_judge") continue;
    const o = outcomes.get(c.id);
    if (o !== "pass" && o !== "fail") continue;
    const byModel = answers.get(c.id);
    // no model is asked about a report over max_report_bytes: a fail may have no calls, a pass never
    if (o === "fail" && !byModel) continue;
    if (!byModel || byModel.size !== c.check.models.length) fail(`llm call for ${c.id}: a judged outcome needs every model's answer`);
    const yes = [...byModel!.values()].filter(Boolean).length;
    if (yes * 2 > c.check.models.length !== (o === "pass"))
      fail(`criterion ${c.id}: its outcome is not the majority of its models' answers`);
  }
}

/**
 * Checks the review against the spec it claims to judge, and the verdict
 * against the results: `achieved` only when every criterion passed and no
 * report is missing, `failed` only when a criterion failed or a report is
 * missing. Skipped with nothing failed or missing supports neither, so the
 * evaluator does not attest yet.
 */
export function validateReview(r: Review, s: Spec): void {
  checkVersion(r.v);
  if (r.spec_hash !== specHash(s)) fail("spec_hash does not match the spec");
  if (s.evaluator_build !== undefined && r.evaluator_build !== s.evaluator_build) fail("evaluator_build does not match the spec's");

  const contributors = new Set<string>();
  for (const d of r.deliverables) {
    if (contributors.has(d.contributor)) fail(`two deliverables from ${d.contributor}`);
    contributors.add(d.contributor);
  }
  for (const m of r.missing ?? []) {
    if (contributors.has(m)) fail(`${m} is listed as missing twice, or as both missing and delivered`);
    contributors.add(m);
  }

  const outcomes = new Map<string, z.infer<typeof outcome>>();
  for (const res of r.results) {
    const c = s.criteria.find((c) => c.id === res.criterion_id);
    if (!c) fail(`result for criterion ${res.criterion_id}, which the spec does not have`);
    if (outcomes.has(res.criterion_id)) fail(`two results for criterion ${res.criterion_id}`);
    outcomes.set(res.criterion_id, res.outcome);
    for (const e of res.evidence) {
      if (!e.url.startsWith("https://") && !e.url.startsWith("http://")) {
        fail(`evidence url ${JSON.stringify(e.url)} is not http(s)`);
      }
    }
    const fetches = ["live_url", "sources", "media"].includes(c!.check.kind);
    if (fetches && res.outcome === "pass" && res.evidence.length === 0) {
      fail(`criterion ${res.criterion_id} passed by fetching, but its result has no evidence`);
    }
  }
  const missing = s.criteria.find((c) => !outcomes.has(c.id));
  if (missing) fail(`no result for criterion ${missing.id}`);

  validateCalls(r, s, outcomes);

  const all = [...outcomes.values()];
  const unjudged = (r.missing ?? []).length > 0;
  const failed = unjudged || all.includes("fail");
  if (r.verdict === "achieved" && unjudged) fail("verdict achieved contradicts the results: a contributor's report is missing");
  if (r.verdict === "achieved" && !all.every((o) => o === "pass"))
    fail("verdict achieved contradicts the results: not every criterion passed");
  if (r.verdict === "failed" && !failed) fail("verdict failed contradicts the results: no criterion failed and no report is missing");
}
