/**
 * An empty testnet for the browser tests' server: every account unknown,
 * every Verifier balance zero, nothing published on FastData, no
 * transaction found. Pages mock what they show; this keeps the server's own
 * reads (a launch's confirmation, the agent's tools) off the public RPC.
 */
import { createServer } from "node:http";

const port = Number(process.env.MOCK_CHAIN_PORT ?? 3126);
const bytes = (value: unknown) => [...new TextEncoder().encode(JSON.stringify(value))];

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = (value: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
  // FastData: POST /v0/latest/<objective>[/<writer>]
  if (req.url?.startsWith("/v0/latest/")) return json({ entries: [] });
  const { id, method, params } = JSON.parse(body || "{}") as { id?: string; method?: string; params?: Record<string, string> };
  const error = (name: string) => json({ jsonrpc: "2.0", id, error: { message: name, cause: { name } } });
  if (method !== "query") return error("UNKNOWN_TRANSACTION");
  if (params?.request_type === "call_function" && params.method_name === "mt_balance_of")
    return json({ jsonrpc: "2.0", id, result: { result: bytes("0"), logs: [] } });
  return error("UNKNOWN_ACCOUNT");
}).listen(port);
