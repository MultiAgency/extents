import { afterEach, expect, test, vi } from "vitest";
import { accountExists, describeObjective, sputnikDao, verifierBalance, viewObjective } from "../src/server/chain.ts";
import { query, RPC_READ_MS } from "../src/server/rpc.ts";
import { FASTDATA_URL } from "../src/shared/config.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("RPC reads pass cancellation to the transport and expire even if it ignores the signal", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  let received: AbortSignal | undefined;
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    received = init.signal!;
    return new Promise(() => {});
  });
  const result = expect(query({ request_type: "view_account", account_id: "alice.testnet" })).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(RPC_READ_MS);
  await result;
  expect(received?.aborted).toBe(true);
});

test("a missing account differs from an RPC outage", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } }));
  expect(await accountExists("absent.testnet")).toBe(false);
  vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
  await expect(accountExists("alice.testnet")).rejects.toThrow(/503/);
});

test("reads use finalized state and preserve view arguments", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { params } = JSON.parse(init.body as string);
    requests.push(params);
    return Response.json({
      result:
        params.request_type === "view_account"
          ? {}
          : {
              result: [...new TextEncoder().encode(JSON.stringify(params.method_name === "mt_balance_of" ? "1234567" : { funded: "12" }))],
            },
    });
  });
  expect(await viewObjective("objective.testnet")).toEqual({ funded: "12" });
  expect(await verifierBalance("sponsor.testnet")).toBe(1234567n);
  expect(requests.every((r) => r.finality === "final")).toBe(true);
  expect(JSON.parse(Buffer.from(requests.at(-1)!.args_base64 as string, "base64").toString())).toMatchObject({
    account_id: "sponsor.testnet",
  });
});

test("a DAO lookup outage is not reported as a non-DAO evaluator", async () => {
  vi.stubGlobal("fetch", async () => new Response("outage", { status: 503 }));
  await expect(sputnikDao("dao.testnet")).rejects.toThrow(/503/);
  vi.stubGlobal("fetch", async () => Response.json({ result: { error: "MethodResolveError(MethodNotFound)" } }));
  expect(await sputnikDao("person.testnet")).toBeUndefined();
  // FastNEAR's words for an account with no contract at all
  vi.stubGlobal("fetch", async () =>
    Response.json({
      result: { error: 'wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "person.testnet" })' },
    }),
  );
  expect(await sputnikDao("person.testnet")).toBeUndefined();
});

test("a failed document lookup cancels sibling RPC reads instead of leaving work behind", async () => {
  vi.stubEnv("PUBLIC_OBJECTIVE_CODE_HASH", "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa");
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.startsWith(FASTDATA_URL)) return new Response("indexer outage", { status: 503 });
    signals.push(init.signal!);
    return new Promise(() => {});
  });
  await expect(describeObjective("0s" + "cd".repeat(20))).rejects.toThrow(/FastData 503/);
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
