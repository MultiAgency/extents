/**
 * The objective as it takes shape in the conversation: the agent's shared
 * state, streamed to the page as AG-UI `STATE_SNAPSHOT`s and drawn as the
 * objective canvas. Display state only: what gets signed is always rebuilt
 * from the launch proposal and checked again.
 */
import { z } from "zod";

import { accountId } from "./spec.ts";

const criterion = z.object({ id: z.string(), kind: z.string(), description: z.string() });

export const draftTerms = z.object({
  statement: z.string().optional(),
  criteria: z.array(criterion).optional(),
  /** Whether the last spec checked out, and why not. */
  specValid: z.boolean().optional(),
  specError: z.string().optional(),
  /** Contributor to percent. */
  contributors: z.record(z.string(), z.number()).optional(),
  evaluator: z.string().optional(),
  deadline: z.string().optional(),
  amount: z.string().optional(),
  acceptance_hours: z.number().optional(),
});

export const draftState = z.object({
  terms: draftTerms.default({}),
  /** Accounts the agent checked, and whether each exists. */
  accounts: z.record(z.string(), z.boolean()).default({}),
  /** The customer's USDC on the Verifier, as last read. */
  balance: z.string().optional(),
});

export type DraftState = z.infer<typeof draftState>;

export const emptyDraft = (): DraftState => ({ terms: {}, accounts: {} });

/** The page's copy of the draft, if it parses; anything else starts afresh. */
export const parseDraft = (raw: unknown): DraftState => {
  const parsed = draftState.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyDraft();
};

/** What `update_draft` accepts: any terms the customer has stated, never the spec (that goes through propose_spec). */
export const draftUpdate = z.strictObject({
  contributors: z.record(accountId, z.number().positive()).optional(),
  evaluator: accountId.optional(),
  deadline: z.string().optional(),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "a decimal number of tokens")
    .optional(),
  acceptance_hours: z.number().int().positive().optional(),
  statement: z.string().min(3).optional(),
});
