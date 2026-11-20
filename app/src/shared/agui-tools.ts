/**
 * Transport B's client side of the frontend-tool round trip: the tools the
 * application advertises, and which calls a finished run left for it.
 */
import type { Message, Tool } from "@ag-ui/core";
import { z } from "zod";

import { proposal } from "./objective.ts";

/** Advertised in every run's input; the agent may call only these in the browser. */
export const FRONTEND_TOOLS: Tool[] = [
  {
    name: "launch_objective",
    description:
      "Ask the customer to launch the objective: they review the exact terms on a card, then sign. Returns the objective's account and transaction hashes, or why it was not launched.",
    parameters: z.toJSONSchema(proposal),
  },
];

export interface PendingCall {
  id: string;
  name: string;
  /** Unvalidated: AG-UI carries arguments as text. */
  input: unknown;
}

/** Frontend tool calls in the history that no tool message answers yet. */
export function pendingCalls(messages: Message[]): PendingCall[] {
  const answered = new Set(messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
  const frontend = new Set(FRONTEND_TOOLS.map((t) => t.name));
  return messages.flatMap((m) =>
    m.role === "assistant"
      ? (m.toolCalls ?? [])
          .filter((c) => frontend.has(c.function.name) && !answered.has(c.id))
          .map((c) => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) }))
      : [],
  );
}

export function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
