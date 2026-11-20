/**
 * The launch card's logic, apart from how it looks: from the agent's
 * proposal to the exact terms the customer reviews, and the three signing
 * steps. Any presentation renders a `LaunchModel`.
 */
import { useEffect, useRef, useState } from "react";

import { objectiveCodeHash, TOKEN } from "../shared/config.ts";
import { classifyFund } from "../shared/fund-outcome.ts";
import type { TxOutcome } from "../shared/receipts.ts";
import { buildObjective, formatUnits, launchKey, proposal, type LaunchResult, type Objective } from "../shared/objective.ts";
import { contributorsInOrder, PIPS_MAX, randomSalt } from "../shared/params.ts";
import type { ToolView } from "./cards.tsx";
import { STEP_LABELS, type LaunchModel, type LaunchStep, type LaunchTerms, type StepId } from "./launch-model.ts";
import { assertFundingMayStart, readLaunch, writeLaunch, type LaunchRecord } from "./launch-store.ts";
import { calls } from "../shared/calls.ts";
import { isWalletRejection, publishFastData, sentTransaction, sign, withTabLock } from "./send.ts";
import { useWallet } from "./wallet.tsx";
import { trackFunding } from "./submissions.ts";
import { finalOutcome } from "./transaction-outcome.ts";

export * from "./launch-model.ts";

const ORDER: StepId[] = ["deploy", "publish", "fund"];

export const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

export function termsOf(o: Objective): LaunchTerms {
  const { params, spec } = o;
  return {
    statement: spec.statement,
    criteria: spec.criteria.map((c) => ({ id: c.id, kind: c.check.kind, description: c.description })),
    contributors: contributorsInOrder(params).map(([account, pips]) => ({
      account,
      percent: `${pips / (PIPS_MAX / 100)}%`,
      amount: `${formatUnits((o.amount * BigInt(pips)) / BigInt(PIPS_MAX))} ${TOKEN.symbol}`,
    })),
    evaluator: params.evaluator,
    deadline: new Date(params.deadline).toLocaleString(),
    ...(params.acceptance_window_secs === undefined
      ? {}
      : {
          acceptance: `If the evaluator stays silent, close after the later of the deadline or ${params.acceptance_window_secs / 3600} h after the last delivery to pay contributors`,
        }),
    address: o.accountId,
    amount: `${formatUnits(o.amount)} ${TOKEN.symbol}`,
  };
}

/** The steps as shown: done ones with their transaction, the first unfinished one active while signing. */
export function stepsOf(done: Partial<Record<StepId, string | true>>, running: boolean): LaunchStep[] {
  const current = running ? ORDER.find((s) => !done[s]) : undefined;
  return ORDER.map((id) => {
    const d = done[id];
    return {
      id,
      label: STEP_LABELS[id],
      state: d ? "done" : id === current ? "active" : "todo",
      ...(typeof d === "string" ? { txUrl: explorer(d) } : {}),
    };
  });
}

