/**
 * The launch card's state, as every presentation renders it. Kept free of
 * chain and wallet code so a presentation's bundle is its own.
 */
import { TOKEN } from "../shared/config.ts";

export interface LaunchTerms {
  statement: string;
  criteria: { id: string; kind: string; description: string }[];
  contributors: { account: string; percent: string; amount: string }[];
  evaluator: string;
  deadline: string;
  acceptance?: string;
  address: string;
  /** With its unit, e.g. "5 USDC". */
  amount: string;
}

export type StepId = "deploy" | "publish" | "fund";
export interface LaunchStep {
  id: StepId;
  label: string;
  state: "todo" | "active" | "done";
  txUrl?: string;
}

export type LaunchModel =
  | { status: "preparing" }
  | {
      status: "ready";
      terms: LaunchTerms;
      steps: LaunchStep[];
      running: boolean;
      failure?: string;
      canLaunch: boolean;
      /** For a polite live region: what just happened, or "" when nothing has. */
      announcement: string;
      onLaunch: () => void;
      onDecline: () => void;
    }
  /** No `fundTxUrl` when a resumed launch found the objective already funded. */
  | { status: "launched"; objective: string; fundTxUrl?: string }
  | { status: "declined"; reason: string };

/** What the card's polite live region says in each state. */
export const liveText = (m: LaunchModel): string =>
  m.status === "ready"
    ? m.announcement
    : m.status === "launched"
      ? "Objective launched"
      : m.status === "declined"
        ? `Not launched: ${m.reason}`
        : "";

export const STEP_LABELS: Record<StepId, string> = {
  deploy: "Deploy the objective contract",
  publish: "Publish the terms (FastData)",
  fund: `Fund it with ${TOKEN.symbol}`,
};
