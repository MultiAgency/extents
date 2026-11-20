/**
 * The customer's workspace: the conversation with the agent, and beside it
 * the objective taking shape. AG-UI carries both: messages and tool calls
 * for the conversation, the agent's shared state for the plat.
 */
import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { useCallback, useRef, useState } from "react";

import { FRONTEND_TOOLS, parseArgs, pendingCalls } from "../shared/agui-tools.ts";
import { emptyDraft, parseDraft, type DraftState } from "../shared/draft.ts";
import type { LaunchResult } from "../shared/objective.ts";

import { ObjectiveCard, type ToolView } from "./cards.tsx";
import { Composer } from "./chat-ui.tsx";
import { launchJourney } from "./journey.ts";
import { useLaunch } from "./launch.ts";
import { Plat } from "./plat.tsx";
import { GoTo, Steps } from "./steps.tsx";

/** Briefs a demo can start from in one click: testnet accounts, small amounts. */
const BRIEFS = [
  "I have 2 USDC for a NEAR builders meetup in New York by 2027-03-01T00:00:00Z. agency.testnet runs it and gets all of it. I'll judge it myself.",
  "Pay 1 USDC, all to agency.testnet, for a blog post announcing Extents with at least 500 words, live by 2026-12-15T00:00:00Z. I'll judge it myself.",
  "Fund 3 USDC for a NEAR Intents workshop in Lisbon by 2027-02-01T00:00:00Z. agency.testnet runs it and gets all of it; multiagency.sputnikv2.testnet judges.",
];

