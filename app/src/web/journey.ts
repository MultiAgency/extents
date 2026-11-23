/**
 * Where an objective is in its life, and whose move it is: the walk-through
 * every page shows, from the draft to settlement. Derived only from what the
 * page already has (the draft, or the contract's state), never stored.
 */
import { holders } from "../shared/delivery.ts";
import { paysContributors, type Params } from "../shared/params.ts";

export const STEPS = [
  { id: "draft", label: "Draft", role: "Sponsor", about: "Tell the agent what should happen, who does it, and by when." },
  { id: "fund", label: "Fund", role: "Sponsor", about: "Sign twice: publish the terms, then lock the money in escrow." },
  { id: "commit", label: "Commit", role: "Contributors", about: "Each contributor commits to their share of the work." },
  { id: "deliver", label: "Deliver", role: "Contributors", about: "Contributors deliver reports, checked live against the terms." },
  { id: "judge", label: "Judge", role: "Evaluator", about: "The evaluator checks every criterion and attests a verdict." },
  { id: "settle", label: "Settle", role: "Contract", about: "The escrow pays each share, or refunds the sponsor." },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export interface Journey {
  /** The step in progress; absent once the escrow is settled. */
  current?: StepId;
  /** Steps passed over: no verdict was needed. */
  skipped?: StepId[];
  /** Who must act for the current step; empty when anyone may. */
  actors: string[];
  /** The current step's action, as a verb phrase: "deliver a report". */
  task: string;
  /** How it ended, once it has. */
  outcome?: string;
}

/** The workspace: drafting with the agent, then signing, then handed to the contributors. */
export function launchJourney(status: "drafting" | "ready" | "launched", sponsor: string, contributors: string[]): Journey {
  if (status === "launched") return { current: "commit", actors: contributors, task: "commit to the work" };
  if (status === "ready") return { current: "fund", actors: [sponsor], task: "sign the terms and fund the escrow" };
  return { current: "draft", actors: [sponsor], task: "describe the outcome you want funded" };
}

export interface ObjectiveState {
  funded?: string;
  committed?: number;
  delivered?: number;
  taken?: number;
  deadline?: string;
  outcome?: string;
  owed?: Record<string, string>;
  in_flight?: number;
}

const bit = (mask: number | undefined, i: number) => ((mask ?? 0) >> i) & 1;

/** A deployed objective, read from the contract's state at `now` (ms). */
export function objectiveJourney(params: Params, state: ObjectiveState | undefined, now: number): Journey {
  const outcome = state?.outcome;
  // settled without the evaluator's verdict: by the deadline, by silence, or by the sponsor's own release;
  // a cancelled objective ended before anyone committed
  const skipped: StepId[] =
    outcome === "cancelled"
      ? ["commit", "deliver", "judge"]
      : outcome === "expired" || outcome === "accepted" || outcome === "released"
        ? ["judge"]
        : [];
  if (outcome) {
    const pending = Boolean(state?.in_flight) || Object.values(state?.owed ?? {}).some((a) => BigInt(a) > 0n);
    return pending
      ? { current: "settle", skipped, actors: [], task: "retry the outstanding payouts", outcome }
      : { skipped, actors: [], task: "", outcome };
  }
  if (BigInt(state?.funded ?? "0") === 0n) return { current: "fund", actors: [params.sponsor], task: "fund the escrow" };
  if (Date.parse(state?.deadline ?? params.deadline) < now)
    return { current: "settle", skipped: ["judge"], actors: [], task: "close it and settle the escrow" };
  const slots = holders(params, state?.taken);
  const uncommitted = slots.filter((_, i) => !bit(state?.committed, i));
  if (uncommitted.length) return { current: "commit", actors: uncommitted, task: "commit to the work" };
  const undelivered = slots.filter((_, i) => !bit(state?.delivered, i));
  if (undelivered.length) return { current: "deliver", actors: undelivered, task: "deliver a report" };
  return { current: "judge", actors: [params.evaluator], task: "judge the deliveries and attest a verdict" };
}

/** The sentence under the steps: whose move it is, or how it ended. */
export function nextLine(j: Journey, you: boolean): string {
  if (!j.current)
    return paysContributors(j.outcome)
      ? `Settled: ${j.outcome}, and every share is paid.`
      : `Settled: ${j.outcome}, and the sponsor is refunded.`;
  if (you) return `Your turn: ${j.task}.`;
  if (!j.actors.length) return `Anyone can now ${j.task}.`;
  const who = j.actors.length === 1 ? j.actors[0] : `${j.actors.slice(0, -1).join(", ")} and ${j.actors.at(-1)}`;
  return `Waiting for ${who} to ${j.task}.`;
}
