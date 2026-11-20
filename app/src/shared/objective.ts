/**
 * From what a customer asks for to exactly what gets deployed and signed.
 * Runs in the browser and on the server alike, so the card a customer
 * approves shows the same `Params` and address the chain will see.
 */
import { z } from "zod";

import { PARAMS_TOKEN, TOKEN, VERIFIER } from "./config.ts";
import { objectiveAccountId, PIPS_MAX, timestampNanos, validateParams, type Params } from "./params.ts";
import { jcsHash } from "./jcs.ts";
import { accountId, spec, specHash, validateAppSpec, type Spec } from "./spec.ts";

/** What the model proposes; everything else is derived. */
export const proposal = z.strictObject({
  spec,
  /** Contributor account to share in percent, summing to 100. */
  contributors: z.record(accountId, z.number().positive()),
  evaluator: accountId,
  /** RFC 3339 UTC, e.g. 2027-01-15T18:00:00Z. */
  deadline: z.string(),
  /** In whole or decimal token units, e.g. "250" or "12.5". */
  amount: z.string().regex(/^\d+(\.\d+)?$/, "a decimal number of tokens"),
  /** Hours the evaluator has to object once everyone delivered; then it pays out. */
  acceptance_window_hours: z.number().int().positive().optional(),
});
export type Proposal = z.infer<typeof proposal>;

/** What the customer's launch card reports back to the model. */
export const launchResult = z.discriminatedUnion("launched", [
  // fund_tx is absent when a resumed launch found the objective already funded
  z.object({ launched: z.literal(true), objective: z.string(), deploy_tx: z.string().optional(), fund_tx: z.string().optional() }),
  z.object({ launched: z.literal(false), reason: z.string() }),
]);
export type LaunchResult = z.infer<typeof launchResult>;

/**
 * The answer to a launch the conversation moved past: the customer wrote
 * again (or reloaded) instead of signing. Models reject a call left without
 * a result, so the server supplies this one.
 */
export const MOVED_ON: LaunchResult = { launched: false, reason: "the customer continued the conversation without launching" };

export interface Objective {
  params: Params;
  spec: Spec;
  accountId: string;
  /** In the token's smallest unit. */
  amount: bigint;
}

/**
 * One launch's identity, whatever its salt: the same terms from the same
 * sponsor against the same code are the same launch, so asking again after
 * a reload resumes it rather than deploying and funding a second objective.
 */
export const launchKey = (p: Proposal, sponsor: string, codeHash: string): string =>
  `extents:launch:${jcsHash({ proposal: p, sponsor, codeHash })}`;

export const toBaseUnits = (amount: string): bigint => {
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > TOKEN.decimals) throw new Error(`${TOKEN.symbol} has ${TOKEN.decimals} decimals`);
  return BigInt(whole! + fraction.padEnd(TOKEN.decimals, "0"));
};

export const formatUnits = (amount: bigint | string): string => {
  const s = BigInt(amount)
    .toString()
    .padStart(TOKEN.decimals + 1, "0");
  const whole = s.slice(0, -TOKEN.decimals);
  const fraction = s.slice(-TOKEN.decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
};

/** Percent to pips (1% = 10,000), refusing anything finer than a pip. */
function toPips(percent: number): number {
  const pips = Math.round(percent * (PIPS_MAX / 100));
  if (Math.abs(pips - percent * (PIPS_MAX / 100)) > 1e-6) throw new Error(`${percent}% is finer than 0.0001%`);
  return pips;
}

/**
 * Throws a message meant for the model to act on. `now` and `salt` are
 * inputs so that the result is reproducible.
 */
export function buildObjective(p: Proposal, sponsor: string, salt: string, codeHash: string, now = Date.now()): Objective {
  validateAppSpec(p.spec);
  let deadline = NaN;
  try {
    // UTC to the second for drafts; timestampNanos refuses impossible dates such as February 30th
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(p.deadline)) deadline = Number(timestampNanos(p.deadline) / 1_000_000n);
  } catch {}
  if (Number.isNaN(deadline)) {
    throw new Error("deadline must be RFC 3339 UTC to the second, e.g. 2027-01-15T18:00:00Z");
  }
  if (deadline <= now) throw new Error("deadline is in the past");
  const amount = toBaseUnits(p.amount);
  if (amount <= 0n) throw new Error("amount must be positive");
  if (sponsor in p.contributors) throw new Error("the sponsor cannot also be a contributor");

  const params: Params = {
    sponsor,
    token: PARAMS_TOKEN,
    evaluator: p.evaluator,
    contributors: Object.fromEntries(Object.entries(p.contributors).map(([a, pct]) => [a, toPips(pct)])),
    deadline: p.deadline,
    ...(p.acceptance_window_hours === undefined ? {} : { acceptance_window_secs: p.acceptance_window_hours * 3600 }),
    spec_hash: specHash(p.spec),
    auth_caller: VERIFIER,
    salt,
  };
  const problem = validateParams(params);
  if (problem) throw new Error(problem);
  return { params, spec: p.spec, accountId: objectiveAccountId(params, codeHash), amount };
}
