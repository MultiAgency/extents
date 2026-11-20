/** Observe the wallet response before near-kit waits on RPC finality. A later
 * status lookup can fail even though the wallet already returned a usable hash. */
import type { WalletConnection } from "near-kit";
import { VERIFIER } from "../shared/config.ts";

const funding = new Map<string, (hash: string) => void>();

export function trackFunding(objective: string, submitted: (hash: string) => void): () => void {
  if (funding.has(objective)) throw new Error("This objective already has an active funding request");
  funding.set(objective, submitted);
  return () => {
    funding.delete(objective);
  };
}

export function observeWallet(wallet: WalletConnection): WalletConnection {
  return {
    ...wallet,
    async signAndSendTransaction(params) {
      const outcome = await wallet.signAndSendTransaction(params);
      if (params.receiverId === VERIFIER && outcome.transaction?.hash) {
        for (const action of params.actions) {
          if (!("functionCall" in action) || action.functionCall.methodName !== "mt_transfer_call") continue;
          const raw = action.functionCall.args;
          let args: { receiver_id?: string };
          try {
            args = JSON.parse(new TextDecoder().decode(raw));
          } catch {
            continue;
          }
          if (args.receiver_id) funding.get(args.receiver_id)?.(outcome.transaction.hash);
        }
      }
      return outcome;
    },
  };
}
