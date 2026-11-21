/** Private, content-addressed replay material. Never exposed as a public HTTP directory. */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export function evidenceArchive(directory: string, limit = 256 * 1024 * 1024) {
  let queue = Promise.resolve();
  return (bytes: Uint8Array): Promise<void> => {
    const save = queue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const hash = bytesToHex(sha256(bytes));
      const path = join(directory, hash);
      try {
        await stat(path);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const names = (await readdir(directory)).filter((name) => /^[0-9a-f]{64}$/.test(name));
      const sizes = await Promise.all(names.map(async (name) => (await stat(join(directory, name))).size));
      if (sizes.reduce((a, b) => a + b, 0) + bytes.byteLength > limit)
        throw new Error("The private evidence archive is full; evaluation is paused");
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    });
    queue = save.catch(() => {});
    return save;
  };
}

/** What one objective may add to the archive in one process, so a single objective cannot fill it for every other. */
export const OBJECTIVE_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** The objective's share is spent: a reason to stop that the caller can show as is. */
export class ArchiveBudgetError extends Error {}

/** Distinct evidence bytes each objective has asked the archive to keep, by objective. Per process, like the archive's own use. */
export type ObjectiveUsage = Map<string, { bytes: number; seen: Set<string> }>;

/**
 * An archive that stops writing for one objective once it holds `limit` distinct bytes. Bytes seen before cost nothing,
 * so re-evaluating an objective does not spend its budget twice. Concurrent writes reserve their bytes first, and a
 * failed write gives its reservation back.
 */
export function withObjectiveBudget(
  archive: (bytes: Uint8Array) => Promise<void>,
  usage: ObjectiveUsage,
  objective: string,
  limit = OBJECTIVE_ARCHIVE_BYTES,
): (bytes: Uint8Array) => Promise<void> {
  return async (bytes) => {
    const hash = bytesToHex(sha256(bytes));
    let used = usage.get(objective);
    if (!used) usage.set(objective, (used = { bytes: 0, seen: new Set() }));
    if (used.seen.has(hash)) return;
    if (used.bytes + bytes.byteLength > limit)
      throw new ArchiveBudgetError(
        `This objective has used its ${Math.round(limit / 1048576)} MiB share of the evidence archive; its remaining evidence is not stored, so it cannot be evaluated further here`,
      );
    used.bytes += bytes.byteLength;
    used.seen.add(hash);
    try {
      await archive(bytes);
    } catch (e) {
      used.bytes -= bytes.byteLength;
      used.seen.delete(hash);
      throw e;
    }
  };
}
