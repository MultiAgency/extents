/** `schema` criteria: linear-time patterns and bounded inputs, under Node's own regex engine for comparison. */
import { describe, expect, test } from "vitest";

import { compileSchema, dataProblem, MAX_DATA_DEPTH, MAX_SCHEMA_DEPTH } from "../src/shared/schema.ts";

/** n levels of objects: depth(nest(n)) === n. */
const nest = (n: number): unknown => (n === 1 ? {} : { a: nest(n - 1) });

describe("compileSchema", () => {
  test("a catastrophic pattern runs in linear time", () => {
    const validate = compileSchema({ type: "string", pattern: "^(a+)+$" });
    const start = performance.now();
    expect(validate("a".repeat(5_000) + "!")).toBe(false);
    expect(validate("a".repeat(5_000))).toBe(true);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  test.each([
    ["^\\d{4}-\\d{2}-\\d{2}$", ["2027-03-01", "27-3-1", "x2027-03-01"]],
    ["^https?://", ["https://lu.ma/x", "ftp://x", "see https://x"]],
    ["[A-Z]{2,3}", ["NYC", "nyc", "a NY b"]],
    ["^\\p{L}+$", ["Café", "Café!", "東京"]],
    ["^(yes|no)$", ["yes", "no", "yesno"]],
  ])("pattern %s matches as JavaScript's does", (pattern, inputs) => {
    const validate = compileSchema({ type: "string", pattern });
    for (const s of inputs) expect(validate(s), s).toBe(new RegExp(pattern, "u").test(s));
  });

  test("patternProperties use the same engine", () => {
    const validate = compileSchema({ type: "object", patternProperties: { "^(a+)+$": { type: "number" } } });
    expect(validate({ ["a".repeat(5_000) + "!"]: "x" })).toBe(true);
    expect(validate({ aaa: "x" })).toBe(false);
  });

  test("refuses what RE2 can't run in linear time, and oversized schemas", () => {
    expect(() => compileSchema({ type: "string", pattern: "^(?=a)a$" })).toThrow();
    expect(() => compileSchema({ type: "string", pattern: "^(a)\\1$" })).toThrow();
    expect(() => compileSchema(nest(MAX_SCHEMA_DEPTH + 1))).toThrow(/nests deeper/);
    expect(() => compileSchema({ description: "x".repeat(20_000) })).toThrow(/larger than/);
    expect(() => compileSchema(nest(MAX_SCHEMA_DEPTH))).not.toThrow();
  });

  test("refuses $dynamicRef: left unresolved it would compile here and fail every value, where crates/spec refuses the schema", () => {
    expect(() => compileSchema({ type: "object", properties: { a: { $dynamicRef: "#x" } } })).toThrow(/\$dynamicRef/);
    expect(() => compileSchema({ $dynamicAnchor: "x", type: "object", properties: { a: { $dynamicRef: "#x" } } })).toThrow(/\$dynamicRef/);
    expect(() => compileSchema({ type: "object", properties: { a: { $ref: "#/$defs/n" } }, $defs: { n: { type: "integer" } } })).not.toThrow();
  });
});

test("dataProblem bounds the validated JSON", () => {
  expect(dataProblem("{}", nest(MAX_DATA_DEPTH + 1))).toMatch(/nests deeper/);
  expect(dataProblem("x".repeat(300_000), {})).toMatch(/larger than/);
  expect(dataProblem("{}", nest(MAX_DATA_DEPTH))).toBeUndefined();
});
