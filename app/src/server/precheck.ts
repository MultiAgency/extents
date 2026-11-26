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
import { judgedText, utf8Bytes } from "../shared/judge.ts";
import { buildReview, summarize, type CheckResult, type Delivered } from "../shared/review.ts";
import { accountId, parseSpec, type Spec } from "../shared/spec.ts";
import { deliveredBy, holders, verifyReports } from "../shared/delivery.ts";
import { checksForRun, runCheck, type CheckDeps, type Deliverable } from "./checks.ts";
import { ArchiveFullError, withObjectiveBudget, type ObjectiveUsage } from "./archive.ts";
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
  /**
   * When each criterion was first found unreachable on the contributor's side,
   * by objective and criterion: the evaluator's memory for the retry rule.
   */
  unreachableSince?: Map<string, number>;
  /** Distinct evidence bytes each objective has asked the archive to keep, so one objective cannot fill it for all. */
  archiveUsage?: ObjectiveUsage;
  /** The most one objective may add to the archive; defaults to `OBJECTIVE_ARCHIVE_BYTES`. */
  archiveObjectiveBytes?: number;
  clock?: () => number;
}

/** A contributor-side outage fails its criterion once it outlasts this; a first sighting only records it. */
export const RETRY_MS = 10 * 60 * 1000;

/**
 * The retry rule: the first time a criterion finds something the contributor
 * cited unreachable it is recorded and stays skipped; a run at least
 * `RETRY_MS` later that still finds it unreachable fails it. A reachable run
 * forgets the sighting.
 */
function retryRule(objective: string, deps: CheckRunDeps): (r: CheckResult) => CheckResult {
  const seen = deps.unreachableSince;
  const now = (deps.clock ?? Date.now)();
  return (r) => {
    if (!seen) return r;
    const key = `${objective}:${r.criterion_id}`;
    if (!r.unavailable) {
      seen.delete(key);
      return r;
    }
    const since = seen.get(key);
    if (since === undefined) {
      seen.set(key, now);
      return { ...r, detail: `${r.detail}. Recorded; if it is still unreachable ${RETRY_MS / 60_000} minutes from now, it fails.` };
    }
    if (now - since < RETRY_MS) return { ...r, detail: `${r.detail}. Still within the ${RETRY_MS / 60_000}-minute retry window.` };
    const { unavailable: _, ...settled } = r;
    return {
      ...settled,
      outcome: "fail",
      detail: `${r.detail}; still unreachable ${Math.round((now - since) / 60_000)} minutes after it was first found so`,
    };
  };
}

/** Who wrote a report longer than the spec allows, in UTF-8 bytes. */
const overLimit = (spec: Spec, reports: { contributor: string; text: string }[]): string[] =>
  spec.max_report_bytes === undefined ? [] : reports.filter((r) => utf8Bytes(r.text) > spec.max_report_bytes!).map((r) => r.contributor);

/** A reason to stop that the caller reads as is. */
class Refusal extends Error {}

/**
 * The archive an evaluation of `objective` writes to: the shared one, within the objective's share when usage is
 * tracked. A full archive or a spent share is a refusal the caller reads as is.
 */
function objectiveArchive(deps: CheckRunDeps, objective: string): CheckDeps["archive"] {
  const archive = deps.checks.archive;
  if (!archive) return archive;
  const write = deps.archiveUsage ? withObjectiveBudget(archive, deps.archiveUsage, objective, deps.archiveObjectiveBytes) : archive;
  return async (bytes) => {
    try {
      await write(bytes);
    } catch (e) {
      throw e instanceof ArchiveFullError ? new Refusal(e.message) : e;
    }
  };
}

/** Every criterion as a tool call, then each result as it finishes; returns the results. */
async function* streamChecks(
  spec: Spec,
  deliverable: Deliverable,
  deps: CheckRunDeps,
  settle: (r: CheckResult) => CheckResult = (r) => r,
): AsyncGenerator<BaseEvent, CheckResult[]> {
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
    const raw = await abortable(deps.signal, () => Promise.race(pending.values()));
    pending.delete(raw.criterion_id);
    const r = settle(raw);
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
      yield* streamChecks(
        spec,
        { ...request.deliverable, oversized: overLimit(spec, [{ contributor: "this report", text: request.deliverable.text }]) },
        {
          ...deps,
          checks: { ...deps.checks, archive: undefined },
        },
      ),
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
    const onChain = deliveredBy(params, state);
    // each delivered slot's report on its own: an absent report is missing, an unconfirmable one stops the run
    const reports = await abortable(deps.signal, () =>
      Promise.allSettled(onChain.map((contributor) => deps.delivered(objective, [contributor], deps.signal))),
    );
    const delivered: Delivered[] = [];
    for (const r of reports) {
      if (r.status === "fulfilled") delivered.push(...r.value);
      else if (!(r.reason instanceof DeliveryProofError && r.reason.kind === "missing")) throw r.reason;
    }
    try {
      verifyReports(onChain, delivered);
    } catch (e) {
      throw new Refusal(e instanceof Error ? e.message : String(e));
    }
    // every slot without a judged report: not delivered on chain, or delivered with no valid published report
    const missing = holders(params, state?.taken).filter((h) => !delivered.some((d) => d.contributor === h));
    const archive = objectiveArchive(deps, objective);
    const checks = { ...deps.checks, archive };
    if (archive) {
      await abortable(deps.signal, () => archive(new TextEncoder().encode(canonicalize(spec))));
      for (const report of delivered) await abortable(deps.signal, () => archive(new TextEncoder().encode(report.text)));
    }
    // with nothing to judge, no model is asked; the missing reports already fail the objective
    const checkDeps = { ...deps, checks: delivered.length ? checks : { ...checks, judge: undefined } };
    const results = yield* streamChecks(
      spec,
      { text: judgedText(delivered), reports: delivered, oversized: overLimit(spec, delivered) },
      checkDeps,
      retryRule(objective, deps),
    );
    deps.signal?.throwIfAborted();
    const review = buildReview(objective, spec, delivered, results, missing);
    if (review && archive) await abortable(deps.signal, () => archive(new TextEncoder().encode(canonicalize(review))));
    // params and the evaluator DAO ride along so a caller preparing the attestation needn't read the objective again
    return {
      summary: summarize(results),
      // each criterion's outcome and detail: a JSON caller has no stream to read why a check was skipped
      results,
      delivered,
      ...(missing.length ? { missing } : {}),
      params,
      ...(evaluator_dao ? { evaluator_dao } : {}),
      ...(review ? { review } : {}),
    };
  });
}
