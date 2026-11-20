/** Bodies are read against a cap as they stream, never buffered whole. */
import { afterEach, expect, test, vi } from "vitest";

import { readCapped } from "../src/server/bounded.ts";
import { readLaunchDocuments } from "../src/server/fastdata.ts";

/** A body that never ends, counting what was pulled from it. */
function endless(chunk = 64 * 1024) {
  const pulled = { bytes: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled.bytes += chunk;
      c.enqueue(new Uint8Array(chunk).fill(0x20));
    },
  });
  return { res: new Response(body), pulled };
}

afterEach(() => vi.unstubAllGlobals());

test("readCapped stops at the cap", async () => {
  const { res, pulled } = endless();
  expect(await readCapped(res, 1024 * 1024)).toBeUndefined();
  expect(pulled.bytes).toBeLessThanOrEqual(1024 * 1024 + 2 * 64 * 1024);
  expect(await readCapped(new Response("abc"), 3)).toEqual(new TextEncoder().encode("abc"));
});

test("a FastData page larger than its cap is refused without being buffered", async () => {
  const { res, pulled } = endless();
  vi.stubGlobal("fetch", async () => res);
  await expect(readLaunchDocuments("0s" + "ab".repeat(20), "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa")).rejects.toThrow(
    /exceed the size/,
  );
  expect(pulled.bytes).toBeLessThanOrEqual(4 * 1024 * 1024 + 2 * 64 * 1024);
});

test("pages that each fit are still capped together", async () => {
  let pages = 0;
  const filler = "x".repeat(3 * 1024 * 1024);
  vi.stubGlobal("fetch", async () => {
    pages++;
    return Response.json({
      entries: [{ predecessor_id: "a.testnet", key: "note", value: filler, block_height: pages }],
      page_token: `p${pages}`,
    });
  });
  await expect(readLaunchDocuments("0s" + "ab".repeat(20), "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa")).rejects.toThrow(
    /exceed the size/,
  );
  expect(pages).toBe(6);
});

test("a published spec beyond the app's limits is flagged unsupported, never compiled", async () => {
  const { buildObjective, proposal } = await import("../src/shared/objective.ts");
  const { objectiveAccountId } = await import("../src/shared/params.ts");
  const { jcsHash } = await import("../src/shared/jcs.ts");
  const CODE = "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa";
  // valid by its shape, over the size limit, and an invalid schema: compiling it would throw, so any compile shows up as a miss
  const spec = {
    v: 1,
    statement: "A meetup.",
    criteria: [
      { id: "n", description: "Attendance", check: { kind: "numeric_match", label: "Attendees", min: 30 } },
      { id: "s", description: "Data", check: { kind: "schema", json_schema: { type: 12, description: "x".repeat(20_000) } } },
    ],
  };
  const small = buildObjective(
    proposal.parse({
      spec: { ...spec, criteria: [spec.criteria[0]] },
      contributors: { "organizer.testnet": 100 },
      evaluator: "agency.testnet",
      deadline: "2027-03-01T00:00:00Z",
      amount: "5",
    }),
    "customer.testnet",
    "ab".repeat(32),
    CODE,
    Date.parse("2026-11-20T00:00:00Z"),
  );
  const params = { ...JSON.parse(JSON.stringify(small.params)), spec_hash: jcsHash(spec) };
  const objective = objectiveAccountId(params, CODE);
  vi.stubGlobal("fetch", async () =>
    Response.json({
      entries: [
        { predecessor_id: "customer.testnet", key: "extents/v1/params", value: params, block_height: 1 },
        { predecessor_id: "customer.testnet", key: "extents/v1/spec", value: spec, block_height: 1 },
      ],
    }),
  );
  const docs = await readLaunchDocuments(objective, CODE);
  expect(docs?.unsupported).toMatch(/criterion s: json_schema is larger than 16 KiB/);
  expect(docs?.spec).toEqual(spec);
});
