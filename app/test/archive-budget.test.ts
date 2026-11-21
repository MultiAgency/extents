/** One objective's share of the evidence archive. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { ArchiveBudgetError, evidenceArchive, withObjectiveBudget, type ObjectiveUsage } from "../src/server/archive.ts";
import { runCheck } from "../src/server/checks.ts";
import { MAX_EVIDENCE_BYTES } from "../src/server/evidence-fetch.ts";
import type { Criterion, Spec } from "../src/shared/spec.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const recorder = () => {
  const stored: string[] = [];
  return { stored, archive: async (b: Uint8Array) => void stored.push(new TextDecoder().decode(b)) };
};

describe("withObjectiveBudget", () => {
  test("counts distinct bytes once, so re-evaluating an objective does not spend its share twice", async () => {
    const usage: ObjectiveUsage = new Map();
    const { archive, stored } = recorder();
    const write = withObjectiveBudget(archive, usage, "a.testnet", 10);
    await write(bytes("aaaaaa"));
    await write(bytes("aaaaaa")); // seen: free, and not written again
    expect(stored).toEqual(["aaaaaa"]);
    expect(usage.get("a.testnet")?.bytes).toBe(6);
    await expect(write(bytes("bbbbbb"))).rejects.toBeInstanceOf(ArchiveBudgetError);
    await write(bytes("bbbb")); // exactly the rest
    expect(usage.get("a.testnet")?.bytes).toBe(10);
  });

  test("one objective's budget does not limit another's", async () => {
    const usage: ObjectiveUsage = new Map();
    const { archive } = recorder();
    const a = withObjectiveBudget(archive, usage, "a.testnet", 5);
    const b = withObjectiveBudget(archive, usage, "b.testnet", 5);
    await a(bytes("12345"));
    await expect(a(bytes("6"))).rejects.toThrow(/share of the evidence archive/);
    await b(bytes("abcde"));
  });

  test("a failed write gives its reservation back, and the error is the archive's own", async () => {
    const usage: ObjectiveUsage = new Map();
    let failing = true;
    const write = withObjectiveBudget(
      async () => {
        if (failing) throw new Error("EACCES");
      },
      usage,
      "a.testnet",
      6,
    );
    await expect(write(bytes("aaaaaa"))).rejects.toThrow("EACCES");
    expect(usage.get("a.testnet")).toMatchObject({ bytes: 0 });
    failing = false;
    await write(bytes("aaaaaa")); // would be refused if the failed attempt still counted
    expect(usage.get("a.testnet")?.bytes).toBe(6);
  });

  test("concurrent writes cannot overshoot the share", async () => {
    const usage: ObjectiveUsage = new Map();
    const slow = async () => new Promise<void>((resolve) => setTimeout(resolve, 5));
    const write = withObjectiveBudget(slow, usage, "a.testnet", 10);
    const outcomes = await Promise.allSettled(["1111", "2222", "3333", "4444", "5555"].map((t) => write(bytes(t))));
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(2);
    expect(usage.get("a.testnet")?.bytes).toBe(8);
  });
});

describe("a hostile objective against the real archive", () => {
  const crit: Criterion = { id: "src", description: "d", check: { kind: "sources", min: 1, figures: false } };
  const spec: Spec = { v: 1, statement: "s", criteria: [crit] };
  const report = { text: Array.from({ length: 10 }, (_, i) => `https://evidence-${i}.example.org/p`).join("\n") };
  const dirBytes = (d: string) => readdirSync(d).reduce((n, f) => n + statSync(join(d, f)).size, 0);

  test("stops at its share, and the archive keeps room for everyone else", async () => {
    const directory = mkdtempSync(join(tmpdir(), "budget-"));
    const share = 5 * 1048576;
    const usage: ObjectiveUsage = new Map();
    const archive = evidenceArchive(directory, 64 * 1048576);
    // every request returns a new, unique body just under the evidence cap, as a hostile host would
    const hostileFetch = (async () => new Response(randomBytes(MAX_EVIDENCE_BYTES - 1))) as unknown as typeof globalThis.fetch;
    const hostile = withObjectiveBudget(archive, usage, "hostile.testnet", share);

    // without the budget one evaluation would store about 20 MiB: ten pages of nearly 2 MiB. What the check reports once
    // the share is spent differs by how an archive error is handled (a rejection, or pages counted as not loading), so
    // only the bound is asserted, and it must hold however writes still in flight finish: nothing past the share
    await runCheck(crit, spec, report, { fetch: hostileFetch, archive: hostile }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200)); // let writes started before the first refusal finish
    expect(dirBytes(directory)).toBeGreaterThan(0);
    expect(dirBytes(directory)).toBeLessThanOrEqual(share);
    expect(usage.get("hostile.testnet")!.bytes).toBeLessThanOrEqual(share);

    // another objective is untouched
    const honest = withObjectiveBudget(archive, usage, "honest.testnet", share);
    await honest(bytes("an honest objective's report"));
    expect(readdirSync(directory).length).toBeGreaterThan(1);
  });
});
