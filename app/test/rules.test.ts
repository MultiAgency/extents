/** The rules in docs/spec.md: each is checked by a test, and every reference to one names a heading that exists. */
import { expect, test } from "vitest";

import { SPEC, anchorOf, headings, isTest, readSpec, references, rulesOf, sources } from "../scripts/rules.ts";

const spec = readSpec();
const rules = rulesOf(spec);
const { citations, links } = references(sources());

test("the spec has rules, each with its own heading and text", () => {
  expect(rules.length).toBeGreaterThan(0);
  const names = rules.map((r) => r.heading);
  expect(names.filter((h, i) => names.indexOf(h) !== i)).toEqual([]);
  expect(rules.filter((r) => !r.body).map((r) => r.heading)).toEqual([]);
});

test("every citation names a rule", () => {
  const names = new Set(rules.map((r) => r.heading));
  expect(citations.filter((c) => !names.has(c.heading)).map((c) => `${c.at}  "${c.heading}"`)).toEqual([]);
});

test(`every link into ${SPEC} lands on a heading`, () => {
  const anchors = new Set(headings(spec).map((h) => anchorOf(h.text)));
  expect(links.filter((l) => l.target !== SPEC || !anchors.has(l.anchor)).map((l) => `${l.at}  ${l.target}#${l.anchor}`)).toEqual([]);
});

test("every rule is checked by a test that cites it", () => {
  const tested = new Set(citations.filter((c) => isTest(c.file)).map((c) => c.heading));
  expect(rules.filter((r) => !tested.has(r.heading)).map((r) => `${SPEC}:${r.line}  ${r.heading}`)).toEqual([]);
});
