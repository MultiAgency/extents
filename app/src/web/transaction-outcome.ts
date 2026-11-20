import { RPC_URL } from "../shared/config.ts";
import type { TxOutcome } from "../shared/receipts.ts";

/** Keep receipt outcomes even when the final result is Failure. SDK error
 * conversion can otherwise discard evidence of an earlier successful receipt. */
export async function finalOutcome(hash: string, signer: string, send = fetch, what = "funding"): Promise<TxOutcome> {
  const response = await send(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: what,
      method: "tx",
      params: {
        tx_hash: hash,
        sender_account_id: signer,
        wait_until: "FINAL",
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`The earlier ${what} outcome could not be read; no replacement was sent`);
  const body = await response.json();
  const outcome = body.result as TxOutcome | undefined;
  if (
    body.error ||
    outcome?.final_execution_status !== "FINAL" ||
    outcome.transaction?.hash !== hash ||
    outcome.transaction.signer_id !== signer
  )
    throw new Error(`The earlier ${what} outcome is not finalized; no replacement was sent`);
  return outcome;
}
