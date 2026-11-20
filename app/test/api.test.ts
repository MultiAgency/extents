/** Extents for other agents: the JSON API /llms.txt documents, against the app in process. */
import { beforeAll, describe, expect, test } from "vitest";

import { createApp } from "../src/server/app.ts";
import type { Chain } from "../src/server/tools.ts";
import { attestArgs, attestationOf, attestProposal } from "../src/shared/attest.ts";
import { buildObjective, proposal } from "../src/shared/objective.ts";
import { reportHash } from "../src/shared/review.ts";
import { parseReview } from "../src/shared/spec.ts";

const CODE_HASH = "FS91WimvUhXCC6ij7YNwSca6xgT9iER4Qb3LTxqUVkwa";
const PROPOSAL = {
  spec: {
    v: 1,
    statement: "A NEAR builders meetup in NYC.",
    criteria: [{ id: "attendance", description: "Attendance", check: { kind: "numeric_match", label: "Attendees", min: 30 } }],
  },
  contributors: { "organizer.testnet": 100 },
  evaluator: "agency.testnet",
  deadline: "2027-03-01T00:00:00Z",
  amount: "5",
};

const chain: Chain = {
  accountExists: async (a) => !a.startsWith("missing"),
  verifierBalance: async () => 12_500_000n,
  describeObjective: async () => view,
};
let view: Awaited<ReturnType<Chain["describeObjective"]>> = { deployed: true, state: { funded: "5000000" } };
const deployed: unknown[] = [];

