/** Exercise the socket boundary with DNS and HTTP mocked; no private network is contacted. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("node:dns", () => ({ lookup: mocks.lookup }));
import { runCheck } from "../src/server/checks.ts";
import { evidenceFetch, MAX_EVIDENCE_BYTES } from "../src/server/evidence-fetch.ts";

const connected: { host: string; address: string }[] = [];
let responses: { status: number; location?: string; body?: Buffer }[];

beforeEach(() => {
  connected.length = 0;
  responses = [{ status: 200, body: Buffer.from("evidence") }];
  mocks.lookup.mockImplementation((_hostname, _options, callback) => callback(null, [{ address: "8.8.8.8", family: 4 }]));
  mocks.request.mockImplementation((target, options, respond) => {
    const request = new EventEmitter() as EventEmitter & { end(): void };
    options.signal?.addEventListener("abort", () => request.emit("error", options.signal.reason), { once: true });
    request.end = () => {
      // Emulate the socket honoring the supplied lookup function, as verified separately in Bun.
      options.lookup(target.hostname, { all: true }, (error: Error | null, addresses: { address: string }[]) => {
        if (error) {
          queueMicrotask(() => request.emit("error", error));
          return;
        }
        connected.push({ host: target.hostname, address: addresses[0]!.address });
        const next = responses.shift()!;
        const incoming = Object.assign(new PassThrough(), {
          statusCode: next.status,
          headers: {
            "content-type": "text/plain",
            ...(next.location ? { location: next.location } : {}),
          },
        });
        respond(incoming);
        queueMicrotask(() => {
          if (!incoming.destroyed) incoming.end(next.body ?? "");
        });
      });
    };
    return request;
  });
});

test("a connection uses the vetted DNS address rather than resolving again", async () => {
  const response = await evidenceFetch("https://example.org/report");
  expect(await response.text()).toBe("evidence");
  expect(connected).toEqual([{ host: "example.org", address: "8.8.8.8" }]);
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
});

test("mixed public and private DNS answers never connect", async () => {
  mocks.lookup.mockImplementation((_hostname, _options, callback) =>
    callback(null, [
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]),
  );
  await expect(evidenceFetch("https://example.org/report")).rejects.toThrow(/non-public/);
  expect(connected).toEqual([]);
});

test("a public endpoint redirecting to a private literal never connects to it", async () => {
  responses = [{ status: 302, location: "http://127.0.0.1/secret" }];
  await expect(evidenceFetch("https://example.org/report")).rejects.toThrow(/redirect is not public/);
  expect(connected).toHaveLength(1);
});

test("every redirect hostname is checked at its own connection boundary", async () => {
  responses = [{ status: 302, location: "https://metadata.example.org/secret" }];
  mocks.lookup.mockImplementation((hostname, _options, callback) =>
    callback(null, [{ address: hostname === "example.org" ? "8.8.8.8" : "10.0.0.1", family: 4 }]),
  );
  await expect(evidenceFetch("https://example.org/report")).rejects.toThrow(/non-public/);
  expect(connected).toHaveLength(1);
});

test("every request, redirects included, names the evaluator in its User-Agent", async () => {
  responses = [{ status: 302, location: "https://example.net/moved" }, { status: 200, body: Buffer.from("evidence") }];
  await evidenceFetch("https://example.org/report");
  // pinned here because hosts may serve by it: changing it changes what the evaluator sees
  const named = "extents-evaluator (+https://github.com/MultiAgency/extents)";
  expect(mocks.request.mock.calls.map(([, options]) => options.headers["user-agent"])).toEqual([named, named]);
});

test("the transport stops an oversized body before creating a buffered response", async () => {
  responses = [{ status: 200, body: Buffer.alloc(MAX_EVIDENCE_BYTES + 1) }];
  await expect(evidenceFetch("https://example.org/report")).rejects.toThrow(/exceeds 2 MB/);
});

test("ten concurrent evidence requests queue instead of rejecting their ninth and tenth items", async () => {
  responses = Array.from({ length: 10 }, () => ({ status: 200, body: Buffer.from("evidence") }));
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => evidenceFetch(`https://example.org/${i}`)));
  expect(await Promise.all(results.map((r) => r.text()))).toEqual(Array(10).fill("evidence"));
  expect(connected).toHaveLength(10);
});

test("a valid seven-criterion evaluation queues all seventy healthy requests", async () => {
  const { runCheck } = await import("../src/server/checks.ts");
  const { validateAppSpec } = await import("../src/shared/spec.ts");
  const spec = {
    v: 1,
    statement: "Ten sources per criterion",
    criteria: Array.from({ length: 7 }, (_, i) => ({
      id: `sources-${i}`,
      description: "Ten cited sources load",
      check: { kind: "sources" as const, min: 10, figures: false },
    })),
  };
  validateAppSpec(spec);
  responses = Array.from({ length: 70 }, (_, i) => ({ status: 200, body: Buffer.from(`source ${i}`) }));
  const text = Array.from({ length: 10 }, (_, i) => `https://example.org/${i}`).join("\n");
  const results = await Promise.all(spec.criteria.map((c) => runCheck(c, spec, { text }, { fetch: evidenceFetch as typeof fetch })));
  expect(results.map((r) => r.outcome)).toEqual(Array(7).fill("pass"));
  expect(connected).toHaveLength(70);
});

afterEach(() => vi.restoreAllMocks());

test("waiting for a connection slot is not charged to the cited page's timeout", async () => {
  // Eight fetches to a host that never answers hold every slot until their callers abort them.
  mocks.lookup.mockImplementation((hostname, _options, callback) => {
    if (hostname !== "slow.example.org") callback(null, [{ address: "8.8.8.8", family: 4 }]);
  });
  const timeouts = vi.spyOn(AbortSignal, "timeout");
  const holders = Array.from({ length: 8 }, () => new AbortController());
  const held = holders.map((h) => evidenceFetch("https://slow.example.org/", { signal: h.signal }).catch(() => undefined));
  await vi.waitFor(() => expect(timeouts).toHaveBeenCalledTimes(8));

  const criterion = { id: "pr", description: "d", check: { kind: "live_url", label: "PR", must_contain: "ok" } } as const;
  const spec = { v: 1, statement: "s", criteria: [criterion] };
  responses = [{ status: 200, body: Buffer.from("ok") }];
  const queued = runCheck(criterion, spec, { text: "PR: https://fast.example.org/page" }, { fetch: evidenceFetch as typeof fetch });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The queued page has no clock yet: nothing but the eight holders' timeouts exists.
  expect(timeouts).toHaveBeenCalledTimes(8);

  holders[0]!.abort();
  const result = await queued;
  expect(result.outcome).toBe("pass");
  // Its own clock started when it got the slot.
  expect(timeouts).toHaveBeenCalledTimes(9);
  holders.forEach((h) => h.abort());
  await Promise.all(held);
});
