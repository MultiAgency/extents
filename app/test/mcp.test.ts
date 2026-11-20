/** Extents over MCP, through the SDK's own client, against the app in process. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

let client: Client;
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { isError: r.isError ?? false, value: r.isError ? r.content[0]!.text : JSON.parse(r.content[0]!.text) };
};

beforeAll(async () => {
  process.env.PUBLIC_OBJECTIVE_CODE_HASH = CODE_HASH;
  const app = createApp({
    model: { name: "unused", stream: () => (async function* () {})() },
    chain,
    deploy: async (params) => (deployed.push(params), { accountId: "0sdeployed", txHash: "TX" }),
    checks: { fetch },
    delivered: async (_, contributors) =>
      contributors.map((contributor) => ({ contributor, text: "Attendees: 34", delivery_hash: reportHash("Attendees: 34") })),
  });
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test/mcp"), {
      fetch: ((url: string, init: RequestInit) => app.fetch(new Request(url, init))) as never,
    }),
  );
});

describe("MCP", () => {
  test("lists the protocol tools, not the canvas one", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "check_accounts",
      "deploy_objective",
      "draft_objective",
      "evaluate_objective",
      "propose_spec",
      "verifier_balance",
      "view_objective",
    ]);
  });

  test("validates a spec with the same rules as the agent", async () => {
    expect((await call("propose_spec", PROPOSAL.spec)).value).toMatchObject({ ok: true });
    expect((await call("propose_spec", { ...PROPOSAL.spec, criteria: [] })).value).toEqual({ ok: false, error: "no criteria" });
  });

  test("refuses a spec a model's answer alone would gate", async () => {
    const judgeOnly = {
      ...PROPOSAL.spec,
      criteria: [{ id: "useful", description: "Useful", check: { kind: "llm_judge", question: "Useful?", models: ["m"] } }],
    };
    expect((await call("propose_spec", judgeOnly)).value).toEqual({
      ok: false,
      error: "every criterion is llm_judge: at least one must be checked by a script",
    });
  });

  test("refuses input outside the schema", async () => {
    expect((await call("verifier_balance", { account: "Not An Account" })).isError).toBe(true);
  });

  test("drafts an objective down to its unsigned transactions, at the address the contract will derive", async () => {
    const salt = "ab".repeat(32);
    const { value } = await call("draft_objective", { proposal: PROPOSAL, sponsor: "customer.testnet", salt });
    const expected = buildObjective(proposal.parse(PROPOSAL), "customer.testnet", salt, CODE_HASH);
    expect(value.objective).toBe(expected.accountId);
    expect(value.transactions.map((t: { step: string; signer: string }) => [t.step, t.signer])).toEqual([
      ["publish", "customer.testnet"],
      ["fund", "customer.testnet"],
    ]);
    expect(value.transactions[1].args).toMatchObject({ receiver_id: expected.accountId, amount: "5000000" });
    expect(JSON.parse(value.transactions[1].args.msg)).toEqual({
      params: JSON.parse(JSON.stringify(expected.params)),
      action: { action: "fund" },
    });
  });

  test("deploys through the server's deployer", async () => {
    expect((await call("deploy_objective", { params: { sponsor: "x" } })).value).toEqual({ accountId: "0sdeployed", txHash: "TX" });
    expect(deployed).toHaveLength(1);
  });

  test("reads balances", async () => {
    expect((await call("verifier_balance", { account: "customer.testnet" })).value).toEqual({ USDC: "12.5" });
  });

  describe("evaluate_objective", () => {
    const o = buildObjective(proposal.parse(PROPOSAL), "customer.testnet", "cd".repeat(32), CODE_HASH);
    const params = JSON.parse(JSON.stringify(o.params));
    const delivered = (extra: Record<string, unknown> = {}) =>
      (view = { deployed: true, state: { funded: "5000000", committed: 1, delivered: 1 }, documents: { params, spec: o.spec }, ...extra });

    test("returns a review that validates and the evaluator's ob_attest", async () => {
      delivered();
      const { value } = await call("evaluate_objective", { objective: o.accountId });
      const review = parseReview(value.review, o.spec);
      expect(review.verdict).toBe("achieved");
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
      const { value } = await call("evaluate_objective", { objective: o.accountId });
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
      const { value } = await call("evaluate_objective", { objective: o.accountId });
      expect(value.missing).toEqual(Object.keys(params.contributors));
      expect(parseReview(value.review, o.spec)).toMatchObject({
        verdict: "failed",
        deliverables: [],
        missing: Object.keys(params.contributors),
      });
    });
  });
});
