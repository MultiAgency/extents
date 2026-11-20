/**
 * An objective's documents, published with FastData under the objective's
 * own account: `__fastdata_kv` on it (which fails, as the contract has no
 * such method, but is indexed all the same), read back from FastNEAR's KV
 * API. Anyone can write there, so a reader trusts a row only if its writer
 * holds that role in `Params` and its value matches the on-chain hash.
 */
import { DOCUMENT_KEYS, FASTDATA_URL, RPC_URL } from "../shared/config.ts";
import { deliveryHash } from "../shared/delivery.ts";
import { objectiveAccountId, type Params } from "../shared/params.ts";
import { reportHash, type Delivered } from "../shared/review.ts";
import { accountId, parseSpec, specHash, type Spec } from "../shared/spec.ts";
import { jcsHash } from "../shared/jcs.ts";
import { specLimitProblem } from "../shared/schema.ts";
import { readCapped, withTimeout } from "./bounded.ts";
import { z } from "zod";

/** Keys the sponsor writes at launch. */
export interface LaunchDocuments {
  params: Params;
  spec: Spec;
  /**
   * Why this app won't evaluate these terms, when their schemas exceed its
   * execution limits. The spec is the one committed to, but unparsed: parsing
   * would compile what the limits exist to refuse.
   */
  unsupported?: string;
}

const pageSchema = z.object({
  entries: z.array(z.object({ predecessor_id: accountId, key: z.string(), value: z.unknown() })),
  page_token: z.string().optional(),
});
type Row = z.infer<typeof pageSchema>["entries"][number];

/**
 * Why a contributor's report can't be used: `missing` when no valid report is
 * published (none, a malformed proof, or text that doesn't match the hash on
 * chain), which a review may record as missing; `unverified` when the chain
 * couldn't confirm it just now, which only a later run can settle.
 */
export class DeliveryProofError extends Error {
  constructor(
    message: string,
    readonly kind: "missing" | "unverified",
  ) {
    super(message);
  }
}

/** One page of rows, and every page of an objective together: bounded before parsing, so a large answer can't fill memory. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_ROWS_BYTES = 16 * 1024 * 1024;
/** A finalized transaction with its receipts. */
const MAX_TX_BYTES = 4 * 1024 * 1024;

