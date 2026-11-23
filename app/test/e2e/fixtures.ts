/**
 * Browser test fixtures: a fake wallet whose transactions the test records,
 * and a simulated chain, both surviving reloads.
 */
import { test as base, type Page } from "@playwright/test";

import { FASTDATA_URL } from "../../src/shared/config.ts";

/** Fixed wall time; timers still run normally for streaming and retry behavior. */
export const BROWSER_NOW = "2027-01-01T00:00:00Z";
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.clock.setFixedTime(new Date(BROWSER_NOW));
    await use(page);
  },
});

interface Call {
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  opts: Record<string, unknown>;
}

/** The simulated chain: what the wallet sent, and what the objective shows. */
export interface Chain {
  txs: { signer: string; calls: Call[] }[];
  published: boolean;
  funded: boolean;
  /** The next send with this method is refused in the wallet. */
  reject?: string;
  uncertain?: string;
  holdFunding?: Promise<void>;
  /** The evaluator DAO's proposals: each add_proposal files one. */
  proposals?: { id: number; status: string; kind: unknown }[];
  /** While true, filed proposals don't show in the DAO's views yet. */
  proposalsHidden?: boolean;
  /** Proposals show once this many are filed. */
  revealAt?: number;
  /** The DAO refuses the next add_proposal: its receipt fails and nothing is filed. */
  refuseProposal?: boolean;
  /** A lost response still names its transaction, as near-kit's errors can. */
  uncertainWithHash?: boolean;
}

export async function setup(
  page: Page,
  chain: Chain = { txs: [], published: false, funded: false },
  account = "customer.testnet",
): Promise<Chain> {
  await page.addInitScript((accountId: string) => {
    const outcomes: Record<string, unknown> = {};
    Object.assign(window, {
      __EXTENTS_TEST_WALLET__: {
        accountId,
        near: {
          async view(contract: string, method: string, args: unknown) {
            return (await fetch("/__view", { method: "POST", body: JSON.stringify({ contract, method, args }) })).json();
          },
          async getTransactionStatus(hash: string, signer: string) {
            if (outcomes[hash]) return outcomes[hash];
            return (await fetch(`/__tx?hash=${encodeURIComponent(hash)}&signer=${encodeURIComponent(signer)}`)).json();
          },
          transaction(signer: string) {
            const calls: { receiver: string; method: string; args: { receiver_id?: string } }[] = [];
            const builder = {
              functionCall(receiver: string, method: string, args: never, opts: unknown) {
                calls.push({ receiver, method, args, opts } as never);
                return builder;
              },
              async send() {
                const verdict = (await (await fetch("/__wallet", { method: "POST", body: JSON.stringify({ signer, calls }) })).json()) as {
                  reject: boolean;
                  uncertain?: boolean;
                  hash?: string;
                  proposal?: number | null;
                };
                if (verdict.reject) throw Object.assign(new Error("User rejected the request"), { code: 4001 });
                if (verdict.uncertain)
                  throw Object.assign(
                    new Error("Connection closed before the outcome was received"),
                    verdict.hash ? { transactionHash: verdict.hash } : {},
                  );
                const call = calls[0]!;
                if (call.method === "add_proposal")
                  return {
                    transaction: { hash: "TX-add_proposal", signer_id: signer },
                    receipts_outcome: [
                      {
                        outcome: {
                          executor_id: call.receiver,
                          logs: [],
                          status:
                            verdict.proposal === null ? { Failure: { ActionError: {} } } : { SuccessValue: btoa(String(verdict.proposal)) },
                        },
                      },
                    ],
                  };
                // like a real wallet: the FastData write's receipt fails by design
                if (call.method === "__fastdata_kv") throw new Error("MethodResolveError(MethodNotFound)");
                const objective = call.args.receiver_id ?? call.receiver;
                const outcome = {
                  transaction: { hash: `TX-${call.method}`, signer_id: signer },
                  receipts_outcome: [
                    { outcome: { executor_id: "verifier.tidepool-sandbox.testnet", logs: [], status: { SuccessValue: "" } } },
                    {
                      outcome: {
                        executor_id: objective,
                        logs: [
                          call.method === "ob_deliver"
                            ? `EVENT_JSON:${JSON.stringify({ standard: "extents-objective", event: "delivered", data: { contributor: signer, hash: (call.args as any).delivery.hash } })}`
                            : 'EVENT_JSON:{"standard":"extents-objective","version":"0.1.0","event":"funded","data":{}}',
                        ],
                        status: { SuccessValue: "" },
                      },
                    },
                  ],
                };
                outcomes[`TX-${call.method}`] = outcome;
                return outcome;
              },
            };
            return builder;
          },
        },
      },
    });
  }, account);
  await page.route("**/__wallet", async (r) => {
    const tx = r.request().postDataJSON() as Chain["txs"][number];
    const method = tx.calls[0]!.method;
    if (chain.reject === method) {
      chain.reject = undefined;
      return r.fulfill({ json: { reject: true } });
    }
    chain.txs.push(tx);
    if (method === "__fastdata_kv") chain.published = true;
    let proposal: number | null | undefined;
    if (method === "add_proposal") {
      chain.proposals ??= [];
      if (chain.refuseProposal) {
        chain.refuseProposal = false;
        proposal = null;
      } else {
        const kind = (tx.calls[0]!.args as { proposal: { kind: unknown } }).proposal.kind;
        proposal = chain.proposals.length;
        chain.proposals.push({ id: proposal, status: "InProgress", kind });
        if (chain.revealAt === chain.proposals.length) chain.proposalsHidden = false;
      }
    }
    if (chain.uncertain === method) {
      chain.uncertain = undefined;
      return r.fulfill({ json: { reject: false, uncertain: true, ...(chain.uncertainWithHash ? { hash: `TX-${method}` } : {}) } });
    }
    if (proposal !== undefined) return r.fulfill({ json: { reject: false, proposal } });
    if (method === "mt_transfer_call") {
      await chain.holdFunding;
      chain.funded = true;
    }
    return r.fulfill({ json: { reject: false } });
  });
  await page.route("**/__view", async (r) => {
    const { method, args } = r.request().postDataJSON() as { method: string; args: { from_index?: number; limit?: number } };
    const visible = chain.proposalsHidden ? [] : (chain.proposals ?? []);
    if (method === "get_last_proposal_id") return r.fulfill({ json: visible.length });
    if (method === "get_proposals")
      return r.fulfill({ json: visible.slice(args.from_index ?? 0, (args.from_index ?? 0) + (args.limit ?? 100)) });
    return r.fulfill({ status: 404, json: null });
  });
  await page.route("**/api/deploy", (r) => r.fulfill({ json: { accountId: "deployed", txHash: "DEPLOYTX" } }));
  // the page's own FastData reads (a publish's read-back) stay off the network: nothing is indexed here
  await page.route(`${FASTDATA_URL}/**`, (r) => r.fulfill({ json: { entries: [] } }));
  await page.route("**/api/objective/**", (r) =>
    r.fulfill({
      json: {
        deployed: true,
        ...(chain.published ? { documents: { spec: { statement: "s", criteria: [] } } } : {}),
        state: { funded: chain.funded ? "5000000" : "0" },
        verifier_balance: chain.funded ? "5000000" : "0",
      },
    }),
  );
  return chain;
}

export const send = async (page: Page, text: string) => {
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
};
