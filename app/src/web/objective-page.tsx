/**
 * An objective's own page, `/o/<address>`: public, so anyone can see the
 * escrow and its terms; a contributor commits here, checks their work
 * against the spec live, and delivers it; the evaluator judges what was
 * delivered and attests the verdict. Opened from a launch link before it
 * is funded, it is where the sponsor launches it.
 */
import { HttpAgent } from "@ag-ui/client";
import type { Near } from "near-kit";
import { useCallback, useEffect, useMemo, useState } from "react";

import { attestationOf, attestProposal, mayPropose, type Dao } from "../shared/attest.ts";
import { calls } from "../shared/calls.ts";
import { utf8Bytes } from "../shared/judge.ts";
import { deliveredBy, deliveryHash, holders, openToContributors, slotOf, verifyReports } from "../shared/delivery.ts";
import type { DraftState } from "../shared/draft.ts";
import { objectiveCodeHash, sponsorMayRelease } from "../shared/config.ts";
import { parseLaunchFragment, type LaunchLink } from "../shared/launch-link.ts";
import { buildObjective, formatUnits, type LaunchResult, type Objective } from "../shared/objective.ts";
import { contributorsInOrder, paysContributors, PIPS_MAX, timestampNanos, type Params } from "../shared/params.ts";
import { reportHash, type CheckSummary, type Delivered } from "../shared/review.ts";
import { parseReview, reviewHash, type Review, type Spec } from "../shared/spec.ts";
import { fileAttestation, filingKey, HashlessFiling, setAside } from "./dao-proposal.ts";
import type { ToolView } from "./cards.tsx";
import { launchJourney, objectiveJourney, type ObjectiveState } from "./journey.ts";
import { useLaunch } from "./launch.ts";
import { Plat } from "./plat.tsx";
import { finalStatus, publishFastData, sign } from "./send.ts";
import { GoTo, Steps, SwitchTo } from "./steps.tsx";
import { useWallet } from "./wallet.tsx";

interface View {
  deployed: boolean;
  state?: ObjectiveState;
  documents?: { params: Params; spec: Spec; unsupported?: string };
  evaluator_dao?: Dao;
  verifier_balance?: string;
}

const bit = (mask: number | undefined, i: number) => ((mask ?? 0) >> i) & 1;

function draftOf({ params, spec }: { params: Params; spec: Spec }, funded: bigint): DraftState {
  return {
    terms: {
      statement: spec.statement,
      criteria: spec.criteria.map((c) => ({ id: c.id, kind: c.check.kind, description: c.description })),
      contributors: Object.fromEntries(contributorsInOrder(params).map(([a, pips]) => [a, pips / (PIPS_MAX / 100)])),
      evaluator: params.evaluator,
      deadline: params.deadline,
      ...(funded > 0n ? { amount: formatUnits(funded) } : {}),
      ...(params.acceptance_window_secs ? { acceptance_hours: params.acceptance_window_secs / 3600 } : {}),
    },
    accounts: {},
  };
}

