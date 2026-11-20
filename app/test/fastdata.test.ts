import { afterEach, expect, test, vi } from "vitest";
import { launchDocumentReader, readDeliverables } from "../src/server/fastdata.ts";
import { buildObjective } from "../src/shared/objective.ts";
import { DOCUMENT_KEYS, FASTDATA_URL } from "../src/shared/config.ts";

const CODE = "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa";
const objective = buildObjective(
  {
    spec: {
      v: 1,
      statement: "A report",
      criteria: [{ id: "text", description: "Has report", check: { kind: "contains", phrase: "report", absent: false } }],
    },
    contributors: { "worker.testnet": 100 },
    evaluator: "judge.testnet",
    deadline: "2027-03-01T00:00:00Z",
    amount: "1",
  },
  "sponsor.testnet",
  "ab".repeat(32),
  CODE,
  0,
);

afterEach(() => vi.unstubAllGlobals());

function terms() {
  return vi.fn(async (url: string, init: RequestInit) => {
    const query = JSON.parse(init.body as string);
    expect(query.key).toBeOneOf([DOCUMENT_KEYS.params, DOCUMENT_KEYS.spec]);
    const isParams = query.key === DOCUMENT_KEYS.params;
    expect(url).toBe(`${FASTDATA_URL}/v0/latest/${objective.accountId}${isParams ? "" : "/sponsor.testnet"}`);
    return Response.json({
      entries: [{ predecessor_id: "sponsor.testnet", key: query.key, value: isParams ? objective.params : objective.spec }],
      // Finding the committed Params must not require reading the rest of a polluted namespace.
      ...(isParams ? { page_token: "unrelated-pages" } : {}),
    });
  });
}

test("cold terms lookup filters exact keys and the sponsor, stopping once the commitment verifies", async () => {
  const fetch = terms();
  vi.stubGlobal("fetch", fetch);
  const read = launchDocumentReader();
  expect(await read(objective.accountId, CODE)).toEqual({ params: objective.params, spec: objective.spec });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("verified immutable terms remain readable during an indexer outage; misses and wrong writers are not cached", async () => {
  const read = launchDocumentReader();
  const fetch = terms();
  vi.stubGlobal("fetch", fetch);
  const saved = await read(objective.accountId, CODE);
  fetch.mockRejectedValue(new Error("indexer outage"));
  expect(await read(objective.accountId, CODE)).toEqual(saved);
  expect(fetch).toHaveBeenCalledTimes(2);

  const cold = launchDocumentReader();
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { key } = JSON.parse(init.body as string);
    return Response.json({
      entries: [{ predecessor_id: "attacker.testnet", key, value: key === DOCUMENT_KEYS.params ? objective.params : objective.spec }],
    });
  });
  expect(await cold(objective.accountId, CODE)).toBeUndefined();
  vi.stubGlobal("fetch", terms());
  expect(await cold(objective.accountId, CODE)).toEqual(saved);
});

test("delivery reads target the holder and never accept another writer's report", async () => {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe(`${FASTDATA_URL}/v0/latest/${objective.accountId}/worker.testnet`);
    expect(JSON.parse(init.body as string).key).toBe(DOCUMENT_KEYS.deliverable);
    return Response.json({ entries: [{ predecessor_id: "attacker.testnet", key: DOCUMENT_KEYS.deliverable, value: { text: "forged" } }] });
  });
  await expect(readDeliverables(objective.accountId, ["worker.testnet"])).rejects.toThrow(/proof.*worker.testnet/);
});

test("terms the deployer published for a sponsor with no NEAR key are read; no other writer's are", async () => {
  vi.stubEnv("DEPLOYER_ACCOUNT_ID", "deployer.testnet");
  const asked: string[] = [];
  const by = (writer: string) =>
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const { key } = JSON.parse(init.body as string);
      if (key === DOCUMENT_KEYS.params) return Response.json({ entries: [{ predecessor_id: writer, key, value: objective.params }] });
      const asking = url.split("/").at(-1)!;
      asked.push(asking);
      return Response.json({ entries: asking === writer ? [{ predecessor_id: writer, key, value: objective.spec }] : [] });
    });
  by("deployer.testnet");
  expect(await launchDocumentReader()(objective.accountId, CODE)).toEqual({ params: objective.params, spec: objective.spec });
  // the sponsor's own row first, then the deployer's
  expect(asked).toEqual(["sponsor.testnet", "deployer.testnet"]);

  asked.length = 0;
  by("attacker.testnet");
  expect(await launchDocumentReader()(objective.accountId, CODE)).toBeUndefined();
  expect(asked).toEqual(["sponsor.testnet", "deployer.testnet"]);
  vi.unstubAllEnvs();
});
