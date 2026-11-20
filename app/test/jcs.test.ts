import { expect, test } from "vitest";

import { canonicalize } from "../src/shared/jcs.ts";

test("canonical JSON refuses lone surrogates, in values and keys, at any depth", () => {
  for (const bad of [{ a: "\ud800" }, { ["\udc00"]: 1 }, { a: [{ b: "x\udbffy" }] }, "\udfff"])
    expect(() => canonicalize(bad)).toThrow(/lone surrogate/);
  expect(canonicalize({ b: "😀", a: "é" })).toBe('{"a":"é","b":"😀"}');
});
