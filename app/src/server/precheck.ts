/**
 * Checking deliverables against an objective's published spec, streamed as
 * AG-UI runs so the page shows every criterion resolving live: all of them
 * start at once as tool calls, and each result arrives as it is known.
 * Contributors check a draft report; the evaluator checks what was
 * delivered and gets back the review to attest.
 */
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { z } from "zod";

import type { Dao } from "../shared/attest.ts";
import type { Params } from "../shared/params.ts";
import { judgedText } from "../shared/judge.ts";
import { buildReview, summarize, type CheckResult, type Delivered } from "../shared/review.ts";
import { accountId, parseSpec, type Spec } from "../shared/spec.ts";
import { deliveredBy, verifyReports } from "../shared/delivery.ts";
import { checksForRun, runCheck, type CheckDeps, type Deliverable } from "./checks.ts";
import { canonicalize } from "../shared/jcs.ts";
import { DeliveryProofError } from "./fastdata.ts";
import type { Chain } from "./tools.ts";
import { abortable } from "./bounded.ts";

const checkRequest = z.object({
  objective: z.string(),
  deliverable: z.object({ text: z.string().max(200_000), files: z.record(z.string(), z.string()).optional() }),
});

export interface CheckRunDeps {
  chain: Chain;
  checks: CheckDeps;
  /** Each delivered report, by the contributors who wrote it. */
  delivered(objective: string, contributors: string[], signal?: AbortSignal): Promise<Delivered[]>;
  newId?: () => string;
  signal?: AbortSignal;
}

/** A reason to stop that the caller reads as is. */
class Refusal extends Error {}

/** Every criterion as a tool call, then each result as it finishes; returns the results. */
async function* streamChecks(spec: Spec, deliverable: Deliverable, deps: CheckRunDeps): AsyncGenerator<BaseEvent, CheckResult[]> {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const messageId = newId();
  for (const c of spec.criteria) {
    deps.signal?.throwIfAborted();
    yield { type: EventType.TOOL_CALL_START, toolCallId: c.id, toolCallName: "check", parentMessageId: messageId } as BaseEvent;
    yield {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: c.id,
      delta: JSON.stringify({ criterion_id: c.id, description: c.description, kind: c.check.kind }),
    } as BaseEvent;
    yield { type: EventType.TOOL_CALL_END, toolCallId: c.id } as BaseEvent;
  }

  const checks = checksForRun({ ...deps.checks, signal: deps.signal });
  const pending = new Map(
    spec.criteria.map((c) => [
      c.id,
      runCheck(c, spec, deliverable, checks).catch((e): CheckResult => ({
        criterion_id: c.id,
        outcome: "skipped",
        detail: `could not check: ${e instanceof Error ? e.message : e}`,
        evidence: [],
      })),
    ]),
  );
  const results: CheckResult[] = [];
  while (pending.size) {
    deps.signal?.throwIfAborted();
    const r = await abortable(deps.signal, () => Promise.race(pending.values()));
    pending.delete(r.criterion_id);
    results.push(r);
    yield { type: EventType.TOOL_CALL_RESULT, messageId: newId(), toolCallId: r.criterion_id, content: JSON.stringify(r) } as BaseEvent;
  }
  return results;
}

/** One run around `body`, its failures reported as RUN_ERROR. */
async function* run(input: RunAgentInput, invalid: string, body: () => AsyncGenerator<BaseEvent, unknown>): AsyncGenerator<BaseEvent> {
  const { threadId, runId } = input;
  yield { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent;
  try {
    const result = yield* body();
    yield { type: EventType.RUN_FINISHED, threadId, runId, result } as BaseEvent;
  } catch (e) {
    // a missing or unproven delivery is the caller's to fix, so it reads as a refusal
    const refusal = e instanceof Refusal || e instanceof DeliveryProofError;
    if (!(refusal || e instanceof z.ZodError)) console.error(e);
    const message = refusal ? (e as Error).message : e instanceof z.ZodError ? invalid : "An error occurred.";
    yield { type: EventType.RUN_ERROR, message } as BaseEvent;
  }
}

async function published(chain: Chain, objective: string, signal?: AbortSignal) {
  const view = (await abortable(signal, () => chain.describeObjective(objective, signal))) as {
    documents?: { params: Params; spec: unknown; unsupported?: string };
    state?: { delivered?: number; taken?: number };
    evaluator_dao?: Dao;
  };
  if (!view.documents) throw new Refusal("This objective has no published terms to check against.");
  if (view.documents.unsupported) throw new Refusal(`This app can't evaluate these terms: ${view.documents.unsupported}.`);
  return { params: view.documents.params, spec: parseSpec(view.documents.spec), state: view.state, evaluator_dao: view.evaluator_dao };
}

/** A draft report checked against the terms: `forwardedProps = {objective, deliverable}`. */
export function runChecks(input: RunAgentInput, deps: CheckRunDeps): AsyncGenerator<BaseEvent> {
  return run(input, "Send an objective and a deliverable to check.", async function* () {
    const request = checkRequest.parse(input.forwardedProps);
    const { spec } = await published(deps.chain, request.objective, deps.signal);
    // Drafts aren't attested evidence and must not consume the evaluation archive.
    return summarize(
      yield* streamChecks(spec, request.deliverable, {
        ...deps,
        checks: { ...deps.checks, archive: undefined },
      }),
    );
  });
}

/**
 * The evaluator's run over what was delivered: `forwardedProps = {objective}`.
 * Finishes with the summary, the reports judged and, when the results
 * support a verdict, the review to publish and attest.
 */
export function runEvaluation(input: RunAgentInput, deps: CheckRunDeps): AsyncGenerator<BaseEvent> {
  return run(input, "Send the objective to evaluate.", async function* () {
    const objective = accountId.parse((input.forwardedProps as { objective?: unknown } | undefined)?.objective);
    const { params, spec, state, evaluator_dao } = await published(deps.chain, objective, deps.signal);
    const expected = deliveredBy(params, state);
    if (!expected.length) throw new Refusal("Nobody has delivered yet.");
    const delivered = await abortable(deps.signal, () => deps.delivered(objective, expected, deps.signal));
    try {
      verifyReports(expected, delivered);
    } catch (e) {
      throw new Refusal(e instanceof Error ? e.message : String(e));
    }
    const archive = deps.checks.archive;
    if (archive) {
      await abortable(deps.signal, () => archive(new TextEncoder().encode(canonicalize(spec))));
      for (const report of delivered) await abortable(deps.signal, () => archive(new TextEncoder().encode(report.text)));
    }
    const results = yield* streamChecks(spec, { text: judgedText(delivered) }, deps);
    deps.signal?.throwIfAborted();
    const review = buildReview(objective, spec, delivered, results);
    if (review && archive) await abortable(deps.signal, () => archive(new TextEncoder().encode(canonicalize(review))));
    // params and the evaluator DAO ride along so a caller preparing the attestation needn't read the objective again
    return { summary: summarize(results), delivered, params, ...(evaluator_dao ? { evaluator_dao } : {}), ...(review ? { review } : {}) };
  });
}