export function ObjectivePage({ address }: { address: string }) {
  const { accountId, near } = useWallet();
  const [view, setView] = useState<View>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/objective/${address}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Couldn't read this objective.");
      else {
        setError(undefined);
        setView(body as View);
      }
    } catch {
      setError("Could not read this objective. Refresh to try again.");
    }
  }, [address]);
  useEffect(() => void refresh(), [refresh]);
  const [link] = useState(() => parseLaunchFragment(location.hash));
  // another role acts from another wallet: keep the page current while it is open, until it is settled
  const settled = Boolean(
    view?.documents && view.state?.outcome && !objectiveJourney(view.documents.params, view.state, Date.now()).current,
  );
  useEffect(() => {
    if (settled) return;
    const id = setInterval(() => document.visibilityState === "visible" && void refresh(), 8000);
    return () => clearInterval(id);
  }, [refresh, settled]);

  if (error)
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-alert">
          {error}
        </p>
        <button type="button" onClick={() => void refresh()} className="self-start rounded-full border border-ink px-5 py-2.5">
          Retry reading objective
        </button>
      </div>
    );
  if (!view) return <p className="text-ink-soft">Reading the objective…</p>;
  if (link && !view.state?.outcome && BigInt(view.state?.funded ?? "0") === 0n)
    return <LinkLaunch address={address} link={link} onLaunched={refresh} />;
  if (!view.deployed || !view.documents)
    return (
      <p className="text-ink-soft">
        No objective with published terms lives at {address}. It may not be launched yet, or it was settled and closed.
      </p>
    );

  const docs = view.documents;
  const funded = BigInt(view.state?.funded ?? "0");
  const order = holders(docs.params, view.state?.taken);
  const index = accountId ? slotOf(docs.params, view.state, accountId, Date.now()) : -1;
  const evaluating =
    Boolean(near && accountId && !view.state?.outcome) &&
    (accountId === docs.params.evaluator || Boolean(view.evaluator_dao && accountId && mayPropose(view.evaluator_dao, accountId)));
  const journey = objectiveJourney(docs.params, view.state, Date.now());
  // everyone delivered and the verdict is pending: the sponsor may pay out without it, on a build that allows it.
  // A sponsor who is the evaluator itself attests instead (the contract takes that as the verdict, `achieved`);
  // one who may only propose to an evaluator DAO still releases in its own name
  const releasing =
    sponsorMayRelease() &&
    Boolean(near) &&
    accountId === docs.params.sponsor &&
    accountId !== docs.params.evaluator &&
    journey.current === "judge";
  // nobody holds a slot yet: the sponsor may still call it off and take any funding back
  const cancelling = Boolean(near) && accountId === docs.params.sponsor && !view.state?.outcome && !view.state?.committed;
  // the map stays inked once the escrow paid out, not only while it holds the money
  const paid = paysContributors(view.state?.outcome);
  const you =
    Boolean(accountId && journey.actors.includes(accountId)) ||
    (journey.current === "judge" && evaluating) ||
    (journey.current !== undefined && journey.actors.length === 0 && Boolean(near));
  const action = !journey.current ? undefined : you ? (
    journey.current === "fund" ? (
      <GoTo href="/">Fund it from the workspace</GoTo>
    ) : journey.current === "settle" ? (
      <GoTo href="#settle">Settle it</GoTo>
    ) : (
      <GoTo href="#act">{journey.current === "judge" ? "Evaluate the deliveries" : "Go to your part"}</GoTo>
    )
  ) : releasing ? (
    <GoTo href="#release">Release payment</GoTo>
  ) : journey.actors[0] ? (
    <SwitchTo account={journey.actors[0]} />
  ) : undefined;

  return (
    <div className="flex flex-col gap-8">
      <Steps journey={journey} you={you} action={action} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start">
        <Plat draft={draftOf(docs, funded)} deployed={{ address, funded: funded > 0n || paid, outcome: view.state?.outcome }} />
        <div className="flex flex-col gap-6">
          {journey.current && <ShareLink />}
          {docs.unsupported && (
            <p role="alert" className="text-alert">
              This app can't check or evaluate these terms: {docs.unsupported}. They are still the objective's terms, and its evaluator can
              attest with other tools.
            </p>
          )}
          {view.state?.outcome && journey.current && (
            <p className="font-display text-xl font-semibold">
              {`Resolved: ${view.state.outcome}. `}
              {view.state.in_flight
                ? "Payouts or balance checks are pending."
                : Object.values(view.state.owed ?? {}).some((amount) => BigInt(amount) > 0n)
                  ? "Some payouts need a retry."
                  : "No payouts remain outstanding."}
            </p>
          )}
          {near && accountId && (view.state?.outcome || Date.parse(view.state?.deadline ?? docs.params.deadline) < Date.now()) && (
            <CloseObjective address={address} account={accountId} params={docs.params} near={near} onChange={refresh} />
          )}
          {releasing && near && accountId && (
            <ReleasePayment address={address} account={accountId} params={docs.params} near={near} onChange={refresh} />
          )}
          {cancelling && near && accountId && (
            <CancelObjective
              address={address}
              account={accountId}
              params={docs.params}
              funded={funded > 0n}
              near={near}
              onChange={refresh}
            />
          )}
          <section aria-label="Contributors" className="flex flex-col gap-2">
            <h2 className="font-display text-lg font-semibold">Who has committed</h2>
            <ul className="flex flex-col gap-1">
              {order.map((a, i) => (
                <li key={a} className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-sm">{a}</span>
                  <span className={bit(view.state?.delivered, i) ? "text-sealed" : bit(view.state?.committed, i) ? "" : "text-ink-soft"}>
                    {bit(view.state?.delivered, i) ? "delivered" : bit(view.state?.committed, i) ? "committed" : "not yet"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {index >= 0 && near && accountId && !view.state?.outcome && (
            <Contributor
              address={address}
              account={accountId}
              params={docs.params}
              committed={Boolean(bit(view.state?.committed, index))}
              delivered={Boolean(bit(view.state?.delivered, index))}
              open={openToContributors(docs.params, view.state, Date.now())}
              funded={funded > 0n}
              maxReportBytes={docs.spec.max_report_bytes}
              near={near}
              onChange={refresh}
            />
          )}
          {near && accountId && evaluating ? (
            <Evaluator
              address={address}
              account={accountId}
              params={docs.params}
              spec={docs.spec}
              dao={accountId === docs.params.evaluator ? undefined : view.evaluator_dao}
              effectiveDeadline={view.state?.deadline ?? docs.params.deadline}
              deliveredBy={deliveredBy(docs.params, view.state)}
              slots={order}
              allDelivered={order.every((_, i) => bit(view.state?.delivered, i))}
              near={near}
              onChange={refresh}
            />
          ) : (
            index < 0 && journey.current && <Checker address={address} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The page is the hand-off: whoever acts next opens this link in their own wallet. */
function ShareLink() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(location.href).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
      }
      className="self-start text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
    >
      {copied ? "Link copied" : "Copy the link for the next role"}
    </button>
  );
}

/**
 * A launch link, opened before the objective is funded: its terms, rebuilt
 * here and checked against the address, and for the sponsor the same signing
 * steps as the workspace (deploy, publish, fund), resumable after a reload.
 */
function LinkLaunch({ address, link, onLaunched }: { address: string; link: LaunchLink | Error; onLaunched: () => Promise<void> }) {
  const { accountId } = useWallet();
  const [declined, setDeclined] = useState<string>();
  const onDone = useCallback(
    (r: LaunchResult) => {
      if (!r.launched) return setDeclined(r.reason);
      history.replaceState(null, "", location.pathname); // the plain link is the one to share from here on
      void onLaunched();
    },
    [onLaunched],
  );

  let objective: Objective | undefined;
  let problem = link instanceof Error ? link.message : undefined;
  if (!(link instanceof Error)) {
    try {
      objective = buildObjective(link.proposal, link.sponsor, link.salt, objectiveCodeHash());
      if (objective.accountId !== address)
        problem =
          "This link's terms derive a different address than this page's, so there is nothing here to sign. Ask for the link again.";
    } catch (e) {
      problem = `These terms can't be launched: ${e instanceof Error ? e.message : e}`;
    }
  }
  if (problem || !objective || link instanceof Error)
    return (
      <p role="alert" className="text-alert">
        {problem}
      </p>
    );

  const you = accountId === link.sponsor;
  const draft = draftOf(objective, objective.amount);
  return (
    <div className="flex flex-col gap-8">
      <Steps
        journey={launchJourney("ready", link.sponsor, [])}
        you={you}
        action={you ? <GoTo href="#plat">Review and sign</GoTo> : <SwitchTo account={link.sponsor} />}
      />
      {declined && <p className="text-ink-soft">Not launched: {declined}</p>}
      <div id="plat" className="mx-auto w-full max-w-3xl scroll-mt-6">
        {you && !declined ? <SponsorLaunch link={link} draft={draft} onDone={onDone} /> : <Plat draft={draft} />}
      </div>
    </div>
  );
}

function SponsorLaunch({ link, draft, onDone }: { link: LaunchLink; draft: DraftState; onDone: (r: LaunchResult) => void }) {
  const view = useMemo<ToolView<LaunchResult>>(() => ({ state: "pending", input: link.proposal }), [link]);
  const model = useLaunch(view, link.sponsor, onDone, link.salt);
  return <Plat draft={draft} {...(model ? { launch: model } : {})} />;
}

// Its copy restates: docs/spec.md, "A contributor commits before the deadline"; docs/spec.md, "A holder may withdraw until it delivers"; docs/spec.md, "A delivery is final"
function Contributor(props: {
  address: string;
  account: string;
  params: Params;
  committed: boolean;
  delivered: boolean;
  /** Whether the contract still takes a commitment, a withdrawal or a delivery. */
  open: boolean;
  funded: boolean;
  /** The spec's per-report limit, in UTF-8 bytes, when it sets one. */
  maxReportBytes?: number;
  near: Near;
  onChange: () => Promise<void>;
}) {
  const { address, account, params, committed, delivered, open, funded, maxReportBytes, near, onChange } = props;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const proofKey = `extents:delivery:${address}:${account}`;
  const [saved] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(proofKey) ?? "{}");
    } catch {
      return {};
    }
  });
  const [report, setReport] = useState<string>(typeof saved.text === "string" ? saved.text : "");
  const [deliveryTx, setDeliveryTx] = useState<string>(typeof saved.delivery_tx === "string" ? saved.delivery_tx : "");
  const reportBytes = utf8Bytes(report);
  const overLimit = maxReportBytes !== undefined && reportBytes > maxReportBytes;

  const publishProof = async (tx: string) => {
    if (deliveryHash(await finalStatus(near, tx, account), address, account) !== reportHash(report))
      throw new Error("This report does not match the successful delivery in that transaction.");
    await publishFastData(near, account, address, { deliverable: { text: report, delivery_tx: tx, delivery_signer: account } });
  };

  const act = (what: () => Promise<unknown>) => async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await what();
      await onChange();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = act(() => sign(near, account, calls.commit(address, params)));
  const withdraw = act(() => sign(near, account, calls.withdraw(address, params), "FINAL"));
  const deliver = act(async () => {
    localStorage.setItem(proofKey, JSON.stringify({ text: report }));
    const hash = reportHash(report);
    const tx = (await sign(near, account, calls.deliver(address, params, hash), "FINAL")).transaction?.hash;
    if (!tx) throw new Error("The wallet didn't return the delivery transaction; check your wallet's history before delivering again.");
    setDeliveryTx(tx);
    localStorage.setItem(proofKey, JSON.stringify({ text: report, delivery_tx: tx }));
    await publishProof(tx);
  });

  return (
    <section id="act" aria-label="Your part" className="scroll-mt-6 flex flex-col gap-4 rounded-[18px] border border-rule bg-sheet p-5">
      <h2 className="font-display text-lg font-semibold">Your part</h2>
      {!delivered && !open ? (
        <p className="text-ink-soft">The deadline to commit and deliver has passed.</p>
      ) : !committed ? (
        <>
          <p className="text-ink-soft">
            Commit to deliver your part. {funded ? "The money is already in escrow." : "The sponsor hasn't funded it yet."} Until you
            deliver, you can withdraw and give the slot back.
          </p>
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => !busy && void commit()}
            className="self-start rounded-full bg-action px-5 py-2.5 font-display font-semibold text-action-ink aria-disabled:opacity-60"
          >
            {busy ? "Signing…" : "Commit"}
          </button>
        </>
      ) : delivered ? (
        <div className="flex flex-col gap-3">
          <p className="text-sealed">You delivered. The evaluator needs the matching report and finalized delivery transaction.</p>
          <label className="flex flex-col gap-2">
            Delivered report
            <textarea
              value={report}
              onChange={(e) => setReport(e.target.value)}
              rows={6}
              className="rounded-xl border border-rule bg-paper px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-2">
            Delivery transaction hash
            <input
              value={deliveryTx}
              onChange={(e) => setDeliveryTx(e.target.value)}
              className="rounded-xl border border-rule bg-paper px-3 py-2 font-mono"
            />
          </label>
          <button
            type="button"
            disabled={busy || !report.trim() || !deliveryTx.trim()}
            onClick={() => void act(() => publishProof(deliveryTx.trim()))()}
            className="self-start rounded-full border border-ink px-5 py-2.5 font-display font-semibold disabled:opacity-50"
          >
            Publish delivery proof
          </button>
        </div>
      ) : (
        <>
          <label className="flex flex-col gap-2">
            <span className="text-ink-soft">Your report, in Markdown: links, photos and lines like “Attendees: 34”.</span>
            <textarea
              value={report}
              onChange={(e) => setReport(e.target.value)}
              rows={8}
              className="rounded-xl border border-rule bg-paper px-3 py-2 font-mono text-sm outline-none focus:border-action"
            />
          </label>
          <Checklist address={address} report={report} />
          {overLimit && (
            <p role="alert" className="text-alert">
              Your report is {reportBytes.toLocaleString()} bytes; the terms allow {maxReportBytes!.toLocaleString()}. A longer report fails
              the judged criteria, so shorten it before you deliver.
            </p>
          )}
          <button
            type="button"
            aria-disabled={busy || !report.trim() || overLimit || undefined}
            onClick={() => !busy && report.trim() && !overLimit && void deliver()}
            className="self-start rounded-full bg-action px-5 py-2.5 font-display font-semibold text-action-ink aria-disabled:opacity-60"
          >
            {busy ? "Signing…" : "Deliver"}
          </button>
          <p className="text-ink-soft">
            Can't deliver after all? Withdraw to give the slot back before the deadline. You can commit again while it's empty
            {params.backups?.[account] ? `, and after the commit-by time your backup ${params.backups[account]} can take it` : ""}.
          </p>
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => !busy && void withdraw()}
            className="self-start rounded-full border border-ink px-5 py-2.5 font-display font-semibold aria-disabled:opacity-60"
          >
            Withdraw
          </button>
        </>
      )}
      <Alert>{failure}</Alert>
    </section>
  );
}

