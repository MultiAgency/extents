/**
 * What a change does to the rules in docs/spec.md, for the decision to publish
 * a build: each rule added, removed or reworded between two commits, and
 * every test, doc and line of code that cites it now.
 *
 *   bun scripts/rules-changed.ts <from> [to]
 *
 * `from` is the commit of the last published build; `to` defaults to the
 * working tree. A rule's heading is its name, so a renamed rule reads as one
 * removed and one added.
 */
import { execFileSync } from "node:child_process";

import { ROOT, SPEC, readSpec, references, rulesOf, sources, type Rule } from "./rules.ts";

const [from, to] = process.argv.slice(2);
if (!from) {
  console.error("usage: bun scripts/rules-changed.ts <from> [to]");
  process.exit(2);
}

const at = (rev: string | undefined) =>
  rev ? execFileSync("git", ["show", `${rev}:${SPEC}`], { cwd: ROOT, encoding: "utf8" }) : readSpec();
const byName = (rules: Rule[]) => new Map(rules.map((r) => [r.heading, r]));
const before = byName(rulesOf(at(from)));
const after = byName(rulesOf(at(to)));
const { citations } = references(sources());

const changes = [
  ...[...after.values()].filter((r) => !before.has(r.heading)).map((r) => ({ kind: "added", rule: r })),
  ...[...before.values()].filter((r) => !after.has(r.heading)).map((r) => ({ kind: "removed", rule: r })),
  ...[...after.values()]
    .filter((r) => before.has(r.heading) && before.get(r.heading)!.body !== r.body)
    .map((r) => ({ kind: "reworded", rule: r })),
];

console.log(`Rules in ${SPEC}, ${from} → ${to ?? "working tree"}: ${changes.length} changed, ${after.size} in all.`);
for (const { kind, rule } of changes) {
  console.log(`\n${kind}: ${rule.heading}`);
  if (kind === "reworded") console.log(`  was: ${before.get(rule.heading)!.body}`);
  console.log(`  ${kind === "removed" ? "was" : "now"}: ${rule.body}`);
  const cited = citations.filter((c) => c.heading === rule.heading).map((c) => c.at);
  console.log(cited.length ? `  cited by:\n${cited.map((c) => `    ${c}`).join("\n")}` : "  cited by: nothing");
}
