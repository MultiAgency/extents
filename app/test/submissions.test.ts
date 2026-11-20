import { expect, test } from "vitest";
import type { WalletConnection } from "near-kit";
import { observeWallet, trackFunding } from "../src/web/submissions.ts";
import { VERIFIER } from "../src/shared/config.ts";

test("wallet submission identity is recorded before any downstream finality lookup", async () => {
  const order: string[] = [];
  const wallet = observeWallet({
    getAccounts: async () => [],
    signAndSendTransaction: async () => {
      order.push("wallet submitted");
      return { transaction: { hash: "SUBMITTED", signer_id: "sponsor.testnet" } } as never;
    },
  });
  const stop = trackFunding("objective.testnet", (hash) => order.push(`persist ${hash}`));
  try {
    await wallet.signAndSendTransaction({
      receiverId: VERIFIER,
      actions: [
        {
          functionCall: {
            methodName: "mt_transfer_call",
            args: new TextEncoder().encode(JSON.stringify({ receiver_id: "objective.testnet" })),
            gas: 1n,
            deposit: 1n,
          },
        },
      ],
    });
    order.push("RPC lookup failed");
    expect(order).toEqual(["wallet submitted", "persist SUBMITTED", "RPC lookup failed"]);
  } finally {
    stop();
  }
});

test("unrelated methods and receivers cannot supply a funding hash", async () => {
  let called = false;
  const base: WalletConnection = {
    getAccounts: async () => [],
    signAndSendTransaction: async () => ({ transaction: { hash: "UNRELATED" } }) as never,
  };
  const stop = trackFunding("objective.testnet", () => {
    called = true;
  });
  try {
    const wallet = observeWallet(base);
    for (const [receiverId, methodName] of [
      ["other.testnet", "mt_transfer_call"],
      [VERIFIER, "mt_transfer"],
    ])
      await wallet.signAndSendTransaction({
        receiverId: receiverId!,
        actions: [
          {
            functionCall: {
              methodName: methodName!,
              args: new TextEncoder().encode(JSON.stringify({ receiver_id: "objective.testnet" })),
              gas: 1n,
              deposit: 1n,
            },
          },
        ],
      });
    expect(called).toBe(false);
  } finally {
    stop();
  }
});