/** For visitors: try a report against the terms without being a contributor. */
function Checker({ address }: { address: string }) {
  const [report, setReport] = useState("");
  return (
    <section aria-label="Check a report" className="flex flex-col gap-3">
      <h2 className="font-display text-lg font-semibold">Check a report against these terms</h2>
      <textarea
        aria-label="Report"
        value={report}
        onChange={(e) => setReport(e.target.value)}
        rows={6}
        className="rounded-xl border border-rule bg-sheet px-3 py-2 font-mono text-sm outline-none focus:border-action"
      />
      <Checklist address={address} report={report} />
    </section>
  );
}

interface Row {
  id: string;
  description: string;
  outcome?: "pass" | "fail" | "skipped";
  detail?: string;
}

const MARK = { pass: "✓", fail: "✗", skipped: "–" } as const;

/** An AG-UI check run: every criterion as a row, resolving live, then the run's result. */
function useCheckRun<Result>(url: string) {
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<Result>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (forwardedProps: unknown) => {
    setRunning(true);
    setRows([]);
    setResult(undefined);
    setError(undefined);
    await new HttpAgent({ url })
      .runAgent(
        { forwardedProps },
        {
          onToolCallEndEvent: ({ event, toolCallArgs }) => {
            const a = toolCallArgs as { description?: string };
            setRows((r) => [...r, { id: event.toolCallId, description: a.description ?? event.toolCallId }]);
          },
          onToolCallResultEvent: ({ event }) => {
            const res = JSON.parse(event.content as string) as { criterion_id: string; outcome: Row["outcome"]; detail: string };
            setRows((r) => r.map((row) => (row.id === res.criterion_id ? { ...row, outcome: res.outcome, detail: res.detail } : row)));
          },
          onRunFinishedEvent: ({ event }) => setResult((event as { result?: Result }).result),
          onRunErrorEvent: ({ event }) => setError(event.message),
        },
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    setRunning(false);
  };
  return { rows, result, running, error, run };
}

function CheckRows({ rows }: { rows: Row[] }) {
  if (!rows.length) return null;
  return (
    <ul aria-label="Checks" className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.id} className="flex gap-3">
          <span
            aria-hidden="true"
            className={`w-4 shrink-0 text-center ${r.outcome === "pass" ? "text-sealed" : r.outcome === "fail" ? "text-alert" : r.outcome ? "text-ink-soft" : "working text-action"}`}
          >
            {r.outcome ? MARK[r.outcome] : "◌"}
          </span>
          <span>
            {r.description} <span className="sr-only">({r.outcome ?? "checking"})</span>
            {r.detail && <span className="block text-sm text-ink-soft">{r.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const Alert = ({ children }: { children?: string }) =>
  children ? (
    <p role="alert" className="text-alert">
      {children}
    </p>
  ) : null;

/** Runs the spec's checks on the report and shows each criterion resolve, live. */
function Checklist({ address, report }: { address: string; report: string }) {
  const { rows, result: summary, running, error, run } = useCheckRun<CheckSummary>("/api/check");
  const [checkedInput, setCheckedInput] = useState<{ address: string; report: string }>();
  const stale = checkedInput !== undefined && (checkedInput.address !== address || checkedInput.report !== report);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-disabled={running || !report.trim() || undefined}
        onClick={() => {
          if (running || !report.trim()) return;
          setCheckedInput({ address, report });
          void run({ objective: address, deliverable: { text: report } });
        }}
        className="self-start rounded-full border border-ink px-5 py-2.5 font-display font-semibold aria-disabled:opacity-50"
      >
        {running ? "Checking…" : "Check my work"}
      </button>
      <CheckRows rows={stale ? [] : rows} />
      <p role="status" aria-live="polite" className={stale ? "text-ink-soft" : summary?.failed ? "text-alert" : "text-sealed"}>
        {stale
          ? "Report changed. Check it again to update the results."
          : summary
            ? summary.failed
              ? `${summary.failed} of ${summary.passed + summary.failed + summary.skipped} checks fail. Fix them before you deliver.`
              : summary.passed
                ? `Every check that can run passes${summary.skipped ? ` (${summary.skipped} left to the evaluator)` : ""}. Ready to deliver.`
                : "Nothing could be checked yet."
            : ""}
      </p>
      <Alert>{stale ? undefined : error}</Alert>
    </div>
  );
}

interface Evaluation {
  summary: CheckSummary;
  delivered: Delivered[];
  missing?: string[];
  review?: Review;
}

/**
 * The evaluator's part: judge what was delivered, then publish the review
 * and attest its hash, directly or as a proposal to the evaluator DAO. The
 * hash signed is recomputed here from the review, never taken from the server.
 */
function Evaluator(props: {
  address: string;
  account: string;
  params: Params;
  spec: Spec;
  dao?: Dao;
  allDelivered: boolean;
  effectiveDeadline: string;
  deliveredBy: string[];
  /** Who holds each slot, in contributor order. */
  slots: string[];
  near: Near;
  onChange: () => Promise<void>;
}) {
  const { address, account, params, spec, dao, allDelivered, effectiveDeadline, deliveredBy, slots, near, onChange } = props;
  const { rows, result, running, error, run } = useCheckRun<Evaluation>("/api/evaluate");
  const [busy, setBusy] = useState(false);
  /** Each exact attestation keeps its own filing result, including while another review is checked or signed. */
  const [filings, setFilings] = useState<Record<string, { proposed?: number[]; hashless?: boolean; failure?: string }>>({});

  let review: Review | undefined;
  let invalid: string | undefined;
  let key: string | undefined;
  try {
    review = result?.review && parseReview(result.review, spec);
    if (review && result) {
      const { delivered } = result;
      if (review.objective !== address) throw new Error("The review names a different objective");
      verifyReports(deliveredBy, delivered);
      if (
        review.deliverables.length !== delivered.length ||
        review.deliverables.some((d) => !delivered.some((r) => r.contributor === d.contributor && r.delivery_hash === d.sha256))
      )
        throw new Error("The review does not name the verified reports");
      // every slot without a judged report must be named missing, and nothing else: checked here, not taken from the server
      const missing = slots.filter((s) => !delivered.some((d) => d.contributor === s));
      if ((review.missing ?? []).join() !== missing.join())
        throw new Error("The review's missing reports aren't the slots without a verified report");
      key = filingKey(params.evaluator, attestProposal(address, params, attestationOf(review)));
    }
  } catch (e) {
    review = undefined;
    invalid = `This review can't be attested: ${e instanceof Error ? e.message : e}`;
  }
  const { proposed, hashless, failure } = (key && filings[key]) || {};
  // An async completion updates the call it started with, even if the displayed review has since changed.
  const updateFiling = (change: { proposed?: number[]; hashless?: boolean; failure?: string }) => {
    if (key) setFilings((saved) => ({ ...saved, [key]: { ...saved[key], ...change } }));
  };
  const expired = timestampNanos(effectiveDeadline) < BigInt(Date.now()) * 1_000_000n;
  const blocked = expired
    ? "The deadline has passed, so the evaluator can no longer attest. Anyone can now close the objective."
    : review?.verdict === "achieved" && !allDelivered
      ? "Not every contributor has delivered, so the contract accepts only a failed verdict."
      : undefined;

  const attest = async () => {
    if (!review || !result) return;
    setBusy(true);
    updateFiling({ failure: undefined });
    try {
      await Promise.all(
        result.delivered.map(async (d) => {
          if (!d.delivery_tx || !d.delivery_signer) throw new Error("The delivery transaction proof is missing");
          if (deliveryHash(await finalStatus(near, d.delivery_tx, d.delivery_signer), address, d.contributor) !== d.delivery_hash)
            throw new Error("The delivery proof did not verify; no attestation was sent");
        }),
      );
      // published for anyone to check against the attested hash
      await publishFastData(near, account, address, { review });
      if (dao) {
        try {
          const proposed = await fileAttestation(near, account, calls.propose(address, params, attestationOf(review), dao.proposal_bond));
          updateFiling({ proposed, hashless: false });
        } catch (e) {
          updateFiling({ hashless: e instanceof HashlessFiling });
          throw e;
        }
      } else {
        await sign(near, account, calls.attest(address, params, attestationOf(review)));
      }
      await onChange();
    } catch (e) {
      updateFiling({ failure: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const summary = result?.summary;
  return (
    <section id="act" aria-label="Evaluate" className="scroll-mt-6 flex flex-col gap-4 rounded-[18px] border border-rule bg-sheet p-5">
      <h2 className="font-display text-lg font-semibold">Evaluate</h2>
      <p className="text-ink-soft">
        {dao
          ? `You can propose the verdict for ${params.evaluator}. It takes effect once the DAO approves it, before the deadline.`
          : "Judge what was delivered against the terms. Your verdict settles the escrow."}
      </p>
      <button
        type="button"
        aria-disabled={running || undefined}
        onClick={() => !running && void run({ objective: address })}
        className="self-start rounded-full border border-ink px-5 py-2.5 font-display font-semibold aria-disabled:opacity-50"
      >
        {running ? "Checking…" : result ? "Check again" : "Check the deliveries"}
      </button>
      <CheckRows rows={rows} />
      <p role="status" aria-live="polite">
        {summary &&
          (review
            ? `The results support ${review.verdict}: ${summary.passed} passed, ${summary.failed} failed.${
                result?.delivered.length ? ` Judged ${result.delivered.map((d) => d.contributor).join(", ")}.` : ""
              }`
            : `${summary.skipped} ${summary.skipped === 1 ? "check" : "checks"} couldn't run, so the results support no verdict yet. Check again.`)}
      </p>
      {review?.missing && !blocked && (
        <p role="alert" className="text-alert">
          No verified report from {review.missing.join(", ")}, so this review is failed. Attesting it now ends the objective before{" "}
          {review.missing.length === 1 ? "that contributor" : "those contributors"} can still deliver.
        </p>
      )}
      {review && !blocked && proposed === undefined && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-soft">Review hash</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{reviewHash(review)}</dd>
            {review.llm_calls.length > 0 && (
              <>
                <dt className="text-ink-soft">Model calls</dt>
                <dd>
                  {review.llm_calls.length} with provider receipts ({review.llm_calls[0]!.model}); TEE attestation is not verified
                </dd>
              </>
            )}
          </dl>
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => !busy && void attest()}
            className={`self-start rounded-full px-5 py-2.5 font-display font-semibold aria-disabled:opacity-60 ${review.verdict === "achieved" ? "bg-sealed text-action-ink" : "bg-alert text-action-ink"}`}
          >
            {busy ? "Signing…" : dao ? `Propose ${review.verdict} to ${params.evaluator}` : `Attest ${review.verdict}`}
          </button>
        </>
      )}
      {proposed !== undefined && (
        <p className="text-sealed">
          Proposed as #{proposed[0]}. The verdict settles the escrow once {params.evaluator} approves it.
          {proposed.length > 1 &&
            ` #${proposed.slice(1).join(", #")} duplicate${proposed.length > 2 ? "" : "s"} it; ask ${params.evaluator} to reject the extra proposals.`}
        </p>
      )}
      {review && dao && hashless && proposed === undefined && (
        <button
          type="button"
          onClick={() => {
            if (key) setAside(key);
            updateFiling({ hashless: false, failure: undefined });
          }}
          className="self-start rounded-full border border-alert px-5 py-2.5 font-display font-semibold text-alert"
        >
          File again anyway: posts another bond and may create a duplicate proposal
        </button>
      )}
      <Alert>{blocked && review ? blocked : undefined}</Alert>
      <Alert>{invalid}</Alert>
      <Alert>{error}</Alert>
      <Alert>{failure}</Alert>
    </section>
  );
}

/**
 * The sponsor's release: once every contributor delivered, it may pay them
 * without waiting for the evaluator, with `ob_attest` achieved. The objective
 * resolves as `released`; the sponsor can never send a failed verdict.
 */
// Its copy restates: docs/spec.md, "The sponsor may release but never fail"
function ReleasePayment(props: { address: string; account: string; params: Params; near: Near; onChange: () => Promise<void> }) {
  const { address, account, params, near, onChange } = props;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const release = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await sign(near, account, calls.attest(address, params, { verdict: "achieved" }), "FINAL");
      await onChange();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      id="release"
      aria-label="Release payment"
      className="flex scroll-mt-6 flex-col gap-4 rounded-[18px] border border-rule bg-sheet p-5"
    >
      <h2 className="font-display text-lg font-semibold">Release payment</h2>
      <p className="text-ink-soft">
        Every contributor has delivered. You can pay them now instead of waiting for {params.evaluator}'s verdict: your funding goes out by
        their shares, and the objective resolves as released. This can't be undone.
      </p>
      <button
        type="button"
        aria-disabled={busy || undefined}
        onClick={() => !busy && void release()}
        className="self-start rounded-full bg-sealed px-5 py-2.5 font-display font-semibold text-action-ink aria-disabled:opacity-60"
      >
        {busy ? "Signing…" : "Release payment"}
      </button>
      <Alert>{failure}</Alert>
    </section>
  );
}

/** The sponsor calls the objective off while nobody holds a slot: any funding returns to them, and it resolves as cancelled. */
// Its copy restates: docs/spec.md, "The sponsor may cancel until someone commits"
function CancelObjective(props: {
  address: string;
  account: string;
  params: Params;
  funded: boolean;
  near: Near;
  onChange: () => Promise<void>;
}) {
  const { address, account, params, funded, near, onChange } = props;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const cancel = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await sign(near, account, calls.cancel(address, params), "FINAL");
      await onChange();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Cancel" className="flex flex-col gap-3">
      <p className="text-ink-soft">
        Nobody has committed yet, so you can still call it off. {funded ? "Your funding comes back to you, and" : "Then"} the objective ends
        as cancelled. This can't be undone.
      </p>
      <button
        type="button"
        aria-disabled={busy || undefined}
        onClick={() => !busy && void cancel()}
        className="self-start rounded-full border border-ink px-5 py-2.5 font-display font-semibold aria-disabled:opacity-60"
      >
        {busy ? "Signing…" : funded ? "Cancel and refund" : "Cancel"}
      </button>
      <Alert>{failure}</Alert>
    </section>
  );
}

/** Permissionless expiry, payout retry, and cleanup; an unresolved callback stays pending. */
function CloseObjective({
  address,
  account,
  params,
  near,
  onChange,
}: {
  address: string;
  account: string;
  params: Params;
  near: Near;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const close = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      await sign(near, account, calls.close(address, params), "FINAL");
      await onChange();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id="settle" aria-label="Settlement" className="scroll-mt-6 flex flex-col gap-3">
      <p>Close an expired objective, retry failed payouts, or check whether settlement is complete.</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void close()}
        className="self-start rounded-full border border-ink px-5 py-2.5 font-display font-semibold disabled:opacity-50"
      >
        {busy ? "Checking settlement…" : "Close or retry payouts"}
      </button>
      <Alert>{failure}</Alert>
    </section>
  );
}
