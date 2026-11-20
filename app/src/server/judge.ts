/**
 * `llm_judge` on NEAR AI Cloud, with a receipt: the exact request and
 * response bytes are hashed, NEAR AI's signature over
 * `<model>:<sha256(request)>:<sha256(response)>` is fetched and verified, and
 * all of it goes into the review's `llm_calls`, so anyone can check that
 * this model gave this answer to this question. The signature is checked against the key supplied over provider HTTPS;
 * the key can optionally be pinned by the operator. Tying it to a genuine TEE needs its attestation
 * report, which is not checked here.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";

import { sha256Hex } from "../shared/jcs.ts";
import { judgeRequest, MAX_JUDGED_BYTES, utf8Bytes } from "../shared/judge.ts";
import { readCapped, withTimeout } from "./bounded.ts";
import type { CheckDeps } from "./checks.ts";
import { NEAR_AI_BASE_URL } from "./model.ts";

/** NEAR AI's signature over one completion. */
interface Receipt {
  text: string;
  signature: string;
  signing_address: string;
}

/** A judgement's answer is one line and a sentence; its receipt is a few hundred bytes. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;

/** Checks a NEAR AI receipt against our own hashes and its ed25519 signature. */
function receiptVerifies(receipt: Receipt, expected: { model: string; request: string; response: string }): boolean {
  if (receipt.text !== `${expected.model}:${expected.request}:${expected.response}`) return false;
  try {
    return ed25519.verify(hexToBytes(receipt.signature), new TextEncoder().encode(receipt.text), hexToBytes(receipt.signing_address));
  } catch {
    return false;
  }
}

export function nearAiJudge({
  apiKey,
  baseUrl = NEAR_AI_BASE_URL,
  send = fetch,
  signingKeys,
}: {
  apiKey: string;
  baseUrl?: string;
  send?: typeof fetch;
  signingKeys?: string[];
}): NonNullable<CheckDeps["judge"]> {
  const auth = { authorization: `Bearer ${apiKey}` };
  return async (model, question, deliverable, signal, archive) => {
    if (utf8Bytes(deliverable.text) > MAX_JUDGED_BYTES)
      throw new Error("The report exceeds the model evaluation limit; it was not truncated");
    // exactly the bytes crates/spec's judge_request defines, so anyone can rebuild and hash them
    const request = judgeRequest(model, question, deliverable.text);
    const res = await send(`${baseUrl}/chat/completions`, {
      method: "POST",
      body: request,
      headers: { "content-type": "application/json", ...auth },
      signal: withTimeout(signal, 120_000),
    });
    if (!res.ok) throw new Error(`NEAR AI Cloud answered ${res.status}`);
    const raw = await readCapped(res, MAX_RESPONSE_BYTES);
    if (!raw) throw new Error("NEAR AI Cloud's answer is larger than a judgement can be");
    const body = JSON.parse(new TextDecoder().decode(raw)) as {
      id: string;
      choices?: { finish_reason?: string; message?: { content?: string } }[];
    };
    if (body.choices?.[0]?.finish_reason !== "stop") throw new Error("The model judgment did not finish normally");
    const text = body.choices?.[0]?.message?.content?.trim() ?? "";
    const [first = "", ...rest] = text.split("\n");
    if (!/^(yes|no)$/i.test(first)) throw new Error("The model did not give an explicit yes or no verdict");

    const requestBytes = new TextEncoder().encode(request);
    const hashes = { model, request: sha256Hex(requestBytes), response: sha256Hex(raw) };
    const sig = await send(`${baseUrl}/signature/${encodeURIComponent(body.id)}?model=${encodeURIComponent(model)}&signing_algo=ed25519`, {
      headers: auth,
      signal: withTimeout(signal, 15_000),
    });
    const sigBytes = sig.ok ? await readCapped(sig, MAX_RECEIPT_BYTES) : undefined;
    const receipt = sigBytes ? (JSON.parse(new TextDecoder().decode(sigBytes)) as Receipt) : undefined;
    if (!receipt || !receiptVerifies(receipt, hashes)) throw new Error("NEAR AI's receipt for this judgement did not verify");
    if (signingKeys && !signingKeys.includes(receipt.signing_address)) throw new Error("The model receipt key is not trusted");
    await archive?.(requestBytes);
    await archive?.(raw);
    await archive?.(new TextEncoder().encode(JSON.stringify(receipt)));

    const answer = first.toLowerCase() === "yes";
    return {
      answer,
      detail: rest.join(" ").trim() || first,
      call: {
        model,
        answer,
        request_sha256: hashes.request,
        response_sha256: hashes.response,
        signature: { algo: "ed25519", address: receipt.signing_address, value: receipt.signature },
      },
    };
  };
}
