/**
 * The rules in `docs/spec.md` and where the repository cites them.
 *
 * A rule is a `####` heading in `docs/spec.md`; its heading is its name. Code
 * and tests cite one as `docs/spec.md, "<heading>"`; Markdown links to one by
 * its anchor. `test/rules.test.ts` checks both against the spec, and
 * `scripts/rules-changed.ts` lists what a change to the rules touches.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

export const ROOT = join(import.meta.dirname, "..", "..");
export const SPEC = "docs/spec.md";

export interface Rule {
  heading: string;
  /** The rule's text, whitespace collapsed. */
  body: string;
  line: number;
}

export interface Citation {
  /** `file:line`, from the repository root. */
  at: string;
  file: string;
  heading: string;
}

export interface Link {
  at: string;
  /** The file the link resolves to, from the repository root. */
  target: string;
  anchor: string;
}

/** GitHub's anchor for a heading: lower case, punctuation other than `-` and `_` dropped, spaces as `-`. */
export const anchorOf = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** Every heading of `text` at any level, in order, outside fenced code blocks. */
export function headings(text: string) {
  let fenced = false;
  return text.split("\n").flatMap((l, i) => {
    // a `#` line inside a fenced code block is code, not a heading
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(l);
    return m ? [{ level: m[1]!.length, text: m[2]!, line: i + 1 }] : [];
  });
}

/** The rules of a spec text: each `####` heading and the text up to the next heading. */
export function rulesOf(text: string): Rule[] {
  const lines = text.split("\n");
  const all = headings(text);
  return all
    .filter((h) => h.level === 4)
    .map((h) => {
      const end = all.find((n) => n.line > h.line)?.line ?? lines.length + 1;
      return {
        heading: h.text,
        line: h.line,
        body: lines
          .slice(h.line, end - 1)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      };
    });
}

const SKIP = new Set(["node_modules", "target", "dist", "dist-e2e", "test-results", "results", ".git", "trezu"]);
const SCANNED = [
  "README.md",
  "AGENTS.md",
  "docs",
  "contracts",
  "crates",
  "sandbox",
  "e2e/src",
  "app/src",
  "app/test",
  "app/public",
  "app/scripts",
];

/** Every text file the rules may be cited from, relative to the repository root. */
export function sources(root = ROOT): string[] {
  const walk = (path: string): string[] => {
    const full = join(root, path);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      return [];
    }
    if (stat.isFile()) return /\.(rs|ts|tsx|md|txt)$/.test(path) ? [path] : [];
    return readdirSync(full)
      .filter((name) => !SKIP.has(name))
      .flatMap((name) => walk(relative(root, join(full, name))));
  };
  return SCANNED.flatMap(walk);
}

/** Whether a file holds tests: a test that cites a rule is evidence for it. */
export const isTest = (file: string) => /(^|\/)tests?\/|(^|\/)tests\.rs$|\.(test|spec)\.tsx?$/.test(file);

const CITATION = /docs\/spec\.md, "([^"<][^"]*)"/g;
/** A link by anchor into a file named `spec.md`, or `(#a)` within one. */
const LINK = /\]\(([^)\s#]*spec\.md)?#([^)\s]+)\)/g;

/** Every citation and spec anchor link in `files`. */
export function references(files: string[], root = ROOT) {
  const citations: Citation[] = [];
  const links: Link[] = [];
  for (const file of files) {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      const at = `${file}:${i + 1}`;
      for (const [, heading] of line.matchAll(CITATION)) citations.push({ at, file, heading: heading! });
      for (const [, path, anchor] of line.matchAll(LINK)) {
        // a same-file `(#a)` link is a spec link only inside the spec itself
        if (!path && file !== SPEC) continue;
        const target = path ? posix.normalize(posix.join(posix.dirname(file), path)) : file;
        links.push({ at, target, anchor: decodeURIComponent(anchor!) });
      }
    });
  }
  return { citations, links };
}

export const readSpec = (root = ROOT) => readFileSync(join(root, SPEC), "utf8");
