/** Bounded, cancellable reads. Transaction submission continues through near-kit. */
import { RPC_URL } from "../shared/config.ts";
import { abortable, readCapped, withTimeout } from "./bounded.ts";

export const RPC_READ_MS = 15_000;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

export class RpcReadError extends Error {
  constructor(readonly detail: { message?: string; cause?: { name?: string }; data?: unknown }) {
    super(detail.message ?? "RPC read failed");
  }
}

export async function query<T>(params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const deadline = withTimeout(signal, RPC_READ_MS);
  return abortable(deadline, async () => {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "read", method: "query", params: { finality: "final", ...params } }),
      signal: deadline,
    });
    if (!response.ok) throw new Error(`RPC read answered ${response.status}`);
    const bytes = await readCapped(response, MAX_REPLY_BYTES);
    if (!bytes) throw new Error("RPC read exceeds the response size limit");
    const reply = JSON.parse(new TextDecoder().decode(bytes)) as { result?: T; error?: RpcReadError["detail"] };
    if (reply.error) throw new RpcReadError(reply.error);
    if (reply.result === undefined) throw new Error("RPC read returned no result");
    return reply.result;
  });
}

export async function view<T>(account: string, method: string, signal?: AbortSignal, args: Record<string, unknown> = {}): Promise<T> {
  const reply = await query<{ result?: number[]; error?: string }>(
    {
      request_type: "call_function",
      account_id: account,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
    signal,
  );
  if (reply.error) throw new Error(reply.error);
  if (!Array.isArray(reply.result) || !reply.result.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
    throw new Error("RPC view returned invalid bytes");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(reply.result))) as T;
}
