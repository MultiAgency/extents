/**
 * Sending a transaction from the browser at most once: a lock across tabs,
 * the wallet's refusal (nothing was sent) told apart from every other
 * failure (something may have been sent), and the transaction a failed send
 * still named. Shared by funding a launch and filing a DAO proposal.
 */
import { Amount, type Near } from "near-kit";

import { calls, type Call } from "../shared/calls.ts";
import { DOCUMENT_KEYS, FASTDATA_URL, type DocumentName } from "../shared/config.ts";
import { jcsHash } from "../shared/jcs.ts";
import type { TxOutcome } from "../shared/receipts.ts";

/** Runs `run` only while no other tab of this browser holds `key`. */
export async function withTabLock(key: string, busy: string, run: () => Promise<void>): Promise<void> {
  if (!navigator.locks) throw new Error("This browser can't keep two tabs from sending twice. Use a browser with Web Locks support.");
  await navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error(busy);
    await run();
  });
}

/** The wallet refused to sign, so nothing was sent. */
export const isWalletRejection = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "code" in e && [4001, "ACTION_REJECTED"].includes(e.code as string | number);

/** The transaction a failed send still names, if it does. */
export const sentTransaction = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "transactionHash" in e && typeof e.transactionHash === "string" ? e.transactionHash : undefined;

/**
 * Signs and sends one call. near-kit types its result as its own outcome
 * type; this is the one place it is read as ours.
 */
export async function sign(near: Near, signer: string, call: Call, waitUntil?: "FINAL"): Promise<TxOutcome> {
  const opts = { gas: `${call.tgas} Tgas`, ...(call.yocto !== undefined ? { attachedDeposit: Amount.yocto(call.yocto) } : {}) } as const;
  const tx = near.transaction(signer).functionCall(call.receiver, call.method, call.args, opts);
  return (await (waitUntil ? tx.send({ waitUntil }) : tx.send())) as unknown as TxOutcome;
}

/** A transaction's final outcome through the wallet's RPC, read as ours. */
export async function finalStatus(near: Near, hash: string, signer: string): Promise<TxOutcome> {
  return (await near.getTransactionStatus(hash, signer, "FINAL")) as unknown as TxOutcome;
}

/**
 * Publishes `value` with FastData under `objective`. Its receipt fails by
 * design (see `calls.publish`); only other failures are errors.
 */
export async function publishFastData(
  near: Near,
  signer: string,
  objective: string,
  documents: Parameters<typeof calls.publish>[1],
  check?: (outcome: TxOutcome) => void,
) {
  try {
    const outcome = await sign(near, signer, calls.publish(objective, documents));
    check?.(outcome);
  } catch (e) {
    if (/MethodNotFound|MethodResolveError/.test(e instanceof Error ? e.message : String(e))) return;
    // A refusal the wallet codes as one sent nothing. Some wallets word the by-design failure as a cancellation
    // instead ("Action was cancelled"); then what FastData indexed decides: every row from this signer, exactly as sent.
    if (isWalletRejection(e) || !(await indexed(signer, objective, documents))) throw e;
  }
}

/** Whether FastData shows each document from `signer` under `objective`, byte for byte, within about ten seconds. */
async function indexed(signer: string, objective: string, documents: Parameters<typeof calls.publish>[1]): Promise<boolean> {
  const wanted = Object.entries(documents).map(([name, value]) => ({ key: DOCUMENT_KEYS[name as DocumentName], hash: jcsHash(value) }));
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000));
    try {
      const found = await Promise.all(
        wanted.map(async ({ key, hash }) => {
          const res = await fetch(`${FASTDATA_URL}/v0/latest/${objective}/${signer}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key, limit: 1 }),
          });
          if (!res.ok) return false;
          const { entries } = (await res.json()) as { entries?: { predecessor_id: string; key: string; value: unknown }[] };
          return (entries ?? []).some((r) => r.predecessor_id === signer && r.key === key && jcsHash(r.value) === hash);
        }),
      );
      if (found.every(Boolean)) return true;
    } catch {
      // an unreachable indexer proves nothing either way
    }
  }
  return false;
}
