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

import { attestTgas } from "../src/shared/attest.ts";
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

  const rejected = readdirSync(join(root, "crates/spec/tests/vectors/rejected"));
  test("every rejected vector is covered", () => expect(rejected.length).toBeGreaterThan(0));
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
    expect(validateParams(c.params)).toBeUndefined();
  });

  const rejected = readdirSync(join(root, "contracts/objective/tests/vectors/rejected"));
  test("rejected vectors exist", () => expect(rejected.length).toBeGreaterThan(0));
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
