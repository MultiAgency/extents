/** NEAR AI's streamed chat completions, read as the agent loop consumes them. */
import { describe, expect, test } from "vitest";

import { readChatStream, type ModelChunk } from "../src/server/model.ts";

const sse = (...chunks: object[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n").body!;
const choice = (delta: object, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });

async function read(body: ReadableStream<Uint8Array>) {
  const chunks: ModelChunk[] = [];
  for await (const c of readChatStream(body)) chunks.push(c);
  return chunks;
}

describe("readChatStream", () => {
  test("text passes through as it arrives", async () => {
    const chunks = await read(sse(choice({ content: "Hel" }), choice({ content: "lo." }), choice({}, "stop")));
    expect(chunks).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo." },
      { type: "done", reply: { text: "Hello.", calls: [], finish: "stop" } },
    ]);
  });

  test("tool calls are assembled from fragments, in index order", async () => {
    const chunks = await read(
      sse(
        choice({ tool_calls: [{ index: 1, id: "b", function: { name: "check_accounts", arguments: "" } }] }),
        choice({ tool_calls: [{ index: 0, id: "a", function: { name: "verifier_balance", arguments: '{"acc' } }] }),
        choice({ tool_calls: [{ index: 0, function: { arguments: 'ount":"x.testnet"}' } }] }),
        choice({ tool_calls: [{ index: 1, function: { arguments: '{"accounts":["y.testnet"]}' } }] }),
        choice({}, "tool_calls"),
      ),
    );
    expect(chunks.at(-1)).toEqual({
      type: "done",
      reply: {
        text: "",
        finish: "tool_calls",
        calls: [
          { id: "a", name: "verifier_balance", arguments: '{"account":"x.testnet"}' },
          { id: "b", name: "check_accounts", arguments: '{"accounts":["y.testnet"]}' },
        ],
      },
    });
  });

  test("a stream that ends without a finish reason counts as cut off", async () => {
    const chunks = await read(
      sse(choice({ tool_calls: [{ index: 0, id: "a", function: { name: "verifier_balance", arguments: '{"acc' } }] })),
    );
    expect(chunks.at(-1)).toMatchObject({ reply: { finish: "length" } });
  });

  test("chunks split mid-line still parse", async () => {
    const text = `data: ${JSON.stringify(choice({ content: "split" }))}\n\ndata: ${JSON.stringify(choice({}, "stop"))}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    expect((await read(body)).at(-1)).toEqual({ type: "done", reply: { text: "split", calls: [], finish: "stop" } });
  });
});
