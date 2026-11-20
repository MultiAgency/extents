/**
 * Extents for other agents, as plain JSON: drafting an objective, taking a
 * contributor's part in one and reviewing one, each down to its exact unsigned transactions and the link
 * where a person can do the same in their browser. Agents prepare; only
 * wallets and DAOs sign. Documented for models in /llms.txt and /skill.md.
 */
import { EventType, type RunErrorEvent, type RunFinishedEvent } from "@ag-ui/core";

import { attestationOf, type Dao } from "../shared/attest.ts";
import { calls, describe } from "../shared/calls.ts";
import { objectiveCodeHash } from "../shared/config.ts";
import { slotOf } from "../shared/delivery.ts";
import { launchFragment } from "../shared/launch-link.ts";
import { buildObjective, type Proposal } from "../shared/objective.ts";
import { randomSalt, type Params } from "../shared/params.ts";
import { reportHash } from "../shared/review.ts";
import type { Review } from "../shared/spec.ts";
import { runEvaluation, type CheckRunDeps } from "./precheck.ts";

const PUBLISH_NOTE = "Its receipt fails by design (the objective has no such method); FastData indexes the call anyway.";

/** An objective's own page, where each role acts in their wallet. */
export const pageOf = (origin: string, objective: string) => new URL(`/o/${objective}`, origin).href;

/**
 * Agreed terms as an objective: its exact Params, its address, the sponsor's
 * two unsigned transactions, and the page that launches it in their browser.
 */
export function draft(p: Proposal, sponsor: string, given: string | undefined, origin: string) {
  const salt = given ?? randomSalt();
  const o = buildObjective(p, sponsor, salt, objectiveCodeHash());
  return {
    objective: o.accountId,
    page: pageOf(origin, o.accountId) + launchFragment({ proposal: p, sponsor, salt }),
    params: o.params,
    spec: o.spec,
    transactions: [
      { step: "publish", signer: sponsor, ...describe(calls.publish(o.accountId, { params: o.params, spec: o.spec })), note: PUBLISH_NOTE },
      { step: "fund", signer: sponsor, ...describe(calls.fund(o.accountId, o.params, o.amount)) },
    ],
  };
}

/** An objective as `describeObjective` reads it, as far as a contributor's part needs. */
export interface ContributorView {
  documents?: { params: Params; spec?: { max_report_bytes?: number } };
  state?: { committed?: number; delivered?: number; taken?: number; deadline?: string; outcome?: string };
}

/** What a contributor sends: who they are, the report once written, and its delivery once that is final. */
export interface Contribution {
  account: string;
  report?: string;
  delivery_tx?: string;
  /** Who signed the delivery transaction, when a relayer did; the contributor otherwise. */
  delivery_signer?: string;
}

/**
 * A contributor's part, one step at a time: the unsigned call that commits,
 * then the one that delivers the report's hash, then the one that publishes
 * the report with its delivery proof. Throws, in words for the caller, when
 * the account has no part in the objective.
 */
export function contribute(objective: string, view: ContributorView, c: Contribution, origin: string, now = Date.now()) {
  if (!view.documents) throw new Error("This objective has no published terms.");
  const { params, spec } = view.documents;
  const state = view.state ?? {};
  const resolved = state.outcome && `The objective resolved as ${state.outcome}.`;
  const slot = slotOf(params, state, c.account, now);
  if (slot < 0) throw new Error(`${c.account} holds no slot in this objective and backs none that is open to it yet.`);
  const committed = Boolean(((state.committed ?? 0) >> slot) & 1);
  const delivered = Boolean(((state.delivered ?? 0) >> slot) & 1);
  // commitment and delivery end at the original deadline; only the time to attest moves
  const open = !state.outcome && Date.parse(params.deadline) >= now;
  const sha256 = c.report === undefined ? undefined : reportHash(c.report);
  const step = (name: string, call: Parameters<typeof describe>[0], note?: string) => ({
    step: name,
    signer: c.account,
    ...describe(call),
    ...(note ? { note } : {}),
  });

  let transactions: ReturnType<typeof step>[] = [];
  let next: string;
  if (delivered) {
    if (c.report !== undefined && c.delivery_tx) {
      const deliverable = { text: c.report, delivery_tx: c.delivery_tx, delivery_signer: c.delivery_signer ?? c.account };
      transactions = [step("publish", calls.publish(objective, { deliverable }), PUBLISH_NOTE)];
      next =
        "Sign publish. The evaluator reads the report from it and checks report_sha256 against the delivered hash: a mismatch counts as a missing report.";
    } else
      next = resolved || "Send report and delivery_tx (the finalized ob_deliver transaction) to get the call that publishes the report.";
  } else if (!open) next = resolved || "The deadline to commit and deliver has passed.";
  else if (!committed) {
    transactions = [step("commit", calls.commit(objective, params))];
    next = "Sign commit. Committing cannot be undone.";
  } else if (sha256 === undefined) next = "Send report to get the call that delivers its hash.";
  else {
    // a delivery is final, so one the terms already rule out is refused before it is signed
    const bytes = new TextEncoder().encode(c.report).byteLength;
    if (spec?.max_report_bytes !== undefined && bytes > spec.max_report_bytes)
      throw new Error(`The report is ${bytes} bytes; these terms allow ${spec.max_report_bytes}.`);
    transactions = [step("deliver", calls.deliver(objective, params, sha256))];
    next =
      "Sign deliver and keep the exact report. Once the transaction is final, send report and delivery_tx to get the call that publishes it. A delivery cannot be changed.";
  }
  // anyone may close: it expires an objective past its last moment to attest, retries payouts, and deletes it once settled
  if (state.outcome || Date.parse(state.deadline ?? params.deadline) < now)
    transactions.push({ ...step("close", calls.close(objective, params)), signer: "anyone" });

  return {
    objective,
    page: pageOf(origin, objective),
    account: c.account,
    slot,
    committed,
    delivered,
    ...(sha256 ? { report_sha256: sha256 } : {}),
    next,
    transactions,
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
