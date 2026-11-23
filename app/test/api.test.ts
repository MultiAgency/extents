/** Extents for other agents: the JSON API /llms.txt documents, against the app in process. */
import { beforeAll, describe, expect, test } from "vitest";

import { createApp } from "../src/server/app.ts";
import type { Chain } from "../src/server/tools.ts";
import { attestArgs, attestationOf, attestProposal } from "../src/shared/attest.ts";
import { parseLaunchFragment, type LaunchLink } from "../src/shared/launch-link.ts";
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
    deploy: async (params, spec) => (
      deployed.push({ params, spec }),
      { accountId: "0sdeployed", txHash: "TX", ...(spec ? { published: true } : {}) }
    ),
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
  // the page launches it in the sponsor's browser: the fragment rebuilds the same objective
  const page = new URL(value.page);
  expect(page.origin + page.pathname).toBe(`https://extents.test/o/${expected.accountId}`);
  const link = parseLaunchFragment(page.hash) as LaunchLink;
  expect(buildObjective(link.proposal, link.sponsor, link.salt, CODE_HASH).accountId).toBe(expected.accountId);
  expect(value.transactions.map((t: { step: string; signer: string }) => [t.step, t.signer])).toEqual([
    ["publish", "customer.testnet"],
    ["fund", "customer.testnet"],
  ]);
  expect(value.transactions[1].args).toMatchObject({ receiver_id: expected.accountId, amount: "5000000" });
  expect(JSON.parse(value.transactions[1].args.msg)).toEqual({
    params: JSON.parse(JSON.stringify(expected.params)),
    action: { action: "fund" },
  });
  // a sponsor that signs Verifier intents funds with the same message, as a transfer intent
  expect(value.fund_intent).toEqual({
    intent: "transfer",
    receiver_id: expected.accountId,
    tokens: { "nep141:usdc.tidepool-sandbox.testnet": "5000000" },
    msg: value.transactions[1].args.msg,
  });
  expect((await post("/api/draft", { proposal: PROPOSAL, sponsor: "customer.testnet", salt: "short" })).status).toBe(400);
});

