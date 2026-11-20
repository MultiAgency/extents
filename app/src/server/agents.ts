/**
 * Extents for other agents, as plain JSON: drafting an objective and
 * reviewing one, each down to its exact unsigned transactions and the link
 * where a person can do the same in their browser. Agents prepare; only
 * wallets and DAOs sign. Documented for models in /llms.txt and /skill.md.
 */
import { EventType, type RunErrorEvent, type RunFinishedEvent } from "@ag-ui/core";

import { attestationOf, type Dao } from "../shared/attest.ts";
import { calls, describe } from "../shared/calls.ts";
import { objectiveCodeHash } from "../shared/config.ts";
import { buildObjective, type Proposal } from "../shared/objective.ts";
import { randomSalt, type Params } from "../shared/params.ts";
import type { Review } from "../shared/spec.ts";
import { runEvaluation, type CheckRunDeps } from "./precheck.ts";

const PUBLISH_NOTE = "Its receipt fails by design (the objective has no such method); FastData indexes the call anyway.";

/** An objective's own page, where each role acts in their wallet. */
export const pageOf = (origin: string, objective: string) => new URL(`/o/${objective}`, origin).href;

/** Agreed terms as an objective: its exact Params, its address, and the sponsor's two unsigned transactions. */
export function draft(p: Proposal, sponsor: string, salt: string | undefined, origin: string) {
  const o = buildObjective(p, sponsor, salt ?? randomSalt(), objectiveCodeHash());
  return {
    objective: o.accountId,
    page: pageOf(origin, o.accountId),
    params: o.params,
    spec: o.spec,
    transactions: [
      { step: "publish", signer: sponsor, ...describe(calls.publish(o.accountId, { params: o.params, spec: o.spec })), note: PUBLISH_NOTE },
      { step: "fund", signer: sponsor, ...describe(calls.fund(o.accountId, o.params, o.amount)) },
    ],
  };
}

/** The evaluation's final result, or its refusal, from the same run the evaluator's page streams. */
async function evaluate(objective: string, deps: CheckRunDeps) {
  const input = {
    threadId: "api",
    runId: crypto.randomUUID(),
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: { objective },
  };
  for await (const e of runEvaluation(input, deps)) {
    if (e.type === EventType.RUN_FINISHED) return (e as RunFinishedEvent).result as { review?: Review } & Record<string, unknown>;
    if (e.type === EventType.RUN_ERROR) return { error: (e as RunErrorEvent).message };
  }
  return { error: "The evaluation ended without a result." };
}

/**
 * The evaluator's review of what was delivered and, when the results support
 * a verdict, the unsigned calls that publish it and attest its hash, or
 * propose it when the evaluator is a Sputnik DAO.
 */
export async function review(objective: string, deps: CheckRunDeps, origin: string) {
  const page = pageOf(origin, objective);
  const result = await evaluate(objective, deps);
  if (!("review" in result) || !result.review) return { ...result, page };
  const { params, evaluator_dao } = result as { params: Params; evaluator_dao?: Dao };
  const publish = {
    step: "publish",
    ...describe(calls.publish(objective, { review: result.review })),
    note: `Anyone may sign it. ${PUBLISH_NOTE}`,
  };
  const attest = evaluator_dao
    ? {
        step: "propose",
        signer: "a member allowed to add proposals",
        ...describe(calls.propose(objective, params, attestationOf(result.review), evaluator_dao.proposal_bond)),
        note: "Settles the escrow once the DAO approves it, before the deadline.",
      }
    : { step: "attest", signer: params.evaluator, ...describe(calls.attest(objective, params, attestationOf(result.review))) };
  return { ...result, page, transactions: [publish, attest] };
}
