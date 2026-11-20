/**
 * A launch's identity and progress, saved before every external call, so a
 * reload resumes the same objective instead of deriving a new one. Kept in
 * this browser: a launch started elsewhere is found by its pre-reads only.
 */
import type { StepId } from "./launch-model.ts";
import { z } from "zod";

const recordSchema = z.object({
  salt: z.string().regex(/^[0-9a-f]{64}$/),
  done: z.object({
    deploy: z.union([z.string(), z.literal(true)]).optional(),
    publish: z.union([z.string(), z.literal(true)]).optional(),
    fund: z.union([z.string(), z.literal(true)]).optional(),
  }),
  fundAttemptAt: z.string().optional(),
  fundTx: z.string().optional(),
});

export interface LaunchRecord {
  salt: string;
  done: Partial<Record<StepId, string | true>>;
  /** Set before a funding transaction is sent, cleared once its outcome is known. */
  fundAttemptAt?: string;
  fundTx?: string;
}

export function readLaunch(key: string): LaunchRecord | undefined {
  const raw = localStorage.getItem(key);
  return raw ? recordSchema.parse(JSON.parse(raw)) : undefined;
}

export function writeLaunch(key: string, record: LaunchRecord): void {
  localStorage.setItem(key, JSON.stringify(recordSchema.parse(record)));
}

export function assertFundingMayStart(record: LaunchRecord, funded: boolean): void {
  if (!funded && (record.fundAttemptAt || record.fundTx || record.done.fund))
    throw new Error(
      `An earlier funding attempt is unresolved${record.fundTx ? ` (${record.fundTx})` : ""}. Check its final outcome before sending again; no replacement was sent.`,
    );
}
