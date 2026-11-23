/** Replay an evaluation from the private evidence archive, offline. Exits 1 if anything does not hold. */
import { formatReplay, replay } from "../src/server/replay.ts";

const [directory, hash] = process.argv.slice(2);
if (!directory || !hash) {
  console.error("Usage: bun scripts/replay.ts <archive-dir> <review-hash>");
  process.exit(2);
}
const report = await replay(directory, hash);
console.log(formatReplay(report));
process.exit(report.ok ? 0 : 1);