/** Exact server-side filters keep unrelated keys and writers out of the read budget. */
async function* latest(objective: string, query: { key: string; predecessor?: string }, signal?: AbortSignal): AsyncGenerator<Row[]> {
  accountId.parse(objective);
  if (query.predecessor) accountId.parse(query.predecessor);
  const deadline = withTimeout(signal, 15_000);
  let rows = 0;
  let page_token: string | undefined;
  const seen = new Set<string>();
  let total = 0;
  do {
    if (rows >= 2000) throw new Error("Too many published document rows");
    const res = await fetch(`${FASTDATA_URL}/v0/latest/${objective}${query.predecessor ? `/${query.predecessor}` : ""}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.FASTNEAR_API_KEY ? { authorization: `Bearer ${process.env.FASTNEAR_API_KEY}` } : {}),
      },
      body: JSON.stringify({ key: query.key, limit: 200, ...(page_token ? { page_token } : {}) }),
      cache: "no-store",
      signal: deadline,
    });
    if (!res.ok) throw new Error(`FastData ${res.status}: ${new TextDecoder().decode((await readCapped(res, 2048)) ?? new Uint8Array())}`);
    const bytes = await readCapped(res, Math.min(MAX_PAGE_BYTES, MAX_ROWS_BYTES - total));
    if (!bytes) throw new Error("Published documents exceed the size this reader accepts");
    total += bytes.byteLength;
    const page = pageSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    rows += page.entries.length;
    // Check the response too: a bad indexer response cannot bypass writer or key constraints.
    yield page.entries.filter((r) => r.key === query.key && (!query.predecessor || r.predecessor_id === query.predecessor));
    page_token = page.page_token;
    if (page_token && (seen.has(page_token) || seen.size >= 10)) throw new Error("Invalid or excessive document pagination");
    if (page_token) seen.add(page_token);
  } while (page_token);
}

/** Only hash-verified immutable terms are cached, bounded by bytes and entry count. */
export function launchDocumentReader() {
  const cache = new Map<string, { documents: LaunchDocuments; size: number }>();
  const limit = 16 * 1024 * 1024;
  let used = 0;
  return async (objective: string, codeHash: string, signal?: AbortSignal): Promise<LaunchDocuments | undefined> => {
    signal?.throwIfAborted();
    const key = `${codeHash}:${objective}`;
    const saved = cache.get(key);
    if (saved) {
      cache.delete(key);
      cache.set(key, saved);
      return saved.documents;
    }
    const documents = await findLaunchDocuments(objective, codeHash, signal);
    if (documents) {
      const size = new TextEncoder().encode(JSON.stringify(documents)).byteLength;
      while (cache.size && (used + size > limit || cache.size >= 256)) {
        const oldest = cache.keys().next().value!;
        used -= cache.get(oldest)!.size;
        cache.delete(oldest);
      }
      if (size <= limit) {
        // A concurrent read may already have cached the same immutable documents.
        used -= cache.get(key)?.size ?? 0;
        cache.set(key, { documents, size });
        used += size;
      }
    }
    return documents;
  };
}

export const readLaunchDocuments = launchDocumentReader();

/**
 * The launch documents of an objective, accepted only if `params` derives
 * the objective's own address (so it is exactly what was deployed) and the
 * spec matches `params.spec_hash`. The writer is then irrelevant.
 */
async function findLaunchDocuments(objective: string, codeHash: string, signal?: AbortSignal): Promise<LaunchDocuments | undefined> {
  for await (const rows of latest(objective, { key: DOCUMENT_KEYS.params }, signal)) {
    for (const row of rows) {
      const params = row.value as Params;
      try {
        if (objectiveAccountId(params, codeHash) !== objective) continue;
      } catch {
        continue;
      }
      for await (const specs of latest(objective, { key: DOCUMENT_KEYS.spec, predecessor: params.sponsor }, signal)) {
        for (const row of specs) {
          // Limits precede parsing; checking canonical bytes needs no schema compilation.
          const unsupported = specLimitProblem(row.value);
          if (unsupported) {
            if (safeHash(row.value) === params.spec_hash) return { params, spec: row.value as Spec, unsupported };
            continue;
          }
          const spec = safeSpec(row.value);
          if (spec && specHash(spec) === params.spec_hash) return { params, spec };
        }
      }
      // Every valid Params derives the same sponsor and spec hash for this address.
      return undefined;
    }
  }
  return undefined;
}

function safeHash(value: unknown): string | undefined {
  try {
    return jcsHash(value);
  } catch {
    return undefined;
  }
}

/** The spec, parsed once, or undefined if the row isn't one. */
function safeSpec(value: unknown): Spec | undefined {
  try {
    return parseSpec(value);
  } catch {
    return undefined;
  }
}

/**
 * A holder's report and finalized transaction proof. FastData identifies its
 * writer; the objective's successful receipt establishes the immutable hash.
 * Latest replacement text cannot override that commitment.
 */
export async function readDeliverables(objective: string, contributors: string[], signal?: AbortSignal): Promise<Delivered[]> {
  return Promise.all(
    contributors.map(async (contributor) => {
      let published: Row | undefined;
      for await (const rows of latest(objective, { key: DOCUMENT_KEYS.deliverable, predecessor: contributor }, signal)) {
        if (rows.length) {
          published = rows[0];
          break;
        }
      }
      const value = published?.value as { text?: unknown; delivery_tx?: unknown; delivery_signer?: unknown } | undefined;
      if (
        typeof value?.text !== "string" ||
        value.text.length > 200_000 ||
        typeof value.delivery_tx !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(value.delivery_tx) ||
        !accountId.safeParse(value.delivery_signer).success
      )
        throw new DeliveryProofError(
          `The delivery proof for ${contributor} is missing. Publish its report and delivery transaction.`,
          "missing",
        );
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "delivery",
          method: "tx",
          params: {
            tx_hash: value.delivery_tx,
            sender_account_id: value.delivery_signer,
            wait_until: "FINAL",
          },
        }),
        signal: withTimeout(signal, 15_000),
      });
      const bytes = res.ok ? await readCapped(res, MAX_TX_BYTES) : undefined;
      let response: { error?: unknown; result?: any };
      try {
        response = JSON.parse(new TextDecoder().decode(bytes!));
      } catch {
        throw new DeliveryProofError("The delivery transaction could not be verified. Try again later.", "unverified");
      }
      const outcome = response.result;
      if (
        response.error ||
        outcome?.final_execution_status !== "FINAL" ||
        outcome.transaction?.hash !== value.delivery_tx ||
        outcome.transaction?.signer_id !== value.delivery_signer
      )
        throw new DeliveryProofError(
          "The delivery transaction is not finalized. Check its hash and signer, or try again later.",
          "unverified",
        );
      const hash = deliveryHash(outcome, objective, contributor);
      if (!hash || hash !== reportHash(value.text))
        throw new DeliveryProofError(
          `The report for ${contributor} does not match its on-chain delivery. Republish the exact delivered report and transaction proof.`,
          "missing",
        );
      return {
        contributor,
        text: value.text,
        delivery_hash: hash,
        delivery_tx: value.delivery_tx,
        delivery_signer: value.delivery_signer as string,
      };
    }),
  );
}