/** The conversation over AG-UI: frontend tool calls are answered between runs. */
function useAgUiChat(account: string) {
  const agent = useRef<HttpAgent>(null);
  agent.current ??= new HttpAgent({ url: "/api/agent" });
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [ended, setEnded] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  const run = useCallback(async () => {
    const a = agent.current!;
    setRunning(true);
    setError(undefined);
    try {
      await a.runAgent(
        { tools: FRONTEND_TOOLS, forwardedProps: { account } },
        {
          onMessagesChanged: ({ messages }) => setMessages([...messages]),
          onStateChanged: ({ state }) => setDraft(parseDraft(state)),
          onToolCallEndEvent: ({ event }) => setEnded((s) => new Set(s).add(event.toolCallId)),
          // runAgent resolves on RUN_ERROR; this is the only place the error appears
          onRunErrorEvent: ({ event }) => setError(event.message),
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [account]);

  const send = (text: string) => {
    agent.current!.addMessage({ id: crypto.randomUUID(), role: "user", content: text });
    setMessages([...agent.current!.messages]);
    void run();
  };

  /** Answers one frontend call; the next run starts once none is left unanswered. */
  const answer = useCallback(
    (toolCallId: string, output: unknown) => {
      const a = agent.current!;
      if (a.messages.some((m) => m.role === "tool" && m.toolCallId === toolCallId)) return;
      a.addMessage({ id: crypto.randomUUID(), role: "tool", toolCallId, content: JSON.stringify(output) });
      setMessages([...a.messages]);
      if (pendingCalls(a.messages).length === 0) void run();
    },
    [run],
  );

  return { messages, draft, ended, running, error, send, answer };
}

function viewOf<O>(id: string, args: string, result: Message | undefined, ended: ReadonlySet<string>): ToolView<O> {
  if (!ended.has(id)) return { state: "streaming" };
  const input = parseArgs(args);
  if (!result || result.role !== "tool") return { state: "pending", input };
  const content = typeof result.content === "string" ? result.content : "";
  if (result.error) return { state: "error", error: result.error };
  if (content.startsWith("Error: ")) return { state: "error", error: content.slice(7) };
  const output = parseArgs(content);
  if (output && typeof output === "object" && "error" in output && typeof output.error === "string")
    return { state: "error", error: output.error };
  return { state: "done", input, output: output as O };
}

/** What each tool call looks like in the conversation, in the customer's words. */
function activity(name: string, view: ToolView<unknown>): { text: string; state: "working" | "done" | "attention" } {
  if (view.state === "error") return { text: view.error, state: "attention" };
  const out = view.state === "done" ? (view.output as Record<string, unknown> | undefined) : undefined;
  const working = view.state === "streaming";
  switch (name) {
    case "verifier_balance":
      return working
        ? { text: "Reading your USDC balance", state: "working" }
        : { text: `Your balance: ${out?.USDC ?? "?"} USDC`, state: "done" };
    case "update_draft":
      return { text: working ? "Noting the terms" : "Noted the terms", state: working ? "working" : "done" };
    case "propose_spec":
      if (working) return { text: "Checking the spec", state: "working" };
      return out?.ok ? { text: "The spec checks out", state: "done" } : { text: "The spec needs a fix", state: "attention" };
    case "check_accounts": {
      if (working) return { text: "Confirming the accounts", state: "working" };
      const found = Object.values(out ?? {}).filter(Boolean).length;
      const all = Object.keys(out ?? {}).length;
      return { text: `${found} of ${all} accounts found`, state: found === all ? "done" : "attention" };
    }
    case "view_objective":
      return { text: working ? "Reading the objective" : "Read the objective", state: working ? "working" : "done" };
    case "launch_objective":
      if (view.state === "done") {
        const r = view.output as LaunchResult;
        return r.launched ? { text: "Launched and funded", state: "done" } : { text: `Not launched: ${r.reason}`, state: "attention" };
      }
      return { text: working ? "Writing the terms" : "Terms ready to sign", state: working ? "working" : "done" };
    default:
      return { text: name, state: working ? "working" : "done" };
  }
}

const MARK = { working: "◌", done: "✓", attention: "!" } as const;

function Activity({ text, state }: { text: string; state: "working" | "done" | "attention" }) {
  return (
    <p className={`flex items-center gap-2 text-[0.95rem] ${state === "attention" ? "text-alert" : "text-ink-soft"}`}>
      <span aria-hidden="true" className={`w-4 text-center ${state === "working" ? "working" : ""}`}>
        {MARK[state]}
      </span>
      {text}
    </p>
  );
}

/** The plat, driven by the newest launch call once there is one. */
function LaunchPlat({
  draft,
  call,
  view,
  account,
  answer,
}: {
  draft: DraftState;
  call: string;
  view: ToolView<LaunchResult>;
  account: string;
  answer: (id: string, output: unknown) => void;
}) {
  const onDone = useCallback((r: LaunchResult) => answer(call, r), [answer, call]);
  const model = useLaunch(view, account, onDone);
  return <Plat draft={draft} {...(model ? { launch: model } : {})} />;
}

export function Chat({ account }: { account: string }) {
  const { messages, draft, ended, running, error, send, answer } = useAgUiChat(account);
  const results = new Map(messages.flatMap((m) => (m.role === "tool" ? [[m.toolCallId, m] as const] : [])));
  const launches = messages.flatMap((m) =>
    m.role === "assistant" ? (m.toolCalls ?? []).filter((c) => c.function.name === "launch_objective") : [],
  );
  const latest = launches.at(-1);
  const latestView = latest && viewOf<LaunchResult>(latest.id, latest.function.arguments, results.get(latest.id), ended);
  const launched = latestView?.state === "done" && latestView.output.launched ? latestView.output.objective : undefined;
  const declined = latestView?.state === "done" && !latestView.output.launched;
  const journey = launchJourney(
    launched ? "launched" : latest && !declined ? "ready" : "drafting",
    account,
    Object.keys(draft.terms.contributors ?? {}),
  );

  return (
    <div className="flex flex-col gap-8">
      <Steps
        journey={journey}
        you={!launched}
        action={
          launched ? (
            <GoTo href={`/o/${launched}`}>Open the objective page</GoTo>
          ) : journey.current === "fund" ? (
            <GoTo href="#plat">Review and sign</GoTo>
          ) : undefined
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
        <div className="flex flex-col gap-4 lg:order-1 lg:min-h-[60vh]">
          <div role="log" aria-label="Conversation" className="flex flex-col gap-4">
            {messages.length === 0 && (
              <div className="flex flex-col gap-3">
                <p className="font-display text-2xl font-semibold">What should happen?</p>
                <p className="text-ink-soft">Describe it in your own words, or start from one of these.</p>
                <ul className="flex flex-col gap-2">
                  {BRIEFS.map((b) => (
                    <li key={b}>
                      <button
                        type="button"
                        onClick={() => send(b)}
                        className="w-full rounded-xl border border-rule bg-sheet px-4 py-2.5 text-left text-[0.95rem] leading-snug transition-colors hover:border-action hover:bg-action/5"
                      >
                        {b}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {messages.map((m) => {
              if (m.role === "user")
                return (
                  <p key={m.id} className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-paper">
                    {typeof m.content === "string" ? m.content : ""}
                  </p>
                );
              if (m.role !== "assistant") return null;
              return (
                <div key={m.id} className="flex flex-col gap-2">
                  {(m.toolCalls ?? []).map((c) => {
                    const view = viewOf<unknown>(c.id, c.function.arguments, results.get(c.id), ended);
                    if (c.function.name === "view_objective" && view.state === "done")
                      return <ObjectiveCard key={c.id} view={view.output} />;
                    return <Activity key={c.id} {...activity(c.function.name, view)} />;
                  })}
                  {/* the model often opens with blank lines, which pre-wrap would show */}
                  {m.content?.trim() && <p className="max-w-[62ch] whitespace-pre-wrap [overflow-wrap:anywhere]">{m.content.trim()}</p>}
                </div>
              );
            })}
            {running && <Activity text="Thinking" state="working" />}
            {error && (
              <p role="alert" className="text-alert">
                {error}
              </p>
            )}
          </div>
          <Composer busy={running} onSend={send} />
        </div>
        <div id="plat" className="order-first scroll-mt-6 lg:sticky lg:top-6 lg:order-2">
          {latest && latestView ? (
            <LaunchPlat key={latest.id} draft={draft} call={latest.id} view={latestView} account={account} answer={answer} />
          ) : (
            <Plat draft={draft} />
          )}
        </div>
      </div>
    </div>
  );
}
