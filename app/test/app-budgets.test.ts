import { expect, test } from "vitest";
import { createApp } from "../src/server/app.ts";

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
