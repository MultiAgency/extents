/** Evidence transport: validate DNS at connection time, pin the connection,
 * validate every redirect, and bound bytes before buffering them. */
import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Budget } from "./budget.ts";

export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
// Bound admitted work separately from active sockets so a ten-source check
// can finish rather than deterministically rejecting its ninth request.
const requests = new Budget(10_000, 64);
let active = 0;
const waiting = new Set<() => void>();

async function connection(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      waiting.delete(enter);
      reject(signal.reason);
    };
    const enter = () => {
      waiting.delete(enter);
      signal.removeEventListener("abort", abort);
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        waiting.values().next().value?.();
      });
    };
    if (active < 8) enter();
    else {
      waiting.add(enter);
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19].includes(b))
    );
  }
  // Only global unicast; mapped IPv4, loopback, link-local and ULA are excluded.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0*:|db8:)/i.test(address) && !/^2002:/i.test(address);
}

export function publicUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
    if (url.port && !["80", "443"].includes(url.port)) return;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (isIP(host)) return publicAddress(host) ? url : undefined;
    if (!host.includes(".") || /(?:^|\.)(?:localhost|internal|local)\.?$/.test(host)) return;
    return url;
  } catch {
    return;
  }
}

/** Callback lookup is used by the socket itself: there is no second DNS resolution. */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, "");
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      return callback(new Error("evidence hostname resolves to a non-public address"), "");
    const first = addresses[0]!;
    if (options.all) callback(null, [first]);
    else callback(null, first.address, first.family);
  });
};

export async function evidenceFetch(raw: string | URL | Request, init?: RequestInit): Promise<Response> {
  const release = requests.acquire();
  const signal = init?.signal ?? AbortSignal.timeout(10_000);
  try {
    const close = await connection(signal);
    try {
      return await fetchEvidence(raw, { ...init, signal });
    } finally {
      close();
    }
  } finally {
    release();
  }
}

async function fetchEvidence(raw: string | URL | Request, init?: RequestInit): Promise<Response> {
  let url = publicUrl(raw instanceof Request ? raw.url : String(raw));
  if (!url) throw new Error("evidence URL is not public HTTP(S)");
  const signal = init?.signal ?? AbortSignal.timeout(10_000);
  for (let hop = 0; hop <= 5; hop++) {
    const target = url;
    const response = await new Promise<Response>((resolve, reject) => {
      const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
        target,
        {
          method: "GET",
          signal,
          lookup: publicLookup,
          agent: false,
          headers: { "accept-encoding": "identity" },
        },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          if ([301, 302, 303, 307, 308].includes(status)) {
            incoming.destroy();
            resolve(new Response(null, { status, headers }));
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          incoming.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > MAX_EVIDENCE_BYTES) incoming.destroy(new Error("evidence exceeds 2 MB"));
            else chunks.push(chunk);
          });
          incoming.on("error", reject);
          incoming.on("end", () =>
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers })),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("evidence redirect has no location");
    url = publicUrl(new URL(location, target).href);
    if (!url) throw new Error("evidence redirect is not public HTTP(S)");
  }
  throw new Error("too many evidence redirects");
}
