/** Run after building, then test this exact WASM in the sandbox before publishing. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sourceHash } from "../src/server/release.ts";

const [wasmPath, output] = process.argv.slice(2);
if (!wasmPath || !output) throw new Error("Usage: bun scripts/create-release.ts <wasm> <manifest.json>");
const wasm = resolve(wasmPath);
const digest = sha256(await readFile(wasm));
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let n = BigInt(`0x${bytesToHex(digest)}`),
  codeHash = "";
while (n) {
  codeHash = alphabet[Number(n % 58n)]! + codeHash;
  n /= 58n;
}
for (const byte of digest) {
  if (byte !== 0) break;
  codeHash = "1" + codeHash;
}
await writeFile(
  output,
  JSON.stringify({ v: 1, wasm, wasm_sha256: bytesToHex(digest), source_sha256: await sourceHash(), code_hash: codeHash }, null, 2) + "\n",
);
console.log(`Release candidate: ${output}\nCode hash: ${codeHash}\nRun sandbox tests against ${wasm} before publishing.`);