async function objectiveView(id: string) {
  const res = await fetch(`/api/objective/${id}`, { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body as { deployed: boolean; state?: { funded?: string }; documents?: unknown };
}

/** Retries `check` for up to 30 s, for state an indexer or RPC reflects with a delay. */
async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 15; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${what} did not show up`);
}

export function useLaunch(view: ToolView<LaunchResult>, account: string, onDone: (r: LaunchResult) => void): LaunchModel | undefined {
  const { near } = useWallet();
  const parsed = view.state === "pending" ? proposal.safeParse(view.input) : undefined;
  const key = parsed?.success ? launchKey(parsed.data, account, objectiveCodeHash()) : undefined;
  let stored: LaunchRecord | undefined;
  let storageFailure: string | undefined;
  try {
    stored = key ? readLaunch(key) : undefined;
  } catch {
    storageFailure = "Saved launch progress is unavailable or invalid. Restore browser storage before launching; no transaction was sent.";
  }
  const [fresh] = useState(randomSalt);
  const salt = stored?.salt ?? fresh;
  const [done, setDone] = useState<Partial<Record<StepId, string | true>>>(() => stored?.done ?? {});
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const reported = useRef(false);
  const signing = useRef(false);

  let objective: Objective | undefined;
  let invalid: string | undefined;
  if (parsed && !parsed.success) invalid = `invalid launch_objective input: ${parsed.error.message}`;
  else if (parsed?.success) {
    try {
      objective = buildObjective(parsed.data, account, salt, objectiveCodeHash());
    } catch (e) {
      invalid = e instanceof Error ? e.message : String(e);
    }
  }

  // terms the contract would refuse go straight back to the model
  useEffect(() => {
    if (invalid && !reported.current) {
      reported.current = true;
      onDone({ launched: false, reason: invalid });
    }
  }, [invalid, onDone]);

  if (view.state === "streaming") return { status: "preparing" };
  if (view.state === "error") return { status: "declined", reason: view.error };
  if (view.state === "done") {
    const r = view.output;
    return r.launched
      ? { status: "launched", objective: r.objective, ...(r.fund_tx ? { fundTxUrl: explorer(r.fund_tx) } : {}) }
      : { status: "declined", reason: r.reason };
  }
  if (!objective || !key) return undefined;

  const o = objective;
  // progress is saved before each external call, so a reload resumes this objective
  let record: LaunchRecord = stored ?? { salt, done };
  const save = (change: Partial<LaunchRecord>) => {
    record = { ...record, ...change };
    writeLaunch(key, record);
  };
  const mark = (step: StepId, value: string | true) => {
    save({ done: { ...record.done, [step]: value } });
    setDone(record.done);
    setAnnouncement(`${STEP_LABELS[step]}: done`);
  };
  const isFunded = async () => BigInt((await objectiveView(o.accountId)).state?.funded ?? "0") >= o.amount;
  const signedByAccount = (outcome: TxOutcome) => {
    const signer = outcome.transaction?.signer_id;
    if (signer && signer !== account) throw new Error(`the wallet signed as ${signer}, not ${account}`);
  };

  const launch = async () => {
    if (!near || signing.current) return;
    signing.current = true;
    setRunning(true);
    setFailure(undefined);
    setAnnouncement("Signing in your wallet");
    try {
      if (storageFailure) throw new Error(storageFailure);
      // the lock covers identity persistence as well as signing across tabs
      await withTabLock(key, "This objective is being launched in another tab. Wait for it to finish.", async () => {
        const current = readLaunch(key);
        if (current && current.salt !== salt) throw new Error("Another tab saved this launch first. Reload to resume its objective.");
        record = current ?? record;
        save({});
        let deployTx = typeof record.done.deploy === "string" ? record.done.deploy : undefined;
        if (!record.done.deploy) {
          const res = await fetch("/api/deploy", { method: "POST", body: JSON.stringify({ params: o.params }) });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error);
          deployTx = body.txHash;
          mark("deploy", body.txHash ?? true);
        }

        if (!record.done.publish) {
          if (!(await objectiveView(o.accountId)).documents) {
            await publishFastData(near, account, o.accountId, { params: o.params, spec: o.spec }, signedByAccount);
            await until(async () => Boolean((await objectiveView(o.accountId)).documents), "The published terms");
          }
          mark("publish", true);
        }

        // never fund twice: what the chain already shows wins, and an earlier attempt of unknown outcome is settled first
        if (record.fundTx) {
          const previous = await finalOutcome(record.fundTx, account);
          signedByAccount(previous);
          const result = classifyFund(previous, o.accountId);
          if (result.kind === "funded") {
            mark("fund", record.fundTx);
            save({ fundAttemptAt: undefined });
            onDone({ launched: true, objective: o.accountId, fund_tx: record.fundTx });
            return;
          }
          if (result.kind === "refused") {
            save({ fundAttemptAt: undefined, fundTx: undefined });
            throw new Error("The earlier funding transaction was refused. No replacement was sent; you can now retry.");
          }
        }
        if (record.fundAttemptAt && !(await isFunded())) {
          setAnnouncement("Checking an earlier funding attempt");
          // Absence is not a failed transaction. A retry only reconciles state;
          // it must never turn a polling timeout into permission to resend.
        }
        if (await isFunded()) {
          mark("fund", typeof record.done.fund === "string" ? record.done.fund : true);
          save({ fundAttemptAt: undefined });
          onDone({ launched: true, objective: o.accountId, ...(deployTx ? { deploy_tx: deployTx } : {}) });
          return;
        }

        assertFundingMayStart(record, false);
        save({ fundAttemptAt: new Date().toISOString() });
        let outcome: TxOutcome;
        const stopTracking = trackFunding(o.accountId, (hash) => save({ fundTx: hash }));
        try {
          outcome = await sign(near, account, calls.fund(o.accountId, o.params, o.amount), "FINAL");
        } catch (e) {
          const tx = sentTransaction(e);
          if (tx) save({ fundTx: tx });
          // a refusal in the wallet sent nothing; anything else may have been sent
          if (!record.fundTx && isWalletRejection(e)) save({ fundAttemptAt: undefined });
          throw e;
        } finally {
          stopTracking();
        }
        save({ fundTx: outcome.transaction?.hash ?? record.fundTx });
        signedByAccount(outcome);
        const result = classifyFund(outcome, o.accountId);
        if (result.kind === "refused") {
          save({ fundAttemptAt: undefined, fundTx: undefined });
          throw new Error(`${result.reason}; the Verifier returns the funds`);
        }
        if (result.kind === "unknown") await until(isFunded, "The funding");
        const fundTx = outcome.transaction?.hash ?? record.fundTx;
        mark("fund", fundTx ?? true);
        save({ fundAttemptAt: undefined });
        onDone({
          launched: true,
          objective: o.accountId,
          ...(deployTx ? { deploy_tx: deployTx } : {}),
          ...(fundTx ? { fund_tx: fundTx } : {}),
        });
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setFailure(message);
      setAnnouncement(`Launch stopped: ${message}`);
    } finally {
      signing.current = false;
      setRunning(false);
    }
  };

  return {
    status: "ready",
    terms: termsOf(o),
    steps: stepsOf(done, running),
    running,
    ...((failure ?? storageFailure) ? { failure: failure ?? storageFailure } : {}),
    canLaunch: !running && !storageFailure && Boolean(near),
    announcement,
    onLaunch: () => void launch(),
    onDecline: () => onDone({ launched: false, reason: "the customer declined these terms" }),
  };
}
