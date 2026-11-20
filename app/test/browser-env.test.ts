/**
 * Browser code may read only PUBLIC_* variables, and rsbuild must define each
 * of them even when unset: an undefined one is left as `process.env.X`, which
 * throws in a browser. The e2e build always sets PUBLIC_E2E, so only this
 * check catches a new variable that a normal build would leave raw.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const app = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(join(app, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
const reads = (dir: string) =>
  files(dir).flatMap((f) =>
    [...readFileSync(join(app, f), "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => ({ f, name: m[1]! })),
  );

test("browser code reads only PUBLIC_* variables, each defined by default in rsbuild.config.ts", () => {
  const config = readFileSync(join(app, "rsbuild.config.ts"), "utf8");
  const found = [...reads("src/web"), ...reads("src/shared")];
  expect(found.length).toBeGreaterThan(0);
  for (const { f, name } of found) {
    expect(name, `${f} reads ${name}`).toMatch(/^PUBLIC_/);
    expect(config, `${name} needs a default in rsbuild.config.ts`).toContain(`"process.env.${name}"`);
  }
});
