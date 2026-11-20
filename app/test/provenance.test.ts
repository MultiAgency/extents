import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeliverables } from "../src/server/fastdata.ts";
import { reportHash } from "../src/shared/review.ts";
import { evidenceArchive } from "../src/server/archive.ts";
import { codeHashMatches } from "../src/server/release.ts";

afterEach(() => vi.unstubAllGlobals());

const objective = "objective.testnet",
  contributor = "alice.testnet",
  text = "Committed report",
  tx = "1".repeat(44);
function service({ report = text, executor = objective, status = { SuccessValue: "" } as unknown, final = "FINAL", proof = true } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string);
      if (request.method === "tx") {
        expect(request.params.wait_until).toBe("FINAL");
        return Response.json({
          result: {
            final_execution_status: final,
            transaction: { hash: tx, signer_id: contributor },
            receipts_outcome: [
              {
                outcome: {
                  executor_id: executor,
                  status,
                  logs: [
                    `EVENT_JSON:${JSON.stringify({ standard: "extents-objective", event: "delivered", data: { contributor, hash: reportHash(text) } })}`,
                  ],
                },
              },
            ],
          },
        });
      }
      return Response.json({
        entries: [
          {
            key: "extents/v1/deliverable",
            predecessor_id: contributor,
            value: {
              text: report,
              ...(proof ? { delivery_tx: tx, delivery_signer: contributor } : {}),
            },
            block_height: 1,
          },
        ],
      });
    }),
  );
}

test("a report is verified against its finalized delivery transaction", async () => {
  service();
  expect(await readDeliverables(objective, [contributor])).toEqual([
    { contributor, text, delivery_hash: reportHash(text), delivery_tx: tx, delivery_signer: contributor },
  ]);
});

test.each([
  { report: "Replaced after delivery" },
  { executor: "attacker.testnet" },
  { status: { Failure: {} } },
  { final: "EXECUTED_OPTIMISTIC" },
  { proof: false },
])("changed, forged, failed, provisional and unproved deliveries are refused: %j", async (options) => {
  service(options);
  await expect(readDeliverables(objective, [contributor])).rejects.toThrow();
});

test("missing contributors are not silently omitted", async () => {
  service();
  await expect(readDeliverables(objective, [contributor, "bob.testnet"])).rejects.toThrow(/bob/);
});

test("private replay bytes are content-addressed, deduplicated and quota-bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "extents-evidence-"));
  try {
    const archive = evidenceArchive(directory, 6);
    const bytes = new TextEncoder().encode("report");
    await archive(bytes);
    await archive(bytes);
    expect(new TextDecoder().decode(await readFile(join(directory, reportHash("report"))))).toBe("report");
    await expect(archive(new TextEncoder().encode("another"))).rejects.toThrow(/full/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release artifact comparison decodes the configured base58 hash", () => {
  expect(codeHashMatches("1".repeat(32), new Uint8Array(32))).toBe(true);
  expect(codeHashMatches("1".repeat(32), new Uint8Array(32).fill(1))).toBe(false);
});
