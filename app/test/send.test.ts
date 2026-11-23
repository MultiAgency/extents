/** Publishing to FastData through a wallet: the by-design failed receipt is not a failure, however the wallet words it. */
import { afterEach, expect, test, vi } from "vitest";
import type { Near } from "near-kit";

import { DOCUMENT_KEYS, FASTDATA_URL } from "../src/shared/config.ts";
import { publishFastData } from "../src/web/send.ts";

const OBJECTIVE = "0s" + "ab".repeat(20);
const TERMS = { params: { sponsor: "s.testnet" }, spec: { v: 1, statement: "x" } };

/** A wallet that answers every send with `error`. */
const wallet = (error: Error) =>
  ({
    transaction: () => ({ functionCall: () => ({ send: async () => Promise.reject(error) }) }),
  }) as unknown as Near;

/** FastData showing `rows` (key to value) from `writer`, and recording what was asked. */
function fastdata(writer: string, rows: Record<string, unknown>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    asked.push(url);
    const { key } = JSON.parse(init.body as string);
    return Response.json({ entries: key in rows ? [{ predecessor_id: writer, key, value: rows[key] }] : [] });
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("a wallet's MethodNotFound is the receipt failing by design", async () => {
  const asked = fastdata("s.testnet", {});
  await publishFastData(wallet(new Error("MethodResolveError(MethodNotFound)")), "s.testnet", OBJECTIVE, TERMS);
  expect(asked).toEqual([]);
});

test("a wallet that calls it a cancellation is believed only once FastData shows every row, exactly", async () => {
  const asked = fastdata("s.testnet", { [DOCUMENT_KEYS.params]: TERMS.params, [DOCUMENT_KEYS.spec]: TERMS.spec });
  await publishFastData(wallet(new Error("Action was cancelled")), "s.testnet", OBJECTIVE, TERMS);
  expect(asked).toContain(`${FASTDATA_URL}/v0/latest/${OBJECTIVE}/s.testnet`);
});

test("a real refusal, with nothing indexed, still fails with the wallet's own error", async () => {
  vi.useFakeTimers();
  fastdata("s.testnet", { [DOCUMENT_KEYS.params]: TERMS.params }); // the spec row never appears
  const sent = publishFastData(wallet(new Error("Action was cancelled")), "s.testnet", OBJECTIVE, TERMS);
  const settled = expect(sent).rejects.toThrow("Action was cancelled");
  await vi.advanceTimersByTimeAsync(10_000);
  await settled;
});

test("rows from another writer, or with other content, don't count", async () => {
  vi.useFakeTimers();
  fastdata("attacker.testnet", { [DOCUMENT_KEYS.params]: TERMS.params, [DOCUMENT_KEYS.spec]: TERMS.spec });
  const other = publishFastData(wallet(new Error("Action was cancelled")), "s.testnet", OBJECTIVE, TERMS);
  const refused = expect(other).rejects.toThrow("Action was cancelled");
  await vi.advanceTimersByTimeAsync(10_000);
  await refused;

  fastdata("s.testnet", { [DOCUMENT_KEYS.params]: { sponsor: "other.testnet" }, [DOCUMENT_KEYS.spec]: TERMS.spec });
  const changed = publishFastData(wallet(new Error("Action was cancelled")), "s.testnet", OBJECTIVE, TERMS);
  const refusedToo = expect(changed).rejects.toThrow("Action was cancelled");
  await vi.advanceTimersByTimeAsync(10_000);
  await refusedToo;
});

test("a refusal the wallet codes as one sent nothing, so it stops at once, without reading FastData", async () => {
  const asked = fastdata("s.testnet", { [DOCUMENT_KEYS.params]: TERMS.params, [DOCUMENT_KEYS.spec]: TERMS.spec });
  const refusal = Object.assign(new Error("User rejected the request"), { code: 4001 });
  await expect(publishFastData(wallet(refusal), "s.testnet", OBJECTIVE, TERMS)).rejects.toThrow("User rejected");
  expect(asked).toEqual([]);
});
