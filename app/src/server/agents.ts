/**
 * Extents for other agents, as plain JSON: drafting an objective, taking a
 * contributor's or the sponsor's part in one and reviewing one, each down to its exact unsigned transactions and the link
 * where a person can do the same in their browser. Agents prepare; only
 * wallets and DAOs sign. Documented for models in /llms.txt and /skill.md.
 */
import { EventType, type RunErrorEvent, type RunFinishedEvent } from "@ag-ui/core";

import { attestationOf, type Dao } from "../shared/attest.ts";
import { authCall, calls, describe, fundIntent, type Action } from "../shared/calls.ts";
import { objectiveCodeHash, sponsorMayRelease } from "../shared/config.ts";
import { holders, openToContributors, slotOf } from "../shared/delivery.ts";
import { launchFragment } from "../shared/launch-link.ts";
import { buildObjective, type Proposal } from "../shared/objective.ts";
import { randomSalt, type Params } from "../shared/params.ts";
import { reportHash } from "../shared/review.ts";
import type { Review } from "../shared/spec.ts";
import { runEvaluation, type CheckRunDeps } from "./precheck.ts";

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
      { step: "publish", signer: sponsor, ...describe(calls.publish(o.accountId, { params: o.params, spec: o.spec })) },
      { step: "fund", signer: sponsor, ...describe(calls.fund(o.accountId, o.params, o.amount)) },
    ],
    // a sponsor that signs Verifier intents rather than NEAR transactions: deploy with the spec (the deployer then
    // publishes the terms), and fund with this, signed with `signer_id` = the sponsor
    fund_intent: fundIntent(o.accountId, o.params, o.amount),
  };
}

/** An objective as `describeObjective` reads it, as far as a contributor's or the sponsor's part needs. */
export interface ObjectiveView {
  documents?: { params: Params; spec?: { max_report_bytes?: number } };
  state?: { funded?: string; committed?: number; delivered?: number; taken?: number; deadline?: string; outcome?: string };
}

type State = NonNullable<ObjectiveView["state"]>;

const step = (name: string, signer: string, call: Parameters<typeof describe>[0]) => ({ step: name, signer, ...describe(call) });

/** Whether the last moment to attest has passed: the deadline, or the acceptance window that extended it. */
const expired = (params: Params, state: State, now: number) => Date.parse(state.deadline ?? params.deadline) < now;

