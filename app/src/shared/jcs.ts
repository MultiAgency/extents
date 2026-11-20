import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * RFC 8785 (JCS) canonical JSON. ECMAScript's own number and string
 * serialization is what JCS specifies, so only key order needs handling:
 * UTF-16 code unit order, which is `Array.prototype.sort`'s default.
 */
export function canonicalize(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`JCS: ${value} is not a JSON number`);
    }
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error(`JCS: ${typeof value} is not JSON`);
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${quote(k)}:${canonicalize(v)}`).join(",")}}`;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A JSON string, refusing a lone surrogate: it has no UTF-8 encoding, so the document has no hash. */
function quote(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new Error("JCS: a string holds a lone surrogate, which is not Unicode text");
  return JSON.stringify(s);
}

/** Hex SHA-256 of bytes, or of text as UTF-8. */
export const sha256Hex = (data: string | Uint8Array): string =>
  bytesToHex(sha256(typeof data === "string" ? new TextEncoder().encode(data) : data));

/** Hex SHA-256 of a document's canonical JSON. */
export const jcsHash = (value: unknown): string => sha256Hex(canonicalize(value));
