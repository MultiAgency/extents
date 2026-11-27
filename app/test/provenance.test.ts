import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryProofError, readDeliverables } from "../src/server/fastdata.ts";
import { reportHash } from "../src/shared/review.ts";
import { evidenceArchive } from "../src/server/archive.ts";
import { codeHashMatches } from "../src/server/release.ts";

afterEach(() => vi.unstubAllGlobals());

const objective = "objective.testnet",
  contributor = "alice.testnet",
  text = "Committed report",
  tx = "1".repeat(44);
function service({
  report = text,
  executor = objective,
  status = { SuccessValue: "" } as unknown,
  final = "FINAL",
  proof = true,
  rpc = undefined as Response | undefined,
  hash = tx,
  signer = contributor,
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string);
      if (request.method === "tx") {
        expect(request.params.wait_until).toBe("FINAL");
        if (rpc) return rpc;
        return Response.json({
          result: {
            final_execution_status: final,
            transaction: { hash, signer_id: signer },
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

const rpcError = (name: string, kind = "HANDLER_ERROR") =>
  Response.json({ jsonrpc: "2.0", id: "delivery", error: { name: kind, cause: { name } } });

test.each([
  // a transaction the chain does not know may be one never sent, so the evaluator's retry rule times it
  { case: "an unknown transaction", options: { rpc: rpcError("UNKNOWN_TRANSACTION") }, kind: "unknown" },
  // a final transaction that is another one, or another signer's, never becomes this proof
  { case: "another transaction", options: { hash: "2".repeat(44) }, kind: "missing" },
  { case: "another signer", options: { signer: "relayer.testnet" }, kind: "missing" },
  // a hash of the right characters but not 32 bytes, which the RPC refuses to parse
  { case: "a hash the RPC can't parse", options: { rpc: rpcError("PARSE_ERROR", "REQUEST_VALIDATION_ERROR") }, kind: "missing" },
  // what clears on retry stops only this run
  { case: "a transaction not yet final", options: { final: "EXECUTED_OPTIMISTIC" }, kind: "unverified" },
  { case: "an RPC that times out", options: { rpc: rpcError("TIMEOUT_ERROR") }, kind: "unverified" },
  { case: "an RPC answering 503", options: { rpc: new Response("unavailable", { status: 503 }) }, kind: "unverified" },
])("$case is a proof that is $kind", async ({ options, kind }) => {
  service(options);
  const error = await readDeliverables(objective, [contributor]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DeliveryProofError);
  expect((error as DeliveryProofError).kind).toBe(kind);
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
