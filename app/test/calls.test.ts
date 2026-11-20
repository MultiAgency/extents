/**
 * The calls this app signs, byte for byte against the ones `extents-client`
 * builds (`crates/client/tests/vectors/calls.json`, one set per contract
 * Params vector): same receiver, method, arguments, gas and deposit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { attestProposal } from "../src/shared/attest.ts";
import { calls, type Call } from "../src/shared/calls.ts";
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
  calls: Record<"fund" | "commit" | "deliver" | "attest" | "close", Wire>;
  attest_proposal_kind: unknown;
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
  test("commit", () => expect(wire(calls.commit(c.account, p))).toEqual(c.calls.commit));
  test("deliver", () => expect(wire(calls.deliver(c.account, p, "01".repeat(32)))).toEqual(c.calls.deliver));
  test("attest", () => expect(wire(calls.attest(c.account, p, attestation))).toEqual(c.calls.attest));
  test("close", () => expect(wire(calls.close(c.account, p))).toEqual(c.calls.close));
  // the proposal's description is free text; its kind is what the DAO executes
  test("attest proposal", () => expect(attestProposal(c.account, p, attestation).proposal.kind).toEqual(c.attest_proposal_kind));
});
