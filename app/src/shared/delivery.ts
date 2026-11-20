import { objectiveEvents, type TxOutcome } from "./receipts.ts";
import { reportHash, type Delivered } from "./review.ts";
import type { Params } from "./params.ts";
import { contributorsInOrder } from "./params.ts";

/** The report hash this transaction's successful `delivered` event committed for `contributor`, if any. */
export function deliveryHash(outcome: TxOutcome, objective: string, contributor: string): string | undefined {
  const hash = objectiveEvents(outcome, objective).find((e) => e.event === "delivered" && e.data?.contributor === contributor)?.data?.hash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
}

export function holders(params: Params, taken = 0): string[] {
  return contributorsInOrder(params).map(([account], i) => {
    if (!((taken >> i) & 1)) return account;
    const backup = params.backups?.[account];
    if (!backup) throw new Error("The objective has an invalid backup slot");
    return backup;
  });
}

/**
 * The slot `account` holds, or may take now, by its index in contributor
 * order: its own as a listed contributor, the one it took as a backup, or,
 * once `commit_by` has passed, an uncommitted slot it backs. -1 for none.
 */
export function slotOf(params: Params, state: { committed?: number; taken?: number } | undefined, account: string, now: number): number {
  const held = holders(params, state?.taken).indexOf(account);
  if (held >= 0) return held;
  if (!params.commit_by || Date.parse(params.commit_by) >= now) return -1;
  return contributorsInOrder(params).findIndex(
    ([original], i) => !(((state?.committed ?? 0) >> i) & 1) && params.backups?.[original] === account,
  );
}

/** Who holds each slot whose delivery is on chain, in contributor order. */
export const deliveredBy = (params: Params, state?: { delivered?: number; taken?: number }): string[] =>
  holders(params, state?.taken).filter((_, i) => ((state?.delivered ?? 0) >> i) & 1);

/** Each report is from a slot whose delivery is on chain, at most once, with the hash that delivery committed. */
export function verifyReports(expected: string[], delivered: Delivered[]): void {
  if (
    new Set(delivered.map((d) => d.contributor)).size !== delivered.length ||
    delivered.some((d) => !expected.includes(d.contributor) || d.delivery_hash !== reportHash(d.text))
  )
    throw new Error("Every judged report must be the exact one its on-chain delivery committed, once per slot.");
}
