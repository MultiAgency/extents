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

interface Row {
  predecessor_id: string;
  key: string;
  value: unknown;
  block_height: number;
}

export class DeliveryProofError extends Error {}

/** One page of rows, and every page of an objective together: bounded before parsing, so a large answer can't fill memory. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_ROWS_BYTES = 16 * 1024 * 1024;
/** A finalized transaction with its receipts. */
const MAX_TX_BYTES = 4 * 1024 * 1024;

async function latest(objective: string, signal?: AbortSignal): Promise<Row[]> {
  const deadline = withTimeout(signal, 15_000);
  const rows: Row[] = [];
  let page_token: string | undefined;
  const seen = new Set<string>();
  let total = 0;
  do {
    if (rows.length >= 2000) throw new Error("Too many published document rows");
    const res = await fetch(`${FASTDATA_URL}/v0/latest/${objective}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.FASTNEAR_API_KEY ? { authorization: `Bearer ${process.env.FASTNEAR_API_KEY}` } : {}),
      },
      body: JSON.stringify({ limit: 200, ...(page_token ? { page_token } : {}) }),
      cache: "no-store",
      signal: deadline,
    });
    if (!res.ok) throw new Error(`FastData ${res.status}: ${new TextDecoder().decode((await readCapped(res, 2048)) ?? new Uint8Array())}`);
    const bytes = await readCapped(res, Math.min(MAX_PAGE_BYTES, MAX_ROWS_BYTES - total));
    if (!bytes) throw new Error("Published documents exceed the size this reader accepts");
    total += bytes.byteLength;
    const page = JSON.parse(new TextDecoder().decode(bytes)) as { entries: Row[]; page_token?: string };
    rows.push(...page.entries);
    page_token = page.page_token;
    if (page_token && (seen.has(page_token) || seen.size >= 10)) throw new Error("Invalid or excessive document pagination");
    if (page_token) seen.add(page_token);
  } while (page_token);
  return rows;
}

/**
 * The launch documents of an objective, accepted only if `params` derives
 * the objective's own address (so it is exactly what was deployed) and the
 * spec matches `params.spec_hash`. The writer is then irrelevant.
 */
export async function readLaunchDocuments(objective: string, codeHash: string): Promise<LaunchDocuments | undefined> {
  const rows = await latest(objective);
  for (const row of rows.filter((r) => r.key === DOCUMENT_KEYS.params)) {
    const params = row.value as Params;
    try {
      if (objectiveAccountId(params, codeHash) !== objective) continue;
    } catch {
      continue;
    }
    for (const row of rows.filter((r) => r.key === DOCUMENT_KEYS.spec && r.predecessor_id === params.sponsor)) {
      // the app's limits come before parsing; the commitment is checked on the canonical bytes, which needs no compile
      const unsupported = specLimitProblem(row.value);
      if (unsupported) {
        if (safeHash(row.value) === params.spec_hash) return { params, spec: row.value as Spec, unsupported };
        continue;
      }
      const spec = safeSpec(row.value);
      if (spec && specHash(spec) === params.spec_hash) return { params, spec };
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
  const rows = (await latest(objective, signal)).filter(
    (r) => r.key === DOCUMENT_KEYS.deliverable && contributors.includes(r.predecessor_id),
  );
  return Promise.all(
    contributors.map(async (contributor) => {
      const value = rows.find((r) => r.predecessor_id === contributor)?.value as
        { text?: unknown; delivery_tx?: unknown; delivery_signer?: unknown } | undefined;
      if (
        typeof value?.text !== "string" ||
        value.text.length > 200_000 ||
        typeof value.delivery_tx !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(value.delivery_tx) ||
        !accountId.safeParse(value.delivery_signer).success
      )
        throw new DeliveryProofError(`The delivery proof for ${contributor} is missing. Publish its report and delivery transaction.`);
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
        throw new DeliveryProofError("The delivery transaction could not be verified. Try again later.");
      }
      const outcome = response.result;
      if (
        response.error ||
        outcome?.final_execution_status !== "FINAL" ||
        outcome.transaction?.hash !== value.delivery_tx ||
        outcome.transaction?.signer_id !== value.delivery_signer
      )
        throw new DeliveryProofError("The delivery transaction is not finalized. Check its hash and signer, or try again later.");
      const hash = deliveryHash(outcome, objective, contributor);
      if (!hash || hash !== reportHash(value.text))
        throw new DeliveryProofError(
          `The report for ${contributor} does not match its on-chain delivery. Republish the exact delivered report and transaction proof.`,
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
