/**
 * From check results to the evaluator's review (`crates/spec`'s format): the
 * verdict the results support, and the review document whose hash the
 * evaluator attests. Shared so the browser recomputes the hash it signs
 * instead of trusting the server's.
 */
import { sha256Hex } from "./jcs.ts";
import { specHash, validateReview, VERSION, type Review, type Spec } from "./spec.ts";

export type LlmCall = Review["llm_calls"][number];

export type CheckResult = Review["results"][number] & {
  /** The model calls behind an `llm_judge` result, one per model, with their receipts. */
  calls?: LlmCall[];
  /** Skipped because something the contributor cited couldn't be reached: the retry rule may turn it into a fail. */
  unavailable?: true;
};

export interface CheckSummary {
  passed: number;
  failed: number;
  skipped: number;
  /** The verdict these results support: achieved needs every criterion to pass, failed needs one to fail. */
  verdict: "achieved" | "failed" | "undecided";
}

export function summarize(results: CheckResult[]): CheckSummary {
  const count = (o: CheckResult["outcome"]) => results.filter((r) => r.outcome === o).length;
  const passed = count("pass"),
    failed = count("fail"),
    skipped = count("skipped");
  return { passed, failed, skipped, verdict: failed > 0 ? "failed" : skipped > 0 || passed === 0 ? "undecided" : "achieved" };
}

/** A contributor's delivered report, as published on FastData. */
export interface Delivered {
  contributor: string;
  text: string;
  /** Verified against a finalized successful `delivered` event, never a publisher's claim. */
  delivery_hash?: string;
  delivery_tx?: string;
  delivery_signer?: string;
}

/** A report's hash, as `ob_deliver` commits to it and the review names it. */
export const reportHash = (text: string): string => sha256Hex(text);

/**
 * The review of these results, in spec order, or `undefined` while they
 * support no verdict. Throws if the review would not validate.
 */
export function buildReview(
  objective: string,
  spec: Spec,
  delivered: Delivered[],
  results: CheckResult[],
  missing: string[] = [],
): Review | undefined {
  // a slot with no report fails the objective on its own; otherwise the results decide
  const verdict = missing.length ? "failed" : summarize(results).verdict;
  if (verdict === "undecided") return undefined;
  const byId = new Map(results.map((r) => [r.criterion_id, r]));
  const ordered = spec.criteria.flatMap((c) => byId.get(c.id) ?? []);
  const review: Review = {
    v: VERSION,
    objective,
    spec_hash: specHash(spec),
    deliverables: delivered.map((d) => ({ contributor: d.contributor, sha256: reportHash(d.text) })),
    // omitted when empty: a document has one canonical form
    ...(missing.length ? { missing } : {}),
    results: ordered.map(({ criterion_id, outcome, detail, evidence }) => ({ criterion_id, outcome, detail, evidence })),
    llm_calls: ordered.flatMap((r) => r.calls ?? []),
    verdict,
  };
  validateReview(review, spec);
  return review;
}
