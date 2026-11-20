/** Offline release metadata. The server does not read source files or WASM at deployment time. */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createStateInit } from "near-kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const workspace = join(import.meta.dirname, "../../..");
const hash = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

export async function sourceHash(root = workspace): Promise<string> {
  async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((entry) => (entry.isDirectory() ? files(join(directory, entry.name)) : Promise.resolve([join(directory, entry.name)]))),
      )
    ).flat();
  }
  const paths = [
    ...(await files(join(root, "contracts/objective/src"))),
    ...["Cargo.toml", "Cargo.lock", "rust-toolchain", "contracts/objective/Cargo.toml"].map((path) => join(root, path)),
  ].sort();
  const rows = await Promise.all(paths.map(async (path) => `${relative(root, path)}:${hash(await readFile(path))}`));
  return hash(new TextEncoder().encode(rows.join("\n")));
}

export function codeHashMatches(codeHash: string, digest: Uint8Array): boolean {
  const code = createStateInit({ code: { codeHash } }).code;
  return code.type === "codeHash" && bytesToHex(code.hash) === bytesToHex(digest);
}
