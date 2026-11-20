/**
 * The calls this app signs, byte for byte against the ones `extents-client`
 * builds (`crates/client/tests/vectors/calls.json`, one set per contract
 * Params vector): same receiver, method, arguments, gas and deposit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { attestProposal } from "../src/shared/attest.ts";
import { calls, fundIntent, nearCall, type Call } from "../src/shared/calls.ts";
import type { Params } from "../src/shared/params.ts";

interface Wire {
  receiver: string;
  method: string;
  args: unknown;
  gas: string;
  deposit: string;
}
interface Case {
  name: string;
  account: string;
  calls: Record<"fund" | "commit" | "withdraw" | "deliver" | "attest" | "cancel" | "close", Wire>;
  attest_proposal_kind: unknown;
  intents: Record<"fund", unknown>;
}

const root = join(import.meta.dirname, "../..");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const params = new Map(
  (read("contracts/objective/tests/vectors/params.json") as { name: string; params: Params }[]).map((c) => [c.name, c.params]),
);
const cases: Case[] = read("crates/client/tests/vectors/calls.json");

/** A call in the client's units: gas in gas, deposit in yoctoNEAR, both decimal strings. */
const wire = ({ receiver, method, args, tgas, yocto }: Call): Wire => ({
  receiver,
  method,
  args,
  gas: (BigInt(tgas) * 10n ** 12n).toString(),
  deposit: (yocto ?? 0n).toString(),
});

describe.each(cases)("$name", (c) => {
  const p = params.get(c.name)!;
  const attestation = { verdict: "achieved" as const };

  // Deep equality also compares the message string byte for byte.
  test("fund", () => expect(wire(calls.fund(c.account, p, 1000n))).toEqual(c.calls.fund));
  test("fund intent", () => expect(fundIntent(c.account, p, 1000n)).toEqual(c.intents.fund));
  test("commit", () => expect(wire(calls.commit(c.account, p))).toEqual(c.calls.commit));
  test("withdraw", () => expect(wire(calls.withdraw(c.account, p))).toEqual(c.calls.withdraw));
  test("cancel", () => expect(wire(calls.cancel(c.account, p))).toEqual(c.calls.cancel));
  test("deliver", () => expect(wire(calls.deliver(c.account, p, "01".repeat(32)))).toEqual(c.calls.deliver));
  test("attest", () => expect(wire(calls.attest(c.account, p, attestation))).toEqual(c.calls.attest));
  test("close", () => expect(wire(calls.close(c.account, p))).toEqual(c.calls.close));
  // the proposal's description is free text; its kind is what the DAO executes
  test("attest proposal", () => expect(attestProposal(c.account, p, attestation).proposal.kind).toEqual(c.attest_proposal_kind));

  // the same calls as raw NEAR function calls: the client's own units, under the NEAR Intents Agent API's field names
  test("near_call", () => {
    for (const [name, call] of [
      ["fund", calls.fund(c.account, p, 1000n)],
      ["commit", calls.commit(c.account, p)],
      ["deliver", calls.deliver(c.account, p, "01".repeat(32))],
      ["attest", calls.attest(c.account, p, attestation)],
      ["close", calls.close(c.account, p)],
    ] as const) {
      const pinned = c.calls[name];
      const { deposit, ...rest } = nearCall(call);
      expect({ ...rest, deposit: deposit ?? "0" }, name).toEqual({
        receiver_id: pinned.receiver,
        method_name: pinned.method,
        args: pinned.args,
        gas: pinned.gas,
        deposit: pinned.deposit,
      });
    }
  });
});

/**
 * The limits `POST /v1/agents/{agent_id}/native/near/call` puts on its body, from the Agent API's
 * OpenAPI (api.agentsonintents.com/openapi.json, read 2026-11-20). A copy, so a call this app
 * builds that the API would refuse on shape fails here. It cannot show that the API accepts one:
 * that API is mainnet-only and this app has never called it.
 */
const NEAR_CALL_BODY = {
  receiver_id: /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/,
  method_name: /^[A-Za-z0-9_]+$/,
  gas: /^[0-9]{1,20}$/,
  deposit: /^[0-9]{1,78}$/,
};

test("every call on an objective fits the Agent API's near/call body", () => {
  const c = cases[0]!;
  const p = params.get(c.name)!;
  for (const call of [
    calls.commit(c.account, p),
    calls.deliver(c.account, p, "01".repeat(32)),
    calls.attest(c.account, p, { verdict: "failed" }),
    calls.close(c.account, p),
    calls.publish(c.account, { deliverable: { text: "report", delivery_tx: "TX", delivery_signer: "alice.near" } }),
    calls.propose(c.account, p, { verdict: "failed" }, "100000000000000000000000"),
  ]) {
    const body = nearCall(call);
    expect(Object.keys(body).sort(), call.method).toEqual(
      ["args", "deposit", "gas", "method_name", "receiver_id"].filter((k) => k !== "deposit" || call.yocto !== undefined),
    );
    expect(body.receiver_id.length, call.method).toBeLessThanOrEqual(64);
    expect(body.method_name.length, call.method).toBeLessThanOrEqual(256);
    for (const [field, pattern] of Object.entries(NEAR_CALL_BODY)) {
      const value = (body as Record<string, unknown>)[field];
      if (value !== undefined) expect(value, `${call.method} ${field}`).toMatch(pattern);
    }
    expect(body.args, call.method).toBeTypeOf("object");
  }
});
