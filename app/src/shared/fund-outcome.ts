/**
 * What a funding transaction did, read from its receipts rather than
 * inferred from a timer: the objective's own receipt either logged a
 * `funded` event, ran without one (the objective refused, and the Verifier
 * refunds), or is not in the outcome at all (not executed yet, or not
 * reported): unknown, which must never be resent blindly.
 */
import { objectiveEvents, objectiveReceipts, type TxOutcome } from "./receipts.ts";

export type FundOutcome = { kind: "funded" } | { kind: "refused"; reason: string } | { kind: "unknown" };

export function classifyFund(o: TxOutcome, objective: string): FundOutcome {
  if (objectiveEvents(o, objective).some((e) => e.event === "funded")) return { kind: "funded" };
  const own = objectiveReceipts(o, objective);
  // A later resolver may fail after the objective accepted funds. The
  // objective's successful receipt therefore wins over the top-level status.
  if (own.length === 0) {
    if (o.final_execution_status === "FINAL" && o.status && typeof o.status === "object" && "Failure" in o.status)
      return { kind: "refused", reason: "the funding transaction failed before the objective accepted it" };
    return { kind: "unknown" };
  }
  const failure = own.map((r) => r.outcome.status as { Failure?: unknown }).find((s) => s && typeof s === "object" && "Failure" in s);
  return {
    kind: "refused",
    reason: failure ? `the objective failed: ${JSON.stringify(failure.Failure).slice(0, 200)}` : "the objective did not accept the funding",
  };
}
