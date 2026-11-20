import { useState, type ComponentType } from "react";

import { ObjectivePage } from "./objective-page.tsx";
import { Plat } from "./plat.tsx";
import { useWallet } from "./wallet.tsx";
import type { DraftState } from "../shared/draft.ts";

/** What the landing page shows: an objective as a customer would draft it. */
const SAMPLE: DraftState = {
  terms: {
    statement: "A NEAR builders meetup in New York City for at least 30 people",
    criteria: [
      { id: "event-page", kind: "live_url", description: "The public event page names New York" },
      { id: "attendance", kind: "numeric_match", description: "The report lists at least 30 attendees" },
      { id: "photos", kind: "media", description: "Three photos from the evening" },
    ],
    contributors: { "organizer.testnet": 70, "venue.testnet": 30 },
    evaluator: "newyork.citynode.testnet",
    deadline: "2027-03-01T00:00:00Z",
    amount: "500",
  },
  accounts: {},
};

/** The composer: the text stays editable while the agent works; sending waits for it. */
export function Composer({ busy, onSend }: { busy: boolean; onSend: (text: string) => void }) {
  const [input, setInput] = useState("");
  return (
    <form
      className="sticky bottom-0 mt-auto flex items-end gap-2 bg-paper py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!input.trim() || busy) return;
        onSend(input);
        setInput("");
      }}
    >
      <textarea
        aria-label="Message"
        rows={1}
        className="min-h-12 flex-1 resize-none rounded-2xl border border-rule bg-sheet px-4 py-3 outline-none focus:border-action"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="What outcome do you want to fund?"
      />
      <button
        aria-disabled={busy || undefined}
        className="h-12 rounded-full bg-action px-5 font-display font-semibold text-action-ink aria-disabled:opacity-60"
      >
        Send
      </button>
    </form>
  );
}

/** The page frame. With `objective`, that objective's public page; otherwise the workspace, or the landing page signed out. */
export function Shell({ Chat, objective }: { Chat: ComponentType<{ account: string }>; objective?: string }) {
  const { accountId, connect, disconnect } = useWallet();
  return (
    <div className="mx-auto flex min-h-dvh max-w-7xl flex-col gap-8 px-4 py-6 sm:px-8">
      <header className="flex items-center justify-between gap-4">
        <a href="/" className="font-display text-2xl font-bold tracking-tight">
          Extents
        </a>
        {accountId ? (
          <button className="font-mono text-sm text-ink-soft hover:text-ink" onClick={disconnect}>
            {accountId} <span className="font-sans">· Disconnect</span>
          </button>
        ) : (
          <button className="rounded-full border border-ink px-4 py-2 font-display font-semibold" onClick={connect}>
            Connect wallet
          </button>
        )}
      </header>
      {objective ? (
        <main className="flex-1">
          <h1 className="sr-only">Objective {objective}</h1>
          <ObjectivePage address={objective} />
        </main>
      ) : accountId ? (
        <main className="flex-1">
          <h1 className="sr-only">Fund an objective</h1>
          <Chat account={accountId} />
        </main>
      ) : (
        <main className="grid flex-1 items-center gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="flex flex-col gap-6">
            <h1 className="max-w-[14ch] font-display text-5xl leading-[1.02] font-bold text-balance sm:text-6xl">
              Fund the outcome, not the promise.
            </h1>
            <p className="max-w-[44ch] text-lg text-ink-soft">
              Say what you want to happen. The money waits in escrow on NEAR and goes to the people who make it happen, once an evaluator
              confirms it did.
            </p>
            <button
              onClick={connect}
              className="self-start rounded-full bg-action px-6 py-3 font-display text-lg font-semibold text-action-ink"
            >
              Connect a NEAR wallet to start
            </button>
          </div>
          <Plat draft={SAMPLE} />
        </main>
      )}
    </div>
  );
}