/** Anyone may close: it expires an objective past its last moment to attest, retries payouts, and deletes it once settled. */
const closing = (objective: string, params: Params, state: State, now: number) =>
  state.outcome || expired(params, state, now) ? [step("close", "anyone", calls.close(objective, params))] : [];

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
// Its `next` lines restate, for the agent: docs/spec.md, "A holder may withdraw until it delivers"; docs/spec.md, "A delivery is final"
export function contribute(objective: string, view: ObjectiveView, c: Contribution, origin: string, now = Date.now()) {
  if (!view.documents) throw new Error("This objective has no published terms.");
  const { params, spec } = view.documents;
  const state = view.state ?? {};
  const resolved = state.outcome && `The objective resolved as ${state.outcome}.`;
  const slot = slotOf(params, state, c.account, now);
  if (slot < 0) throw new Error(`${c.account} holds no slot in this objective and backs none that is open to it yet.`);
  const committed = Boolean(((state.committed ?? 0) >> slot) & 1);
  const delivered = Boolean(((state.delivered ?? 0) >> slot) & 1);
  const open = openToContributors(params, state, now);
  const sha256 = c.report === undefined ? undefined : reportHash(c.report);
  const sign = (name: string, call: Parameters<typeof describe>[0]) => step(name, c.account, call);

  let transactions: ReturnType<typeof step>[] = [];
  let next: string;
  if (delivered) {
    if (c.report !== undefined && c.delivery_tx) {
      const deliverable = { text: c.report, delivery_tx: c.delivery_tx, delivery_signer: c.delivery_signer ?? c.account };
      transactions = [sign("publish", calls.publish(objective, { deliverable }))];
      next =
        "Sign publish. The evaluator reads the report from it and checks report_sha256 against the delivered hash: a mismatch counts as a missing report.";
    } else
      next = resolved || "Send report and delivery_tx (the finalized ob_deliver transaction) to get the call that publishes the report.";
  } else if (!open) next = resolved || "The deadline to commit and deliver has passed.";
  else if (!committed) {
    transactions = [sign("commit", calls.commit(objective, params))];
    next = "Sign commit. Until you deliver, you can give the slot back with withdraw.";
  } else if (sha256 === undefined) next = "Send report to get the call that delivers its hash, or sign withdraw to give the slot back.";
  else {
    // a delivery is final, so one the terms already rule out is refused before it is signed
    const bytes = new TextEncoder().encode(c.report).byteLength;
    if (spec?.max_report_bytes !== undefined && bytes > spec.max_report_bytes)
      throw new Error(`The report is ${bytes} bytes; these terms allow ${spec.max_report_bytes}.`);
    transactions = [sign("deliver", calls.deliver(objective, params, sha256))];
    next =
      "Sign deliver and keep the exact report. Once the transaction is final, send report and delivery_tx to get the call that publishes it. A delivery cannot be changed.";
  }
  // whoever holds the slot may give it back until they deliver
  if (open && committed && !delivered) transactions.push(sign("withdraw", calls.withdraw(objective, params)));
  transactions.push(...closing(objective, params, state, now));

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

/**
 * The sponsor's part after launch: the unsigned call that cancels while
 * nobody has committed, then the one that releases the payment once every
 * slot delivered, each also as an `auth_call` intent when the terms let the
 * Verifier relay one. A sponsor who is the evaluator has no release: the
 * contract takes its attestation as the verdict.
 */
// Its `next` lines restate, for the agent: docs/spec.md, "The sponsor may cancel until someone commits"; docs/spec.md, "The sponsor may release but never fail"
export function sponsor(objective: string, view: ObjectiveView, origin: string, now = Date.now()) {
  if (!view.documents) throw new Error("This objective has no published terms.");
  const { params } = view.documents;
  const state = view.state ?? {};
  const funded = state.funded ?? "0";
  const slots = holders(params, state.taken);
  const without = (mask = 0) => slots.filter((_, i) => !((mask >> i) & 1)).join(", ");
  const sign = (name: string, call: Parameters<typeof describe>[0]) => step(name, params.sponsor, call);

  // a sponsor that signs intents rather than NEAR transactions: the same act, relayed by the Verifier
  const intent = (action: Action) => (params.auth_caller ? authCall(objective, params, action) : undefined);

  let transactions: ReturnType<typeof step>[] = [];
  let cancel_intent: ReturnType<typeof intent>;
  let release_intent: ReturnType<typeof intent>;
  let next: string;
  if (state.outcome) next = `The objective resolved as ${state.outcome}.`;
  else if (expired(params, state, now)) next = "The last moment to attest has passed. Sign close to settle the escrow.";
  else if (!state.committed) {
    transactions = [sign("cancel", calls.cancel(objective, params))];
    cancel_intent = intent({ action: "cancel" });
    next =
      BigInt(funded) > 0n
        ? "Nobody has committed. Sign cancel to take the funding back: the objective resolves as cancelled, and it cannot be undone. Once a contributor commits, the funding is locked."
        : "Not funded yet: sign fund, or fund_intent, from POST /api/draft. Or sign cancel to end the objective as cancelled, which cannot be undone.";
  } else if (without(state.committed)) next = `Waiting for ${without(state.committed)} to commit. The funding is locked while a slot is committed.`;
  else if (without(state.delivered)) next = `Waiting for ${without(state.delivered)} to deliver. The funding is locked while a slot is committed.`;
  else if (params.sponsor === params.evaluator)
    next = `Every contributor delivered. You are the evaluator, so your attestation is the verdict: get it from POST /api/objective/${objective}/review.`;
  else if (!sponsorMayRelease()) next = `Every contributor delivered. Waiting for ${params.evaluator}'s verdict.`;
  else {
    transactions = [sign("release", calls.attest(objective, params, { verdict: "achieved" }))];
    release_intent = intent({ action: "attest", data: { verdict: "achieved" } });
    next = `Every contributor delivered. Sign release to pay them by their shares now, without ${params.evaluator}'s verdict: the objective resolves as released, and it cannot be undone. Or wait for the verdict.`;
  }
  transactions.push(...closing(objective, params, state, now));

  return {
    objective,
    page: pageOf(origin, objective),
    sponsor: params.sponsor,
    funded,
    next,
    transactions,
    ...(cancel_intent ? { cancel_intent } : {}),
    ...(release_intent ? { release_intent } : {}),
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
    note: "Anyone may sign it.",
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
