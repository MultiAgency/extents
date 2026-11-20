import { TOKEN } from "../shared/config.ts";
import { formatUnits } from "../shared/objective.ts";
import type { Spec } from "../shared/spec.ts";

/**
 * A tool call as the page sees it. Inputs are untrusted: AG-UI carries
 * arguments as text nobody validated.
 */
export type ToolView<O> =
  | { state: "streaming" }
  | { state: "pending"; input: unknown }
  | { state: "done"; input: unknown; output: O }
  | { state: "error"; error: string };

/** A launched objective's state, as `view_objective` read it. */
export function ObjectiveCard({ view }: { view: unknown }) {
  const v = view as {
    error?: string;
    deployed?: boolean;
    state?: { funded?: string; outcome?: string };
    documents?: { spec: Spec };
  };
  if (v.error) return <p className="text-alert">Couldn't read the objective: {v.error}</p>;
  const status = v.state?.outcome ?? (v.deployed ? "open" : "not deployed");
  return (
    <section aria-label="Objective status" className="rounded-2xl border border-rule bg-sheet px-4 py-3">
      {v.documents && <p className="font-display text-lg font-semibold">{v.documents.spec.statement}</p>}
      <p className="text-ink-soft">
        {formatUnits(v.state?.funded ?? "0")} {TOKEN.symbol} in escrow · {status}
      </p>
    </section>
  );
}
