/**
 * Ties the key that signs a NEAR AI receipt to a genuine Intel TDX enclave.
 *
 * A receipt's signature shows that the holder of a key signed the answer. This checks, against Intel's collateral,
 * that the key lives in a TDX quote that binds it and a fresh nonce, that the quote's platform is fully patched and
 * not in debug mode, and that the compose file and event log the enclave reports are the ones the quote measures.
 *
 * It does not show that the enclave runs an image anyone audited: the compose hash is returned so a caller can compare
 * it with a list, and none is kept here. It does not check NVIDIA's verdict on the GPUs, or the gateway. The logic
 * follows `core/attest.mjs` in MultiAgency/private-ai.
 */
import { getCollateralAndVerify, type VerifiedReport } from "@phala/dcap-qvl";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { readCapped, withTimeout } from "./bounded.ts";
import { NEAR_AI_BASE_URL } from "./model.ts";

export type QuoteVerifier = (quote: Uint8Array) => Promise<VerifiedReport>;

/** A model's platform must be fully patched: it reads the data. */
export const ACCEPTED_TCB = ["UpToDate"];

/** One enclave's entry in NEAR AI Cloud's attestation report. */
export interface ModelAttestation {
  signing_address: string;
  signing_algo: string;
  request_nonce?: string;
  intel_quote: string;
  event_log: unknown;
  info: { tcb_info: unknown };
  tls_cert_fingerprint?: string;
}

export interface AttestedKey {
  tcb: string;
  advisories: string[];
  /** The ed25519 key the quote binds, lowercase hex. */
  signer: string;
  /** SHA-256 of the attested compose file, lowercase hex. Not compared with any list here. */
  composeHash: string;
}

const bytes = (hex: string) => hexToBytes(hex.replace(/^0x/i, ""));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const parse = (value: unknown): any => (typeof value === "string" ? JSON.parse(value) : value);
const normal = (hex: string) => hex.replace(/^0x/i, "").toLowerCase();

/** RTMR3 as the enclave's event log replays it. */
export function replayRtmr3(eventLog: unknown): Uint8Array {
  let rtmr3 = new Uint8Array(48);
  for (const event of parse(eventLog) as { imr: number; event_type: number; event: string; event_payload?: string; digest?: string }[]) {
    if (event.imr !== 3) continue;
    const type = new Uint8Array(4);
    new DataView(type.buffer).setUint32(0, event.event_type, true);
    const digest = sha384(concatBytes(type, utf8ToBytes(":"), utf8ToBytes(event.event), utf8ToBytes(":"), bytes(event.event_payload ?? "")));
    if (event.digest && !same(bytes(event.digest), digest)) throw new Error(`event log digest mismatch for ${event.event}`);
    rtmr3 = sha384(concatBytes(rtmr3, digest));
  }
  return rtmr3;
}

/**
 * Checks one enclave's report for `signer`, the key that signed a receipt, against a nonce chosen for this request.
 * Throws with the first thing that does not hold.
 */
export async function verifyModelAttestation(
  report: ModelAttestation,
  nonce: string,
  signer: string,
  { verifyQuote = getCollateralAndVerify, accepted = ACCEPTED_TCB }: { verifyQuote?: QuoteVerifier; accepted?: string[] } = {},
): Promise<AttestedKey> {
  if (report.signing_algo !== "ed25519") throw new Error(`unexpected signing algorithm ${report.signing_algo}`);
  const identity = bytes(report.signing_address);
  if (identity.length !== 32) throw new Error("malformed signing address");
  if (normal(report.signing_address) !== normal(signer)) throw new Error("the report is for a different key than the receipt's");

  const verified = await verifyQuote(bytes(report.intel_quote));
  if (!accepted.includes(verified.status)) {
    throw new Error(`TCB status ${verified.status} not accepted (${verified.advisory_ids.join(", ") || "no advisories"})`);
  }
  if (verified.report.type !== "td10") throw new Error("expected a TDX quote");
  const quote = verified.report.data as { tdAttributes: Uint8Array; reportData: Uint8Array; mrConfigId: Uint8Array; rtMr3: Uint8Array };
  if (quote.tdAttributes[0]! & 1) throw new Error("TDX debug mode is enabled");

  const bound = report.tls_cert_fingerprint ? sha256(concatBytes(identity, bytes(report.tls_cert_fingerprint))) : identity;
  if (!same(Uint8Array.from(quote.reportData), concatBytes(bound, bytes(nonce)))) throw new Error("report data does not bind the key and the nonce");
  if (report.request_nonce?.toLowerCase() !== nonce) throw new Error("the echoed nonce does not match");

  const composeHash = sha256(utf8ToBytes(parse(report.info.tcb_info).app_compose));
  if (!same(Uint8Array.from(quote.mrConfigId), concatBytes(new Uint8Array([1]), composeHash, new Uint8Array(15)))) {
    throw new Error("MRCONFIGID does not match the attested compose file");
  }
  if (!same(replayRtmr3(report.event_log), Uint8Array.from(quote.rtMr3))) throw new Error("the event log does not match RTMR3");

  return { tcb: verified.status, advisories: verified.advisory_ids, signer: normal(report.signing_address), composeHash: bytesToHex(composeHash) };
}

const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/**
 * The judge's attestation step: for a receipt's signing key, fetch a fresh attestation report from NEAR AI Cloud and
 * check that the key is bound by a TDX quote. A key checked within `ttlMs` is not checked again, so Intel's collateral
 * is not fetched for every judgement. The report is archived once it checks out, so it can be examined later.
 */
export function nearAiAttestation({
  apiKey,
  baseUrl = NEAR_AI_BASE_URL,
  send = fetch,
  verifyQuote,
  nonce = () => bytesToHex(randomBytes(32)),
  ttlMs = 10 * 60_000,
  now = Date.now,
}: {
  apiKey: string;
  baseUrl?: string;
  send?: typeof fetch;
  verifyQuote?: QuoteVerifier;
  nonce?: () => string;
  ttlMs?: number;
  now?: () => number;
}): (model: string, signer: string, archive?: (bytes: Uint8Array) => Promise<void>, signal?: AbortSignal) => Promise<void> {
  const fresh = new Map<string, { until: number; attested: Promise<AttestedKey> }>();
  return async (model, signer, archive, signal) => {
    const key = `${model}:${normal(signer)}`;
    const known = fresh.get(key);
    if (known && known.until > now()) {
      await known.attested;
      return;
    }
    const n = nonce();
    const attested = (async () => {
      const query = new URLSearchParams({ model, provider: "near", signing_algo: "ed25519", include_tls_fingerprint: "false", nonce: n });
      const res = await send(`${baseUrl}/attestation/report?${query}`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: withTimeout(signal, 30_000),
      });
      if (!res.ok) throw new Error(`NEAR AI Cloud answered ${res.status} for the attestation report`);
      const raw = await readCapped(res, MAX_REPORT_BYTES);
      if (!raw) throw new Error("NEAR AI Cloud's attestation report is larger than expected");
      const body = JSON.parse(new TextDecoder().decode(raw)) as { model_attestations?: ModelAttestation[] };
      const entry = body.model_attestations?.find((a) => normal(a.signing_address) === normal(signer));
      if (!entry) throw new Error("the attestation report names no enclave that holds the receipt's key");
      const result = await verifyModelAttestation(entry, n, signer, { verifyQuote });
      await archive?.(raw);
      return result;
    })();
    fresh.set(key, { until: now() + ttlMs, attested });
    try {
      await attested;
    } catch (e) {
      fresh.delete(key); // a failure is not remembered: the next judgement asks again
      throw e;
    }
  };
}
