/**
 * The objective plat: the objective drawn as it takes shape, from the
 * agent's draft while the customer talks, from the exact launch terms once
 * they are ready to sign, and sealed once funded. Its terrain is drawn from
 * the objective's address, so every objective has its own map.
 */
import { useEffect, useMemo, useRef } from "react";

import { TOKEN } from "../shared/config.ts";
import type { DraftState } from "../shared/draft.ts";
import { liveText, type LaunchModel } from "./launch-model.ts";
import { TERRAIN_H, TERRAIN_W, terrain } from "./terrain.ts";

const CHECK_KIND: Record<string, string> = {
  contains: "Contains a phrase",
  schema: "Valid data",
  numeric_match: "Number in range",
  files: "Files delivered",
  live_url: "Page online",
  sources: "Cited sources load",
  media: "Photos or media",
  llm_judge: "Judged by NEAR AI",
};

/** FNV-1a as hex: a stable seed for a draft that has no address yet. */
function seedOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function Terrain({ seed, sealed }: { seed: string; sealed: boolean }) {
  const paths = useMemo(() => terrain(seed), [seed]);
  return (
    <svg
      key={sealed ? `sealed-${seed}` : seed}
      aria-hidden="true"
      viewBox={`0 0 ${TERRAIN_W} ${TERRAIN_H}`}
      preserveAspectRatio="xMidYMid slice"
      className={`block h-36 w-full sm:h-44 ${sealed ? "terrain-sealed text-sealed" : "text-ink"}`}
    >
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          pathLength={1}
          fill="none"
          stroke="currentColor"
          // index contours (every fourth) are drawn heavier, as on a survey map
          strokeWidth={i % 4 === 3 ? 1.4 : 0.7}
          opacity={sealed ? 0.85 : 0.22 + (i / paths.length) * 0.45}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

interface Shown {
  statement?: string;
  criteria: { id: string; kind: string; description: string }[];
  contributors: { account: string; percent: number; amount?: string; confirmed?: boolean }[];
  amount?: string;
  deadline?: string;
  evaluator?: string;
  acceptance?: string;
  address?: string;
}

const fromDraft = ({ terms, accounts }: DraftState): Shown => {
  const total = terms.amount ? Number(terms.amount) : undefined;
  return {
    ...(terms.statement ? { statement: terms.statement } : {}),
    criteria: terms.criteria ?? [],
    contributors: Object.entries(terms.contributors ?? {}).map(([account, percent]) => ({
      account,
      percent,
      ...(total !== undefined ? { amount: `${+((total * percent) / 100).toFixed(6)} ${TOKEN.symbol}` } : {}),
      ...(account in accounts ? { confirmed: accounts[account] } : {}),
    })),
    ...(terms.amount ? { amount: `${terms.amount} ${TOKEN.symbol}` } : {}),
    ...(terms.deadline ? { deadline: new Date(terms.deadline).toLocaleString() } : {}),
    ...(terms.evaluator ? { evaluator: terms.evaluator } : {}),
    ...(terms.acceptance_hours
      ? {
          acceptance: `Close after the later of the deadline or ${terms.acceptance_hours} h after the last delivery, unless the evaluator objects`,
        }
      : {}),
  };
};

const fromLaunch = (m: Extract<LaunchModel, { status: "ready" }>, accounts: DraftState["accounts"]): Shown => ({
  statement: m.terms.statement,
  criteria: m.terms.criteria,
  contributors: m.terms.contributors.map((c) => ({
    account: c.account,
    percent: parseFloat(c.percent),
    amount: c.amount,
    ...(c.account in accounts ? { confirmed: accounts[c.account] } : {}),
  })),
  amount: m.terms.amount,
  deadline: m.terms.deadline,
  evaluator: m.terms.evaluator,
  ...(m.terms.acceptance ? { acceptance: m.terms.acceptance } : {}),
  address: m.terms.address,
});

/** A deployed objective shown on its own page: funded or still waiting for its sponsor. */
export interface Deployed {
  address: string;
  funded: boolean;
  outcome?: string;
}

export function Plat({ draft, launch, deployed }: { draft: DraftState; launch?: LaunchModel; deployed?: Deployed }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const status = launch?.status;
  const sealed = status === "launched" || deployed?.funded === true;
  const ready = launch?.status === "ready" ? launch : undefined;
  const shown = ready ? fromLaunch(ready, draft.accounts) : fromDraft(draft);
  const address = shown.address ?? deployed?.address ?? (launch?.status === "launched" ? launch.objective : undefined);
  const empty = !shown.statement && shown.criteria.length === 0 && shown.contributors.length === 0 && !shown.amount;

  // the card's state changed under the customer: put focus where the news is
  useEffect(() => {
    if (status === "launched" || status === "declined") heading.current?.focus();
  }, [status]);

  const title = deployed?.outcome
    ? "Objective resolved"
    : sealed
      ? "Live escrow"
      : deployed
        ? "Awaiting funding"
        : ready
          ? "Ready to sign"
          : empty
            ? "Your objective"
            : "Draft";

  return (
    <section aria-labelledby="plat-title" className="overflow-hidden rounded-[18px] border border-rule bg-sheet">
      <div className="border-b border-rule bg-paper/60">
        <Terrain seed={address ?? seedOf(JSON.stringify(draft.terms))} sealed={sealed} />
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {launch ? liveText(launch) : ""}
      </p>
      <div className="flex flex-col gap-6 p-6 sm:p-8">
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2
            id="plat-title"
            ref={heading}
            tabIndex={-1}
            className={`font-display text-lg font-semibold ${sealed ? "text-sealed" : "text-ink-soft"}`}
          >
            {title}
          </h2>
          {shown.amount && (
            <p className="font-display text-3xl font-bold tabular-nums">
              {shown.amount}
              {sealed && <span className="ml-2 align-middle text-base font-medium text-sealed">locked</span>}
            </p>
          )}
        </header>

        {empty ? (
          <p className="max-w-[46ch] text-ink-soft">
            Describe the outcome you want funded, who will do the work and by when. Its terms take shape here as you talk.
          </p>
        ) : (
          <>
            {shown.statement && (
              <p className="max-w-[30ch] font-display text-[1.9rem] leading-[1.15] font-semibold text-balance">{shown.statement}</p>
            )}

            {shown.criteria.length > 0 && (
              <div>
                <h3 className="mb-2 font-display text-sm font-semibold text-ink-soft">Paid only if</h3>
                <ul className="flex flex-col gap-2">
                  {shown.criteria.map((c) => (
                    <li key={c.id} className="flex gap-3">
                      <span aria-hidden="true" className="mt-[0.55em] size-2 shrink-0 rotate-45 border-[1.5px] border-ink" />
                      <span>
                        {c.description}
                        <span className="block text-sm text-ink-soft">{CHECK_KIND[c.kind] ?? c.kind}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {draft.terms.specError && !ready && (
                  <p className="mt-2 text-sm text-alert">The agent is fixing the spec: {draft.terms.specError}</p>
                )}
              </div>
            )}

            {shown.contributors.length > 0 && (
              <div>
                <h3 className="mb-2 font-display text-sm font-semibold text-ink-soft">Shared between</h3>
                <div aria-hidden="true" className="mb-3 flex h-3 overflow-hidden rounded-full bg-rule">
                  {shown.contributors.map((c, i) => (
                    <span
                      key={c.account}
                      style={{ width: `${c.percent}%`, opacity: 1 - i * 0.22 }}
                      className={`${sealed ? "bg-sealed" : "bg-ink"} border-r-2 border-sheet last:border-r-0`}
                    />
                  ))}
                </div>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {shown.contributors.map((c) => (
                    <li key={c.account} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-sm">{c.account}</span>
                      <span className="tabular-nums">
                        {c.percent}%{c.amount && <span className="text-ink-soft"> · {c.amount}</span>}
                      </span>
                      {c.confirmed === false && <span className="text-sm text-alert">account not found</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(shown.deadline || shown.evaluator || shown.acceptance || address) && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 border-t border-rule pt-4 text-[0.95rem]">
                {shown.deadline && (
                  <>
                    <dt className="text-ink-soft">Deliver by</dt>
                    <dd>{shown.deadline}</dd>
                  </>
                )}
                {shown.evaluator && (
                  <>
                    <dt className="text-ink-soft">Judged by</dt>
                    <dd className="font-mono text-sm">{shown.evaluator}</dd>
                  </>
                )}
                {shown.acceptance && (
                  <>
                    <dt className="text-ink-soft">If no verdict</dt>
                    <dd>{shown.acceptance}</dd>
                  </>
                )}
                {address && (
                  <>
                    <dt className="text-ink-soft">Escrow</dt>
                    <dd>
                      <code className="font-mono text-sm break-all">{address}</code>
                    </dd>
                  </>
                )}
              </dl>
            )}
          </>
        )}

        {ready && <Signing model={ready} />}
        {launch?.status === "launched" && (
          <p className="flex flex-wrap gap-x-5 gap-y-1">
            <a className="text-action underline underline-offset-4" href={`/o/${launch.objective}`}>
              Open the objective page to share with contributors
            </a>
            {launch.fundTxUrl && (
              <a className="text-action underline underline-offset-4" href={launch.fundTxUrl} target="_blank" rel="noreferrer">
                View the funding transaction
              </a>
            )}
          </p>
        )}
        {launch?.status === "declined" && <p className="text-ink-soft">Not launched: {launch.reason}</p>}
      </div>
    </section>
  );
}

const STEP_STATE = { done: "done", active: "in progress", todo: "to do" } as const;

function Signing({ model }: { model: Extract<LaunchModel, { status: "ready" }> }) {
  const label = model.running ? "Signing…" : model.failure ? "Retry" : `Launch and fund ${model.terms.amount}`;
  return (
    <div className="flex flex-col gap-4 border-t border-rule pt-5">
      <ol className="flex flex-col gap-2">
        {model.steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className={`grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] font-display text-xs font-bold ${
                s.state === "done"
                  ? "border-sealed bg-sealed text-sheet"
                  : s.state === "active"
                    ? "working border-action text-action"
                    : "border-rule text-ink-soft"
              }`}
            >
              {s.state === "done" ? "✓" : i + 1}
            </span>
            <span className={s.state === "todo" ? "text-ink-soft" : ""}>
              {s.label} <span className="sr-only">({STEP_STATE[s.state]})</span>
            </span>
            {s.txUrl && (
              <a className="text-sm text-action underline underline-offset-4" href={s.txUrl} target="_blank" rel="noreferrer">
                tx
              </a>
            )}
          </li>
        ))}
      </ol>
      {model.failure && (
        <p role="alert" className="rounded-xl border border-alert/40 px-4 py-3 text-alert">
          {model.failure}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {/* aria-disabled, not disabled, while signing: focus stays on the button */}
        <button
          type="button"
          aria-disabled={!model.canLaunch || undefined}
          onClick={() => model.canLaunch && model.onLaunch()}
          className="rounded-full bg-action px-6 py-3 font-display text-lg font-semibold text-action-ink aria-disabled:opacity-60"
        >
          {label}
        </button>
        <button
          type="button"
          aria-disabled={model.running || undefined}
          onClick={() => !model.running && model.onDecline()}
          className="rounded-full px-4 py-3 text-ink-soft underline-offset-4 hover:underline aria-disabled:opacity-50"
        >
          Decline
        </button>
      </div>
      <p className="text-sm text-ink-soft">
        You sign twice in your wallet: publishing the terms, then funding. The money stays in escrow until the evaluator's verdict.
      </p>
    </div>
  );
}
