/**
 * Sending a transaction from the browser at most once: a lock across tabs,
 * the wallet's refusal (nothing was sent) told apart from every other
 * failure (something may have been sent), and the transaction a failed send
 * still named. Shared by funding a launch and filing a DAO proposal.
 */
import { Amount, type Near } from "near-kit";

import { calls, type Call } from "../shared/calls.ts";
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

/** Publishes `documents` with FastData under `objective`, which accepts the call as a no-op. */
export async function publishFastData(
  near: Near,
  signer: string,
  objective: string,
  documents: Parameters<typeof calls.publish>[1],
  check?: (outcome: TxOutcome) => void,
) {
  const outcome = await sign(near, signer, calls.publish(objective, documents));
  check?.(outcome);
}
