/**
 * Known answers from outside this package: the vectors pinned by
 * `crates/spec` and `contracts/objective`. Set E2E_RESULTS_DIR to a generated
 * build directory to also validate its recorded testnet documents.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { attestTgas, closeTgas } from "../src/shared/attest.ts";
import { judgedText, judgeRequest } from "../src/shared/judge.ts";
import { borshParams, initState, objectiveAccountId, paramsHash, validateParams, type Params } from "../src/shared/params.ts";
import { parseReview, parseSpec, reviewHash, specHash, SpecError } from "../src/shared/spec.ts";

const root = join(import.meta.dirname, "../..");
const read = (...path: string[]) => JSON.parse(readFileSync(join(root, ...path), "utf8"));
const vectors = (...path: string[]) => read("crates/spec/tests/vectors", ...path);

describe("crates/spec vectors", () => {
  const expected = vectors("expected.json");
  const spec = parseSpec(vectors("spec.json"));

  test("spec hash", () => expect(specHash(spec)).toBe(expected["spec.json"]));
  test("review hash", () => expect(reviewHash(parseReview(vectors("review.json"), spec))).toBe(expected["review.json"]));

  test("judge request, rebuilt byte for byte", () => {
    const v = vectors("judge-request.json") as {
      model: string;
      question: string;
      deliverables: [string, string][];
      request_sha256: string;
    };
    const text = judgedText(v.deliverables.map(([contributor, text]) => ({ contributor, text })));
    expect(bytesToHex(sha256(new TextEncoder().encode(judgeRequest(v.model, v.question, text))))).toBe(v.request_sha256);
  });

  // as crates/spec's a_judged_* tests: review.json with the judged criterion `useful` set to `outcome`, with `calls`
  const judged = (outcome: string, calls: unknown[], against = spec) => {
    const review = structuredClone(vectors("review.json"));
    review.results.find((r: { criterion_id: string }) => r.criterion_id === "useful").outcome = outcome;
    review.llm_calls = calls;
    if (against !== spec) review.spec_hash = specHash(against);
    return () => parseReview(review, against);
  };
  const call = (model: string, answer: boolean) => ({
    criterion_id: "useful",
    model,
    answer,
    request_sha256: "33".repeat(32),
    response_sha256: "44".repeat(32),
  });

  // docs/spec.md, "A judged spec caps the report size"
  test("a judged fail may have no calls, as for a report over the limit; a pass never", () => {
    expect(judged("fail", [])).not.toThrow();
    expect(judged("pass", [])).toThrow(/needs every model's answer/);
  });

  test("once any model was asked, a judged fail needs every model's answer", () => {
    const raw = structuredClone(vectors("spec.json"));
    raw.criteria.find((c: { id: string }) => c.id === "useful").check.models = ["a/model", "b/model", "c/model"];
    expect(judged("fail", [call("a/model", false)], parseSpec(raw))).toThrow(/needs every model's answer/);
  });

  const rejected = readdirSync(join(root, "crates/spec/tests/vectors/rejected"));
  test("every rejected vector is covered", () => expect(rejected.length).toBeGreaterThan(0));
  // docs/spec.md, "A model is never the only gate"; docs/spec.md, "A judged spec caps the report size"; docs/spec.md, "One meaning has one hash"; docs/spec.md, "A verdict follows its results"
  test.each(rejected)("rejects %s", (file) => {
    const doc = vectors("rejected", file);
    const parse = file.startsWith("spec-") ? () => parseSpec(doc) : () => parseReview(doc, spec);
    expect(parse).toThrow(SpecError);
  });
});

interface ParamsVector {
  name: string;
  params: Params;
  params_borsh: string;
  params_hash: string;
  state_init: { key: string; value: string };
  code_hash: string;
  account_id: string;
  attest_tgas: number;
  close_tgas: number;
}

describe("contracts/objective vectors", () => {
  const cases: ParamsVector[] = read("contracts/objective/tests/vectors/params.json");
  test("vectors exist", () => expect(cases.length).toBeGreaterThan(0));

  test.each(cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(bytesToHex(borshParams(c.params))).toBe(c.params_borsh);
    expect(paramsHash(c.params)).toBe(c.params_hash);
    const [[key, value]] = [...initState(c.params)] as [[Uint8Array, Uint8Array]];
    expect(bytesToHex(key)).toBe(c.state_init.key);
    expect(bytesToHex(value)).toBe(c.state_init.value);
    expect(objectiveAccountId(c.params, c.code_hash)).toBe(c.account_id);
    expect(attestTgas(c.params)).toBe(c.attest_tgas);
    expect(closeTgas(c.params)).toBe(c.close_tgas);
    expect(validateParams(c.params)).toBeUndefined();
  });

  const rejected = readdirSync(join(root, "contracts/objective/tests/vectors/rejected"));
  test("rejected vectors exist", () => expect(rejected.length).toBeGreaterThan(0));
  // docs/spec.md, "Shares sum to exactly 100%"; docs/spec.md, "The evaluator holds no slot"; docs/spec.md, "Backups need a commit-by time"; docs/spec.md, "Only the Verifier relays signed calls"
  test.each(rejected)("refuses %s", (file) => {
    const params = read("contracts/objective/tests/vectors/rejected", file) as Params;
    expect(validateParams(params)).toBeDefined();
  });
});

interface Run {
  scenario: string;
  params: Params;
  spec?: unknown;
  reviews?: unknown[];
  steps: { events?: { event: string; data?: { review_hash?: string } }[] }[];
}

const resultsDir = process.env.E2E_RESULTS_DIR;
const runs: Run[] = resultsDir
  ? readdirSync(resultsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(resultsDir, f), "utf8")))
  : [];

describe.skipIf(!resultsDir)("documents attested on testnet", () => {
  const withSpec = runs.filter((r) => r.spec);
  test("results exist", () => expect(withSpec.length).toBeGreaterThan(0));
  test.each(withSpec.map((r) => [r.scenario, r] as const))("%s: spec and reviews hash as recorded", (_, run) => {
    const spec = parseSpec(run.spec);
    expect(specHash(spec)).toBe(run.params.spec_hash);
    const attested = new Set(
      run.steps
        .flatMap((s) => s.events ?? [])
        .map((e) => e.data?.review_hash)
        .filter(Boolean),
    );
    for (const r of run.reviews ?? []) expect(attested).toContain(reviewHash(parseReview(r, spec)));
  });
});

// docs/spec.md, "A schema is draft 2020-12"
describe("a schema names no dialect but draft 2020-12, as in crates/spec", () => {
  const withDialect = (dialect: unknown) => () => {
    const doc = structuredClone(vectors("spec.json")) as any;
    doc.criteria.find((c: any) => c.check.kind === "schema").check.json_schema.$schema = dialect;
    return parseSpec(doc);
  };
  test.each(["https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"])("%s is accepted", (named) => {
    expect(withDialect(named)).not.toThrow();
  });
  test.each([
    "http://json-schema.org/draft/2020-12/schema",
    "https://json-schema.org/draft/2020-12/schema##",
    "https://json-schema.org/draft/2019-09/schema",
    "http://json-schema.org/draft-07/schema#",
    "https://example.org/my-dialect",
    "HTTPS://JSON-SCHEMA.ORG/draft/2020-12/schema",
    "",
    5,
    null,
  ])("%j is refused", (other) => {
    expect(withDialect(other)).toThrow(/attendance-json/);
  });
});

describe("blank text means Unicode White_Space, as in crates/spec", () => {
  const withText = (patch: (doc: any) => void) => {
    const doc = structuredClone(vectors("spec.json")) as any;
    patch(doc);
    return () => parseSpec(doc);
  };
  const fields: [string, (doc: any, v: string) => void][] = [
    ["statement", (d, v) => (d.statement = v)],
    ["criterion description", (d, v) => (d.criteria[0].description = v)],
    ["live_url label", (d, v) => (d.criteria[0].check.label = v)],
    ["live_url must_contain", (d, v) => (d.criteria[0].check.must_contain = v)],
    ["contains phrase", (d, v) => (d.criteria[5].check.phrase = v)],
    ["numeric_match label", (d, v) => (d.criteria[1].check.label = v)],
    ["llm_judge question", (d, v) => (d.criteria[8].check.question = v)],
  ];
  test.each(fields)("%s: U+0085, U+00A0 and U+3000 alone are empty", (_, set) => {
    for (const blank of ["\u0085", "\u00a0", "\u3000", " \t\n"]) expect(withText((d) => set(d, blank)), JSON.stringify(blank)).toThrow(/empty/);
  });
  test.each(fields)("%s: U+FEFF, U+200B and U+180E alone are text", (_, set) => {
    for (const kept of ["\ufeff", "\u200b", "\u180e"]) expect(withText((d) => set(d, kept)), JSON.stringify(kept)).not.toThrow();
  });
});