test("deploys through the server's deployer, and publishes the terms when given the spec", async () => {
  const o = buildObjective(proposal.parse(PROPOSAL), "customer.testnet", "ef".repeat(32), CODE_HASH);
  expect((await post("/api/deploy", { params: o.params })).value).toEqual({ accountId: "0sdeployed", txHash: "TX" });
  expect((await post("/api/deploy", { params: o.params, spec: o.spec })).value).toEqual({
    accountId: "0sdeployed",
    txHash: "TX",
    published: true,
  });
  expect(deployed).toEqual([
    { params: JSON.parse(JSON.stringify(o.params)) },
    { params: JSON.parse(JSON.stringify(o.params)), spec: o.spec },
  ]);
  // the spec hash in Params pins what the deployer may publish
  const other = { ...o.spec, statement: "Something else entirely." };
  expect(await post("/api/deploy", { params: o.params, spec: other })).toEqual({
    status: 400,
    value: { error: "the spec does not match params.spec_hash" },
  });
  expect(deployed).toHaveLength(2);
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

describe("contribute", () => {
  const o = buildObjective(
    proposal.parse({ ...PROPOSAL, contributors: { "organizer.testnet": 70, "venue.testnet": 30 } }),
    "customer.testnet",
    "12".repeat(32),
    CODE_HASH,
  );
  const params = JSON.parse(JSON.stringify(o.params));
  // organizer.testnet sorts first: slot 0
  const at = (state: Record<string, unknown>) => (view = { deployed: true, state, documents: { params, spec: o.spec } });
  const contribute = (body: unknown) => post(`/api/objective/${o.accountId}/contribute`, body);
  const REPORT = "Attendees: 34";

  test("an uncommitted contributor gets ob_commit, as its wallet and as a raw NEAR call", async () => {
    at({ funded: "5000000" });
    const { value } = await contribute({ account: "organizer.testnet" });
    expect(value).toMatchObject({ slot: 0, committed: false, delivered: false, page: `https://extents.test/o/${o.accountId}` });
    expect(value.transactions).toEqual([
      {
        step: "commit",
        signer: "organizer.testnet",
        receiver: o.accountId,
        method: "ob_commit",
        args: { params },
        gas: "10 Tgas",
        near_call: { receiver_id: o.accountId, method_name: "ob_commit", args: { params }, gas: "10000000000000" },
      },
    ]);
  });

  test("a committed contributor may withdraw until it sends the report, then ob_deliver with its hash", async () => {
    at({ committed: 1 });
    const waiting = (await contribute({ account: "organizer.testnet" })).value;
    const withdraw = { step: "withdraw", signer: "organizer.testnet", method: "ob_withdraw", args: { params } };
    expect(waiting.transactions).toMatchObject([withdraw]);
    expect(waiting.next).toMatch(/Send report/);
    const { value } = await contribute({ account: "organizer.testnet", report: REPORT });
    expect(value.report_sha256).toBe(reportHash(REPORT));
    expect(value.transactions).toMatchObject([
      { step: "deliver", method: "ob_deliver", args: { params, delivery: { hash: reportHash(REPORT) } } },
      withdraw,
    ]);
  });

  test("a report longer than the terms allow is refused before it can be delivered", async () => {
    view = { deployed: true, state: { committed: 1 }, documents: { params, spec: { ...o.spec, max_report_bytes: 5 } } };
    const r = await contribute({ account: "organizer.testnet", report: REPORT });
    expect(r.status).toBe(400);
    expect(r.value.error).toBe("The report is 13 bytes; these terms allow 5.");
  });

  test("after delivering, the report and its transaction become the FastData call that publishes them", async () => {
    at({ committed: 1, delivered: 1 });
    expect((await contribute({ account: "organizer.testnet", report: REPORT })).value.transactions).toEqual([]);
    const tx = "1".repeat(44);
    const { value } = await contribute({ account: "organizer.testnet", report: REPORT, delivery_tx: tx });
    expect(value.transactions).toMatchObject([
      {
        step: "publish",
        signer: "organizer.testnet",
        receiver: o.accountId,
        args: { "extents/v1/deliverable": { text: REPORT, delivery_tx: tx, delivery_signer: "organizer.testnet" } },
      },
    ]);
    const relayed = await contribute({ account: "organizer.testnet", report: REPORT, delivery_tx: tx, delivery_signer: "relayer.testnet" });
    expect(relayed.value.transactions[0].args["extents/v1/deliverable"].delivery_signer).toBe("relayer.testnet");
  });

  test("each slot is its own: the second contributor's state does not follow the first's", async () => {
    at({ committed: 1, delivered: 1 });
    const { value } = await contribute({ account: "venue.testnet" });
    expect(value).toMatchObject({ slot: 1, committed: false, delivered: false });
    expect(value.transactions).toMatchObject([{ step: "commit" }]);
  });

  test("past the deadline nothing commits or delivers, and anyone may close", async () => {
    at({ committed: 1, deadline: "2020-01-01T00:00:00Z" });
    view = { ...view, documents: { params: { ...params, deadline: "2020-01-01T00:00:00Z" }, spec: o.spec } };
    const { value } = await contribute({ account: "organizer.testnet", report: REPORT });
    expect(value.next).toMatch(/deadline to commit and deliver has passed/);
    expect(value.transactions).toMatchObject([{ step: "close", signer: "anyone", method: "ob_close" }]);
  });

  test("a resolved objective offers only close", async () => {
    at({ committed: 3, delivered: 3, outcome: "achieved" });
    const { value } = await contribute({ account: "venue.testnet" });
    expect(value.next).toBe("The objective resolved as achieved.");
    expect(value.transactions.map((t: { step: string }) => t.step)).toEqual(["close"]);
  });

  test("an account with no slot, an unpublished objective and bad input are refused in words", async () => {
    at({});
    const stranger = await contribute({ account: "stranger.testnet" });
    expect(stranger.status).toBe(400);
    expect(stranger.value.error).toMatch(/holds no slot/);
    expect((await contribute({ account: "organizer.testnet", delivery_tx: "not base58!" })).status).toBe(400);
    expect((await contribute({})).status).toBe(400);
    view = { deployed: false };
    expect((await contribute({ account: "organizer.testnet" })).value).toEqual({ error: "This objective has no published terms." });
  });
});
