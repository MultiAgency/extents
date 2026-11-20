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
