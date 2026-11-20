/**
 * Filing an attestation with a DAO evaluator exactly once. The DAO is the
 * record: before filing, its proposals are searched for one that makes this
 * exact `ob_attest` call and is still open or already approved. A marker
 * persisted before the wallet is asked, held under a Web Lock, blocks a
 * second filing (and a second bond) while the first one's outcome is unknown:
 * a lost response, another tab, or a proposal not yet visible. Only the
 * filing transaction's final receipts lift the marker: the DAO's receipt
 * either returned the new proposal's id or failed. Time passing proves
 * nothing, so it never does.
 */
import type { Near } from "near-kit";

import type { attestProposal } from "../shared/attest.ts";
import type { Call } from "../shared/calls.ts";
import { jcsHash } from "../shared/jcs.ts";
import type { TxOutcome } from "../shared/receipts.ts";
import { isWalletRejection, sentTransaction, sign, withTabLock } from "./send.ts";
import { finalOutcome } from "./transaction-outcome.ts";

type Filing = ReturnType<typeof attestProposal>;

interface Reader {
  view<T>(contractId: string, method: string, args?: object): Promise<T | undefined>;
}

interface Proposal {
  id: number;
  status: string;
  kind: { FunctionCall?: { receiver_id: string; actions: { method_name: string; args: string; gas: string; deposit: string }[] } };
}

const PAGE = 100;

/** The ids of the DAO's open or approved proposals making exactly this call, oldest first: two means a duplicate. */
export async function findFiled(near: Reader, dao: string, filing: Filing): Promise<number[]> {
  const found: number[] = [];
  const call = filing.proposal.kind.FunctionCall;
  const next = (await near.view<number>(dao, "get_last_proposal_id", {})) ?? 0;
  // newest first: a filing to find is almost always recent
  for (let end = next; end > 0; end -= PAGE) {
    const from = Math.max(0, end - PAGE);
    const page = (await near.view<Proposal[]>(dao, "get_proposals", { from_index: from, limit: end - from })) ?? [];
    for (const p of page.reverse()) {
      const fc = p.kind.FunctionCall;
      if (
        (p.status === "InProgress" || p.status === "Approved") &&
        fc?.receiver_id === call.receiver_id &&
        fc.actions.length === 1 &&
        fc.actions[0]!.method_name === "ob_attest" &&
        fc.actions[0]!.args === call.actions[0]!.args &&
        fc.actions[0]!.gas === call.actions[0]!.gas &&
        fc.actions[0]!.deposit === call.actions[0]!.deposit
      )
        found.unshift(p.id);
    }
  }
  return found;
}

export const filingKey = (dao: string, filing: Filing) => `extents:dao-attest:${dao}:${jcsHash(filing.proposal.kind)}`;

/** A filing this browser sent and hasn't seen settled: when, and its transaction once the wallet named one. */
export interface Unresolved {
  at: number;
  tx?: string;
}

export function unresolved(key: string): Unresolved | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<Unresolved> | null;
    return v && Number.isFinite(v.at) ? { at: v.at!, ...(typeof v.tx === "string" ? { tx: v.tx } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** Persisted before the wallet is asked; throws rather than send unrecorded. */
export function markUnresolved(key: string, value: Unresolved): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function clearUnresolved(key: string): void {
  localStorage.removeItem(key);
}

/**
 * Allows another filing after the user accepts the duplicate-bond risk.
 * The DAO's proposals remain the record of any duplicates.
 */
export function setAside(key: string): void {
  clearUnresolved(key);
}

export type FilingOutcome = { kind: "filed"; id: number } | { kind: "failed" } | { kind: "unknown" };

/** What the filing did, from the DAO's own receipt: the id it returned, a failure, or not known yet. */
export function classifyFiling(outcome: TxOutcome, dao: string): FilingOutcome {
  const status = outcome.receipts_outcome?.find((r) => r.outcome.executor_id === dao)?.outcome.status as
    { SuccessValue?: string; Failure?: unknown } | undefined;
  if (status?.Failure !== undefined) return { kind: "failed" };
  if (typeof status?.SuccessValue === "string") {
    const id = Number(atob(status.SuccessValue));
    if (Number.isInteger(id) && id >= 0) return { kind: "filed", id };
  }
  return { kind: "unknown" };
}

/** A filing from this browser with no transaction to settle it by: only the DAO showing it, or an explicit set-aside, unblocks it. */
export class HashlessFiling extends Error {}

/**
 * Files `call` (a `calls.propose`) at most once and returns the ids of the
 * DAO proposals that carry it, oldest first: more than one is a duplicate.
 * Throws when it can't be sure: an earlier filing unsettled, or this one's
 * outcome unknown. Nothing is resent in either case.
 */
export async function fileAttestation(near: Near, signer: string, call: Call): Promise<number[]> {
  const dao = call.receiver;
  const filing = call.args as Filing;
  const key = filingKey(dao, filing);
  /** Filed: the DAO's search also shows any duplicate, such as a set-aside filing that landed too. */
  const settled = async (ids: number[]) => {
    clearUnresolved(key);
    const onDao = await findFiled(near, dao, filing).catch(() => []);
    return [...new Set([...onDao, ...ids])].sort((a, b) => a - b);
  };
  let ids: number[] = [];
  await withTabLock(key, "This proposal is being filed in another tab. Wait for it to finish.", async () => {
    const onDao = await findFiled(near, dao, filing);
    if (onDao.length) {
      ids = await settled(onDao);
      return;
    }
    const earlier = unresolved(key);
    if (earlier) {
      if (!earlier.tx)
        throw new HashlessFiling(
          "A filing of this proposal from this browser has no transaction hash and isn't on the DAO, so no second one (and second bond) was sent.",
        );
      const result = classifyFiling(await finalOutcome(earlier.tx, signer, fetch, "proposal"), dao);
      if (result.kind === "filed") {
        ids = await settled([result.id]);
        return;
      }
      if (result.kind === "unknown") throw new Error(`The earlier filing (${earlier.tx}) hasn't settled yet; no second one was sent.`);
      clearUnresolved(key); // the DAO refused it, so its bond came back and nothing was filed
    }
    markUnresolved(key, { at: Date.now() });
    let outcome: TxOutcome;
    try {
      outcome = await sign(near, signer, call, "FINAL");
    } catch (e) {
      const tx = sentTransaction(e);
      if (tx) markUnresolved(key, { at: Date.now(), tx });
      // a refusal in the wallet sent nothing; anything else may have been sent
      else if (isWalletRejection(e)) clearUnresolved(key);
      throw e;
    }
    if (outcome.transaction?.hash) markUnresolved(key, { at: Date.now(), tx: outcome.transaction.hash });
    const result = classifyFiling(outcome, dao);
    if (result.kind === "failed") {
      clearUnresolved(key);
      throw new Error(`${dao} refused the proposal; nothing was filed and its bond was returned.`);
    }
    if (result.kind === "unknown") throw new Error("The proposal was sent but its outcome isn't known yet; no second one will be sent.");
    ids = await settled([result.id]);
  });
  return ids;
}
