import { afterEach, beforeEach, expect, test, vi } from "vitest";
import vectors from "../../contracts/objective/tests/vectors/params.json" with { type: "json" };
import { deployObjective } from "../src/server/chain.ts";
import { buildObjective } from "../src/shared/objective.ts";
import { objectiveAccountId, type Params } from "../src/shared/params.ts";

const calls = vi.hoisted(() => ({
  exists: vi.fn(),
  stateInit: vi.fn(),
  send: vi.fn(),
  functionCall: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("near-kit", async (original) => ({
  ...(await original<typeof import("near-kit")>()),
  Near: class {
    accountExists = calls.exists;
    transaction() {
      return {
        stateInit: (...args: unknown[]) => {
          calls.stateInit(...args);
          return { send: calls.send };
        },
        functionCall: (...args: unknown[]) => {
          calls.functionCall(...args);
          return { send: calls.publish };
        },
      };
    }
  },
}));

beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.includes("/v0/latest/")) return Response.json({ entries: [] }); // nothing published yet
    const { params } = JSON.parse(init.body as string);
    expect(params.request_type).toBe("view_account");
    return Response.json(
      (await calls.exists(params.account_id))
        ? { result: {} }
        : { error: { message: "Account missing", cause: { name: "UNKNOWN_ACCOUNT" } } },
    );
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("deploy needs only configured code identity and credentials, with no local release files", async () => {
  const vector = vectors[0]!;
  const params = vector.params as unknown as Params;
  vi.stubEnv("PUBLIC_OBJECTIVE_CODE_HASH", vector.code_hash);
  vi.stubEnv("DEPLOYER_ACCOUNT_ID", "deployer.testnet");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", "ed25519:mock-key");
  vi.stubEnv("OBJECTIVE_RELEASE_MANIFEST", undefined);
  calls.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  calls.send.mockResolvedValue({ transaction: { hash: "deployment-tx" } });

  const account = objectiveAccountId(params, vector.code_hash);
  expect(await deployObjective(params)).toEqual({ accountId: account, txHash: "deployment-tx" });
  expect(calls.stateInit).toHaveBeenCalledWith(expect.objectContaining({ code: { codeHash: vector.code_hash }, deposit: 0n }));
  expect(calls.exists).toHaveBeenNthCalledWith(2, account);
});

test("an existing derived objective needs no deployer credentials", async () => {
  const vector = vectors[0]!;
  vi.stubEnv("PUBLIC_OBJECTIVE_CODE_HASH", vector.code_hash);
  vi.stubEnv("DEPLOYER_ACCOUNT_ID", undefined);
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", undefined);
  calls.exists.mockResolvedValueOnce(true);
  expect(await deployObjective(vector.params as unknown as Params)).toEqual({ accountId: vector.account_id });
  expect(calls.stateInit).not.toHaveBeenCalled();
});

test("with the spec, the deployer publishes the terms, its receipt failing by design", async () => {
  const code = vectors[0]!.code_hash;
  vi.stubEnv("PUBLIC_OBJECTIVE_CODE_HASH", code);
  vi.stubEnv("DEPLOYER_ACCOUNT_ID", "deployer.testnet");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", "ed25519:mock-key");
  const o = buildObjective(
    {
      spec: {
        v: 1,
        statement: "A report",
        criteria: [{ id: "t", description: "Has it", check: { kind: "contains", phrase: "x", absent: false } }],
      },
      contributors: { "worker.testnet": 100 },
      evaluator: "judge.testnet",
      deadline: "2027-03-01T00:00:00Z",
      amount: "1",
    },
    "0x1111111111111111111111111111111111111111",
    "cd".repeat(32),
    code,
    0,
  );
  calls.exists.mockResolvedValue(true); // already deployed: only the terms are missing
  calls.publish.mockRejectedValue(new Error("MethodResolveError(MethodNotFound)"));

  expect(await deployObjective(o.params, o.spec)).toEqual({ accountId: o.accountId, published: true });
  expect(calls.stateInit).not.toHaveBeenCalled();
  expect(calls.functionCall).toHaveBeenCalledWith(
    o.accountId,
    "__fastdata_kv",
    { "extents/v1/params": o.params, "extents/v1/spec": o.spec },
    { gas: "20 Tgas" },
  );

  // a spec the terms don't commit to is never published
  await expect(deployObjective(o.params, { ...o.spec, statement: "Other" })).rejects.toThrow("does not match params.spec_hash");
  expect(calls.functionCall).toHaveBeenCalledTimes(1);
});
