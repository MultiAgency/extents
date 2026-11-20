/**
 * The server-side tools, one implementation shared by the customer agent's
 * loop and the agent API (`/api/tools/:name`): input is checked by each tool's schema before
 * the tool runs.
 */
import { z } from "zod";

import { TOKEN } from "../shared/config.ts";
import { draftUpdate } from "../shared/draft.ts";
import { formatUnits } from "../shared/objective.ts";
import { accountId, spec, specHash, validateAppSpec } from "../shared/spec.ts";

/** What the tools read from the chain; injected so tests run without one. */
export interface Chain {
  accountExists(accountId: string, signal?: AbortSignal): Promise<boolean>;
  verifierBalance(accountId: string, signal?: AbortSignal): Promise<bigint>;
  describeObjective(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<{ deployed: boolean; state?: { funded?: string; committed?: number; delivered?: number } } & Record<string, unknown>>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface ServerTool {
  description: string;
  input: z.ZodType;
  run(input: never, chain: Chain, signal?: AbortSignal): Promise<unknown>;
}

export const SERVER_TOOLS: Record<string, ServerTool> = {
  propose_spec: {
    description:
      "Check a draft spec: the statement and the criteria the evaluator will judge against. Returns errors to fix, or the spec's hash.",
    input: spec,
    run: async (s: z.infer<typeof spec>) => {
      try {
        validateAppSpec(s);
        return { ok: true, spec_hash: specHash(s) };
      } catch (e) {
        return { ok: false, error: errorText(e) };
      }
    },
  },
  check_accounts: {
    description: "Check that NEAR testnet accounts exist, before naming them as contributors or evaluator.",
    input: z.object({ accounts: z.array(z.string()).min(1).max(12) }),
    run: async ({ accounts }: { accounts: string[] }, chain, signal) =>
      Object.fromEntries(
        await Promise.all(accounts.map(async (a) => [a, accountId.safeParse(a).success && (await chain.accountExists(a, signal))])),
      ),
  },
  verifier_balance: {
    description: `An account's ${TOKEN.symbol} on the Verifier, e.g. what the customer has available to fund an objective.`,
    input: z.object({ account: accountId }),
    run: async ({ account }: { account: string }, chain, signal) => ({
      [TOKEN.symbol]: formatUnits(await chain.verifierBalance(account, signal)),
    }),
  },
  update_draft: {
    description:
      "Record terms the customer has stated (budget, deadline, contributors and their percent, evaluator, acceptance window, the outcome in one sentence) as soon as they state them. The customer watches the objective take shape from these. Send only what changed.",
    input: draftUpdate,
    run: async () => ({ ok: true }),
  },
  view_objective: {
    description: "The current state of a launched objective: its terms, funding, commitments, deliveries and outcome.",
    input: z.object({ objective: accountId }),
    run: async ({ objective }: { objective: string }, chain, signal) => chain.describeObjective(objective, signal),
  },
};
