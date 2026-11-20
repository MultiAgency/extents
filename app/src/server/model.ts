/**
 * The agent's model behind one interface: NEAR AI Cloud's OpenAI-compatible
 * chat completions in production, a scripted stand-in in tests. One request per step; the loop streams AG-UI events
 * between steps. The key is sent only to NEAR AI Cloud.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** As the model wrote it: may not parse, which the tool's own check refuses. */
  arguments: string;
}

/** OpenAI chat format, which NEAR AI Cloud takes. */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ModelReply {
  text: string;
  calls: ToolCall[];
  /** `length` and `content_filter` end the run: a cut-off tool input must never run. */
  finish: "stop" | "tool_calls" | "length" | "content_filter";
}

/** A step as it streams: text as the model writes it, then the whole reply. */
export type ModelChunk = { type: "text"; delta: string } | { type: "done"; reply: ModelReply };

export interface ChatModel {
  name: string;
  stream(request: { messages: ChatMessage[]; tools: ToolDefinition[] }, signal: AbortSignal): AsyncIterable<ModelChunk>;
}

/** Fast enough for a chat, TEE-verifiable, with tools: a valid spec through `propose_spec` in 3 s where others took a minute. */
export const DEFAULT_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
export const NEAR_AI_BASE_URL = "https://cloud-api.near.ai/v1";

type Delta = {
  content?: string | null;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
};
type StreamChoice = { delta?: Delta; finish_reason?: string | null };

/**
 * Reads OpenAI-format server-sent chunks: text deltas pass through as they
 * arrive; tool calls are assembled from pieces keyed by `index`, since a
 * call's id and name come once and its arguments in fragments.
 */
export async function* readChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ModelChunk> {
  const decoder = new TextDecoder();
  const calls = new Map<number, ToolCall>();
  let text = "";
  let finishReason: string | null = null;
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const choice = (JSON.parse(data) as { choices?: StreamChoice[] }).choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          text += choice.delta.content;
          yield { type: "text", delta: choice.delta.content };
        }
        for (const piece of choice.delta?.tool_calls ?? []) {
          const call = calls.get(piece.index) ?? { id: "", name: "", arguments: "" };
          calls.set(piece.index, {
            id: piece.id ?? call.id,
            name: piece.function?.name ?? call.name,
            arguments: call.arguments + (piece.function?.arguments ?? ""),
          });
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const assembled = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
  // a stream that ends without saying why may have been cut: its calls are not run
  const finish =
    finishReason === null || finishReason === "length"
      ? "length"
      : finishReason === "content_filter"
        ? "content_filter"
        : assembled.length
          ? "tool_calls"
          : "stop";
  yield { type: "done", reply: { text, calls: assembled, finish } };
}

const RETRIED = new Set([429, 500, 502, 503, 504]);

export function nearAiModel({
  apiKey,
  model = DEFAULT_MODEL,
  baseUrl = NEAR_AI_BASE_URL,
  send = fetch,
  retryMs = 1_000,
}: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  send?: typeof fetch;
  retryMs?: number;
}): ChatModel {
  return {
    name: model,
    async *stream({ messages, tools }, signal) {
      const body = JSON.stringify({
        model,
        messages,
        tools: tools.map((t) => ({ type: "function", function: t })),
        stream: true,
        max_tokens: 4096,
      });
      // retried only before anything streamed, so no text is ever sent twice
      for (let attempt = 0; ; attempt++) {
        const response = await send(`${baseUrl}/chat/completions`, {
          method: "POST",
          body,
          signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        });
        if (response.ok && response.body) return yield* readChatStream(response.body);
        if (!RETRIED.has(response.status) || attempt === 2) throw new Error(`NEAR AI Cloud answered ${response.status}`);
        await new Promise((r) => setTimeout(r, retryMs * (attempt + 1)));
      }
    },
  };
}
