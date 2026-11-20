/**
 * A scripted NEAR AI Cloud stand-in (OpenAI-compatible chat completions), so
 * the browser tests run the app's real model adapter against a deterministic
 * model. The script
 * advances by the conversation's last message; the first user message picks
 * the scenario.
 */
import { createServer } from "node:http";

type Msg = { role: string; content?: string | null; tool_call_id?: string; tool_calls?: { id: string; function: { name: string } }[] };

const SPEC = {
  v: 1,
  statement: "Organize a NEAR builders meetup in NYC for at least 30 people.",
  criteria: [
    { id: "page", description: "Public event page", check: { kind: "live_url", label: "Event page", must_contain: "New York" } },
    { id: "attendees", description: "Attendance reported", check: { kind: "numeric_match", label: "Attendees", min: 30, max: 10000 } },
  ],
};

const proposal = (shares: Record<string, number>) => ({
  spec: SPEC,
  contributors: shares,
  evaluator: "agency.testnet",
  deadline: "2027-03-01T00:00:00Z",
  amount: "5",
});

function next(messages: Msg[]): { tool: string; args: unknown } | { text: string } {
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  const last = messages.at(-1)!;
  if (last.role === "user") return { tool: "propose_spec", args: SPEC };
  const call = messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.id === last.tool_call_id);
  if (call?.function.name === "propose_spec") {
    const shares = first.includes("bad terms")
      ? { "organizer.testnet": 60, "venue.testnet": 30 }
      : { "organizer.testnet": 70, "venue.testnet": 30 };
    return { tool: "launch_objective", args: proposal(shares) };
  }
  return { text: `Launch result: ${last.content}` };
}

let calls = 0;
const port = Number(process.env.MOCK_LLM_PORT ?? 3125);
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
  let body = "";
  for await (const chunk of req) body += chunk;
  const { messages } = JSON.parse(body) as { messages: Msg[] };
  const step = next(messages);
  const id = `chatcmpl-${++calls}`;
  const chunk = (delta: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  if ("text" in step) {
    for (const word of step.text.split(/(?<= )/)) res.write(chunk({ content: word }));
    res.write(chunk({}, "stop"));
  } else {
    const args = JSON.stringify(step.args);
    res.write(chunk({ tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: step.tool, arguments: "" } }] }));
    for (const piece of args.match(/.{1,24}/gs)!) res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
    res.write(chunk({}, "tool_calls"));
  }
  res.end("data: [DONE]\n\n");
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(`mock LLM on ${address.port}`);
});
