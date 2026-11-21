/** Binding a receipt's key to an Intel TDX quote, against a real NEAR AI report and the Intel collateral recorded with it. */
import { verify } from "@phala/dcap-qvl";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { nearAiAttestation, verifyModelAttestation, type ModelAttestation, type QuoteVerifier } from "../src/server/attestation.ts";

// recorded from a real review (see _provenance): the model's report, its nonce, and the collateral valid at `now`
const fixture = JSON.parse(readFileSync(new URL("./fixtures/near-ai-attestation.json", import.meta.url), "utf8"));
const { nonce, now, model } = fixture as { nonce: string; now: number; model: string };
const collaterals = Object.values(fixture.collateral) as Parameters<typeof verify>[1][];

/** Whichever recorded collateral matches the quote's platform, as of when it was recorded. */
const verifyQuote: QuoteVerifier = async (quote) => {
  let last: unknown;
  for (const collateral of collaterals) {
    try {
      return verify(quote, collateral, now);
    } catch (e) {
      last = e;
    }
  }
  throw last;
};
const report = (): ModelAttestation => structuredClone(fixture.report);
const signer = (fixture.report as ModelAttestation).signing_address;
const check = (r: ModelAttestation, n = nonce, s = signer, v: QuoteVerifier = verifyQuote) => verifyModelAttestation(r, n, s, { verifyQuote: v });

describe("verifyModelAttestation, on a real report", () => {
  test("binds the receipt's key to a fully patched TDX enclave", async () => {
    const attested = await check(report());
    expect(attested).toMatchObject({ tcb: "UpToDate", signer });
    expect(attested.composeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a different nonce fails: a replayed report does not bind it", async () => {
    await expect(check(report(), "00".repeat(32))).rejects.toThrow(/report data does not bind/);
  });

  test("a key other than the one that signed the receipt fails", async () => {
    await expect(check(report(), nonce, "11".repeat(32))).rejects.toThrow(/different key than the receipt's/);
  });

  test("a report that names another key than its quote binds fails", async () => {
    const r = report();
    r.signing_address = "11".repeat(32);
    await expect(check(r, nonce, "11".repeat(32))).rejects.toThrow(/report data does not bind/);
  });

  test("one changed byte in the quote fails", async () => {
    const r = report();
    const quote = Buffer.from(r.intel_quote, "hex");
    quote[200]! ^= 1;
    r.intel_quote = quote.toString("hex");
    await expect(check(r)).rejects.toThrow();
  });

  test("a changed compose file fails MRCONFIGID", async () => {
    const r = report() as ModelAttestation & { info: { tcb_info: { app_compose: string } } };
    r.info.tcb_info.app_compose += " ";
    await expect(check(r)).rejects.toThrow(/MRCONFIGID/);
  });

  test("a changed event log fails RTMR3", async () => {
    const r = report();
    const event = (r.event_log as { imr: number; event_payload: string; digest: string }[]).filter((e) => e.imr === 3).at(-1)!;
    event.event_payload = `00${event.event_payload}`;
    event.digest = "";
    await expect(check(r)).rejects.toThrow(/RTMR3/);
  });

  test("a platform with a pending update is not accepted, nor a revoked one", async () => {
    for (const status of ["OutOfDate", "Revoked", "SWHardeningNeeded"]) {
      await expect(check(report(), nonce, signer, async (q) => Object.assign(await verifyQuote(q), { status }))).rejects.toThrow(
        new RegExp(`TCB status ${status} not accepted`),
      );
    }
  });

  test("debug mode fails", async () => {
    const debug: QuoteVerifier = async (q) => {
      const v = await verifyQuote(q);
      (v.report.data as { tdAttributes: Uint8Array }).tdAttributes[0]! |= 1;
      return v;
    };
    await expect(check(report(), nonce, signer, debug)).rejects.toThrow(/debug mode/);
  });

  test("only ed25519 reports are accepted", async () => {
    const r = report();
    r.signing_algo = "ecdsa";
    await expect(check(r)).rejects.toThrow(/unexpected signing algorithm/);
  });
});

describe("nearAiAttestation", () => {
  const body = JSON.stringify({ model_attestations: [fixture.report] });
  const stub = (answer: () => Response = () => new Response(body)) => {
    const asked: string[] = [];
    const send = (async (url: string | URL) => (asked.push(String(url)), answer())) as typeof fetch;
    return { asked, send };
  };
  // the recorded report binds the recorded nonce, so the nonce the step asks with is that one
  const attest = (send: typeof fetch, extra: Partial<Parameters<typeof nearAiAttestation>[0]> = {}) =>
    nearAiAttestation({ apiKey: "k", baseUrl: "https://ai.test/v1", send, verifyQuote, nonce: () => nonce, ...extra });

  test("asks for a report with a fresh nonce, checks it, and archives it once it checks out", async () => {
    const { asked, send } = stub();
    const archived: Uint8Array[] = [];
    await attest(send)(model, signer, async (b) => void archived.push(b));
    expect(asked).toHaveLength(1);
    const url = new URL(asked[0]!);
    expect(url.pathname).toBe("/v1/attestation/report");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model,
      provider: "near",
      signing_algo: "ed25519",
      include_tls_fingerprint: "false",
      nonce,
    });
    expect(new TextDecoder().decode(archived[0])).toBe(body);
  });

  test("a key checked recently is not checked again, until the time is up", async () => {
    const { asked, send } = stub();
    let clock = 0;
    const step = attest(send, { now: () => clock, ttlMs: 1000 });
    await step(model, signer);
    await step(model, signer);
    expect(asked).toHaveLength(1);
    clock = 1001;
    await step(model, signer);
    expect(asked).toHaveLength(2);
  });

  test("a failure is not remembered", async () => {
    let calls = 0;
    const { asked, send } = stub(() => (calls++ === 0 ? new Response("down", { status: 503 }) : new Response(body)));
    const step = attest(send);
    await expect(step(model, signer)).rejects.toThrow(/answered 503/);
    await step(model, signer);
    expect(asked).toHaveLength(2);
  });

  test("a report that names no enclave holding the key fails, and is not archived", async () => {
    const { send } = stub();
    const archived: Uint8Array[] = [];
    await expect(attest(send)(model, "11".repeat(32), async (b) => void archived.push(b))).rejects.toThrow(/names no enclave/);
    expect(archived).toEqual([]);
  });

  test("a report that does not verify is not archived", async () => {
    const r = report();
    r.request_nonce = "00".repeat(32);
    const { send } = stub(() => new Response(JSON.stringify({ model_attestations: [r] })));
    const archived: Uint8Array[] = [];
    await expect(attest(send)(model, signer, async (b) => void archived.push(b))).rejects.toThrow(/echoed nonce/);
    expect(archived).toEqual([]);
  });
});
