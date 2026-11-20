import { expect, test } from "vitest";
import { createApp } from "../src/server/app.ts";
import { vi } from "vitest";

function app() {
  return createApp({
    model: { name: "unused", stream: () => (async function* () {})() },
    chain: { accountExists: async () => false, verifierBalance: async () => 0n, describeObjective: async () => ({ deployed: false }) },
    deploy: async () => {
      throw new Error("must not deploy");
    },
    checks: { fetch },
    delivered: async () => [],
  });
}

test("oversized bodies are rejected before any paid work", async () => {
  const response = await app().request("/api/deploy", { method: "POST", body: "x".repeat(256 * 1024 + 1) });
  expect(response.status).toBe(413);
});

test("concurrency stays reserved until the response is consumed or cancelled", async () => {
  const api = app();
  const pending = await Promise.all(Array.from({ length: 4 }, () => api.request("/api/objective/objective.testnet")));
  const refused = await api.request("/api/objective/objective.testnet");
  expect(refused.status).toBe(429);
  await pending[0]!.body!.cancel();
  const allowed = await api.request("/api/objective/objective.testnet");
  expect(allowed.status).toBe(200);
  await allowed.text();
  await Promise.all(pending.slice(1).map((r) => r.text()));
});

test("reads don't spend the hourly allowance", async () => {
  const api = app();
  for (let i = 0; i < 250; i++) {
    const res = await api.request(`/api/objective/account${i}.testnet`);
    expect(res.status).toBe(200);
    await res.text();
  }
});

test("disconnecting stalled reads cancels their chain work and frees all response slots", async () => {
  const signals: AbortSignal[] = [];
  const describe = vi.fn((_id: string, signal?: AbortSignal) => {
    signals.push(signal!);
    return new Promise<{ deployed: boolean }>(() => {});
  });
  const api = createApp({
    model: { name: "unused", stream: () => (async function* () {})() },
    chain: { accountExists: async () => false, verifierBalance: async () => 0n, describeObjective: describe },
    deploy: async () => ({ accountId: "unused.testnet" }),
    checks: { fetch },
    delivered: async () => [],
  });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((c) => api.request(new Request("http://test/api/objective/objective.testnet", { signal: c.signal })));
  await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(4));
  expect((await api.request("/api/objective/objective.testnet")).status).toBe(429);
  controllers.forEach((c) => c.abort());
  for (const response of await Promise.all(pending)) {
    expect(response.status).toBe(502);
    await response.text();
  }
  expect(signals.every((s) => s.aborted)).toBe(true);
  describe.mockResolvedValue({ deployed: false });
  const recovered = await api.request("/api/objective/objective.testnet");
  expect(recovered.status).toBe(200);
  await recovered.text();
});

test("cancelling a check stream stops a hung chain read and releases its slot", async () => {
  let chainSignal: AbortSignal | undefined;
  const api = createApp({
    model: { name: "unused", stream: () => (async function* () {})() },
    chain: {
      accountExists: async () => false,
      verifierBalance: async () => 0n,
      describeObjective: async (_id, signal) => {
        chainSignal = signal;
        return new Promise(() => {});
      },
    },
    deploy: async () => ({ accountId: "unused.testnet" }),
    checks: { fetch },
    delivered: async () => [],
  });
  const response = await api.request("/api/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "t",
      runId: "r",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: { objective: "objective.testnet", deliverable: { text: "report" } },
    }),
  });
  const reader = response.body!.getReader();
  await reader.read();
  await vi.waitFor(() => expect(chainSignal).toBeDefined());
  await reader.cancel();
  expect(chainSignal?.aborted).toBe(true);
});

test("costly work shares one process-wide hourly ceiling, whoever claims to call", async () => {
  const api = app();
  const check = (account: string) =>
    api.request("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "t", runId: account, messages: [], tools: [], context: [], state: {}, forwardedProps: { account } }),
    });
  for (let i = 0; i < 200; i++) await (await check(`a${i}.testnet`)).text();
  expect((await check("different.testnet")).status).toBe(429);
  // invalid input is refused before it can spend anything
  expect((await api.request("/api/evaluate", { method: "POST", body: "{}" })).status).toBe(400);
});
