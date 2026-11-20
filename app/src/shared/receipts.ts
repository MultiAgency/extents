/**
 * Reading what a finalized transaction did from its receipts. Only a
 * successful receipt's logs count: a receipt that fails keeps the logs it
 * wrote before failing (an objective can log `funded`, then run out of gas
 * and be reverted), so an event in a failed receipt never happened.
 */
interface ReceiptOutcome {
  outcome: { executor_id: string; logs: string[]; status: unknown };
}

export interface TxOutcome {
  transaction?: { signer_id?: string; hash?: string };
  receipts_outcome?: ReceiptOutcome[];
  status?: unknown;
  final_execution_status?: string;
}

export interface ObjectiveEvent {
  event: string;
  data?: Record<string, unknown>;
}

const EVENT = "EVENT_JSON:";

export const succeeded = (status: unknown): boolean =>
  typeof status === "object" && status !== null && ("SuccessValue" in status || "SuccessReceiptId" in status);

/** The objective's receipts in this transaction. */
export const objectiveReceipts = (outcome: TxOutcome, objective: string): ReceiptOutcome[] =>
  (outcome.receipts_outcome ?? []).filter((r) => r.outcome.executor_id === objective);

/** `extents-objective` events logged by the objective's successful receipts. */
export function objectiveEvents(outcome: TxOutcome, objective: string): ObjectiveEvent[] {
  return objectiveReceipts(outcome, objective)
    .filter((r) => succeeded(r.outcome.status))
    .flatMap((r) => r.outcome.logs)
    .flatMap((log) => {
      if (!log.startsWith(EVENT)) return [];
      try {
        const e = JSON.parse(log.slice(EVENT.length)) as { standard?: string } & ObjectiveEvent;
        return e.standard === "extents-objective" && typeof e.event === "string" ? [e] : [];
      } catch {
        return []; // unrelated logs
      }
    });
}