let app: ReturnType<typeof createApp>;
const post = async (path: string, body: unknown) => {
  const res = await app.fetch(
    new Request(`https://extents.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, value: await res.json() };
};

beforeAll(() => {
  process.env.PUBLIC_OBJECTIVE_CODE_HASH = CODE_HASH;
  app = createApp({
    model: { name: "unused", stream: () => (async function* () {})() },
    chain,
    deploy: async (params) => (deployed.push(params), { accountId: "0sdeployed", txHash: "TX" }),
    checks: { fetch },
    delivered: async (_, contributors) =>
      contributors.map((contributor) => ({ contributor, text: "Attendees: 34", delivery_hash: reportHash("Attendees: 34") })),
  });
});

describe("tools", () => {
  test("validates a spec with the same rules as the agent", async () => {
    expect((await post("/api/tools/propose_spec", PROPOSAL.spec)).value).toMatchObject({ ok: true });
    expect((await post("/api/tools/propose_spec", { ...PROPOSAL.spec, criteria: [] })).value).toEqual({ ok: false, error: "no criteria" });
  });

  test("refuses a spec a model's answer alone would gate", async () => {
    const judgeOnly = {
      ...PROPOSAL.spec,
      criteria: [{ id: "useful", description: "Useful", check: { kind: "llm_judge", question: "Useful?", models: ["m"] } }],
    };
    expect((await post("/api/tools/propose_spec", judgeOnly)).value).toEqual({
      ok: false,
      error: "every criterion is llm_judge: at least one must be checked by a script",
    });
  });

  test("reads balances and accounts", async () => {
    expect((await post("/api/tools/verifier_balance", { account: "customer.testnet" })).value).toEqual({ USDC: "12.5" });
    expect((await post("/api/tools/check_accounts", { accounts: ["a.testnet", "missing.testnet"] })).value).toEqual({
      "a.testnet": true,
      "missing.testnet": false,
    });
  });

  test("refuses input outside the schema, and says why", async () => {
    const r = await post("/api/tools/verifier_balance", { account: "Not An Account" });
    expect(r.status).toBe(400);
    expect(r.value.error).toMatch(/^invalid input: .*account/s);
    expect((await post("/api/tools/verifier_balance", "{not json")).status).toBe(400);
  });

  test("offers only the protocol tools, not the customer's canvas", async () => {
    expect((await post("/api/tools/update_draft", {})).status).toBe(404);
    expect((await post("/api/tools/nope", {})).value).toEqual({ error: "no tool nope; see /llms.txt" });
  });
});

test("drafts an objective down to its unsigned transactions and its page, at the address the contract will derive", async () => {
  const salt = "ab".repeat(32);
  const { value } = await post("/api/draft", { proposal: PROPOSAL, sponsor: "customer.testnet", salt });
  const expected = buildObjective(proposal.parse(PROPOSAL), "customer.testnet", salt, CODE_HASH);
  expect(value.objective).toBe(expected.accountId);
  expect(value.page).toBe(`https://extents.test/o/${expected.accountId}`);
  expect(value.transactions.map((t: { step: string; signer: string }) => [t.step, t.signer])).toEqual([
    ["publish", "customer.testnet"],
    ["fund", "customer.testnet"],
  ]);
  expect(value.transactions[1].args).toMatchObject({ receiver_id: expected.accountId, amount: "5000000" });
  expect(JSON.parse(value.transactions[1].args.msg)).toEqual({
    params: JSON.parse(JSON.stringify(expected.params)),
    action: { action: "fund" },
  });
  expect((await post("/api/draft", { proposal: PROPOSAL, sponsor: "customer.testnet", salt: "short" })).status).toBe(400);
});

test("deploys through the server's deployer", async () => {
  const valid = buildObjective(proposal.parse(PROPOSAL), "customer.testnet", "ef".repeat(32), CODE_HASH).params;
  expect((await post("/api/deploy", { params: valid })).value).toEqual({ accountId: "0sdeployed", txHash: "TX" });
  expect(deployed).toHaveLength(1);
});

describe("review", () => {
  const o = buildObjective(proposal.parse(PROPOSAL), "customer.testnet", "cd".repeat(32), CODE_HASH);
  const params = JSON.parse(JSON.stringify(o.params));
  const delivered = (extra: Record<string, unknown> = {}) =>
    (view = { deployed: true, state: { funded: "5000000", committed: 1, delivered: 1 }, documents: { params, spec: o.spec }, ...extra });

  test("returns a review that validates, the evaluator's ob_attest, and the page to do it in a wallet", async () => {
    delivered();
    const { value } = await post(`/api/objective/${o.accountId}/review`, {});
    const review = parseReview(value.review, o.spec);
    expect(review.verdict).toBe("achieved");
    expect(value.page).toBe(`https://extents.test/o/${o.accountId}`);
    expect(value.transactions).toEqual([
      expect.objectContaining({ step: "publish", receiver: o.accountId, args: { "extents/v1/review": value.review } }),
      expect.objectContaining({
        step: "attest",
        signer: "agency.testnet",
        method: "ob_attest",
        args: attestArgs(params, attestationOf(review)),
      }),
    ]);
  });

  test("files the attestation as a proposal when the evaluator is a DAO", async () => {
    delivered({ evaluator_dao: { proposal_bond: "100", proposers: ["member.testnet"] } });
    const { value } = await post(`/api/objective/${o.accountId}/review`, {});
    expect(value.transactions[1]).toMatchObject({
      step: "propose",
      receiver: "agency.testnet",
      method: "add_proposal",
      args: attestProposal(o.accountId, params, attestationOf(parseReview(value.review, o.spec))),
      deposit: "100 yocto",
    });
  });

  test("with nothing delivered, the review fails on the missing report alone", async () => {
    view = { deployed: true, state: { delivered: 0 }, documents: { params, spec: o.spec } };
    const { value } = await post(`/api/objective/${o.accountId}/review`, {});
    expect(value.missing).toEqual(Object.keys(params.contributors));
    expect(value.results).toEqual([expect.objectContaining({ criterion_id: "attendance", detail: expect.any(String) })]);
    expect(parseReview(value.review, o.spec)).toMatchObject({
      verdict: "failed",
      deliverables: [],
      missing: Object.keys(params.contributors),
    });
  });

  test("refuses what isn't an account", async () => {
    expect((await post("/api/objective/Not%20An%20Account/review", {})).status).toBe(400);
  });
});
