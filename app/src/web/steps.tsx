/**
 * The walk-through on every page: the objective's life as a survey traverse,
 * stations joined by a line inked in as each step is done, and under it whose
 * move it is now, with the one control that moves the demo along.
 */
import type { ReactNode } from "react";

import { nextLine, STEPS, type Journey } from "./journey.ts";
import { useWallet } from "./wallet.tsx";

type Station = "done" | "active" | "todo" | "skipped";

function stationOf(j: Journey, i: number): Station {
  const id = STEPS[i]!.id;
  if (j.skipped?.includes(id)) return "skipped";
  if (!j.current) return "done";
  const at = STEPS.findIndex((s) => s.id === j.current);
  return i < at ? "done" : i === at ? "active" : "todo";
}

const STATE_TEXT = { done: "done", active: "now", todo: "to come", skipped: "not needed" } as const;

function Marker({ state, n, alert }: { state: Station; n: number; alert: boolean }) {
  const base = "relative z-10 grid size-8 shrink-0 place-items-center rounded-full font-display text-sm font-bold";
  if (state === "done")
    return (
      <span aria-hidden="true" className={`${base} ${alert ? "bg-alert" : "bg-sealed"} text-sheet`}>
        {alert ? "↺" : "✓"}
      </span>
    );
  if (state === "active")
    return (
      <span aria-hidden="true" className={`${base} station-active bg-action text-action-ink`}>
        {n}
      </span>
    );
  return (
    <span
      aria-hidden="true"
      className={`${base} border-[1.5px] bg-paper ${state === "skipped" ? "border-dashed border-contour text-contour" : "border-contour text-ink-soft"}`}
    >
      {state === "skipped" ? "–" : n}
    </span>
  );
}

/**
 * The steps, and with `explain` what each one is (the landing page); without
 * it, whose move it is, with `action` beside it when the page has one.
 */
export function Steps({ journey, explain, you, action }: { journey: Journey; explain?: boolean; you?: boolean; action?: ReactNode }) {
  const refunded = journey.outcome === "failed" || journey.outcome === "expired";
  return (
    <section aria-label="Progress" className="flex flex-col gap-5">
      <ol className="grid grid-cols-6">
        {STEPS.map((s, i) => {
          const state = stationOf(journey, i);
          const last = i === STEPS.length - 1;
          const inked = state === "done" && (last || stationOf(journey, i + 1) !== "todo");
          return (
            <li key={s.id} className="relative flex flex-col items-start gap-2">
              {!last && (
                <span
                  aria-hidden="true"
                  className={`absolute top-4 left-8 h-0 w-[calc(100%-2rem)] border-t-2 ${inked ? "border-sealed" : "border-dashed border-contour/70"}`}
                />
              )}
              <Marker state={state} n={i + 1} alert={last && refunded} />
              <span className={`pr-2 ${state === "active" ? "" : "max-sm:sr-only"}`}>
                <span className={`block font-display font-semibold ${state === "todo" || state === "skipped" ? "text-ink-soft" : ""}`}>
                  {last && journey.outcome && !journey.current ? (refunded ? "Refunded" : "Paid") : s.label}
                  <span className="sr-only"> ({STATE_TEXT[state]})</span>
                </span>
                <span className="block text-sm text-ink-soft">{s.role}</span>
                {explain && <span className="mt-1 hidden max-w-[22ch] text-sm leading-snug text-ink-soft lg:block">{s.about}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {!explain && (
        <div
          role="status"
          aria-live="polite"
          className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-2xl border px-5 py-4 ${
            you ? "border-action bg-action/10" : "border-rule bg-sheet"
          }`}
        >
          <p className="font-display text-xl font-semibold text-balance">{nextLine(journey, Boolean(you))}</p>
          {action}
        </div>
      )}
    </section>
  );
}

/** For a step someone else must take: hand the browser to their wallet. */
export function SwitchTo({ account }: { account: string }) {
  const { accountId, connect, switchAccount } = useWallet();
  return (
    <button
      type="button"
      onClick={accountId ? switchAccount : connect}
      className="rounded-full border border-ink px-5 py-2.5 font-display font-semibold hover:bg-ink hover:text-paper"
    >
      {accountId ? "Switch" : "Connect"} to <span className="font-mono text-sm font-normal">{account}</span>
    </button>
  );
}

/** For a step that is yours: take you to where you act. */
export function GoTo({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="rounded-full bg-action px-5 py-2.5 font-display font-semibold text-action-ink">
      {children}
    </a>
  );
}
