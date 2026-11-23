/**
 * JSON Schema for `schema` criteria, compiled so that no spec or report can
 * stall the evaluator: patterns run on RE2 (linear time, so no catastrophic
 * backtracking; backreferences and lookaround are refused), and the schema
 * and the JSON validated against it are bounded in size and depth.
 *
 * These are this app's execution limits, not the protocol's: a published
 * spec beyond them is still a valid spec, one this app declines to compile
 * or evaluate. They are checked before anything is compiled.
 */
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { RE2JS } from "re2js";

const MAX_SCHEMA_BYTES = 16 * 1024;
export const MAX_SCHEMA_DEPTH = 32;
const MAX_DATA_BYTES = 256 * 1024;
export const MAX_DATA_DEPTH = 64;

/** Ajv's regex engine, swapped for RE2. Flags are ignored: JSON Schema patterns carry none but Unicode, which RE2 is. */
const linear = Object.assign(
  (pattern: string) => {
    const re = RE2JS.compile(pattern);
    // Ajv keys its pattern cache by toString(), so each pattern needs its own
    return { test: (s: string) => re.matcher(s).find(), toString: () => `re2:${pattern}` };
  },
  { code: "RE2JS" },
);

/** Nesting depth of a JSON value: 0 for a scalar. */
function depth(value: unknown): number {
  let deepest = 0;
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    deepest = Math.max(deepest, d + 1);
    for (const child of Object.values(v)) stack.push([child, d + 1]);
  }
  return deepest;
}

/** Whether any object inside a JSON value has this key. */
function hasKey(value: unknown, key: string): boolean {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (!Array.isArray(v) && key in v) return true;
    stack.push(...Object.values(v));
  }
  return false;
}

/** Why this app won't compile a schema, judged without compiling it. */
export function schemaLimitProblem(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return "json_schema is not an object";
  if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > MAX_SCHEMA_BYTES)
    return `json_schema is larger than ${MAX_SCHEMA_BYTES / 1024} KiB`;
  if (depth(schema) > MAX_SCHEMA_DEPTH) return `json_schema nests deeper than ${MAX_SCHEMA_DEPTH}`;
  // Ajv resolves a $dynamicRef only when a value reaches it: one that resolves to nothing compiles and then fails
  // every value, where crates/spec refuses the schema. This app does not evaluate them.
  if (hasKey(schema, "$dynamicRef")) return "json_schema uses $dynamicRef, which this app does not evaluate";
  return undefined;
}

/**
 * Why this app won't compile a spec's schemas, for any spec-shaped JSON,
 * judged before it is parsed (parsing compiles every schema).
 */
export function specLimitProblem(raw: unknown): string | undefined {
  const criteria = (raw as { criteria?: unknown } | null)?.criteria;
  if (!Array.isArray(criteria)) return undefined;
  for (const c of criteria as { id?: unknown; check?: { kind?: unknown; json_schema?: unknown } }[]) {
    if (c?.check?.kind !== "schema") continue;
    const problem = schemaLimitProblem(c.check.json_schema);
    if (problem) return `criterion ${String(c.id)}: ${problem}`;
  }
  return undefined;
}

/** Compiles a criterion's schema, or throws saying why it can't be used. */
export function compileSchema(schema: unknown): ValidateFunction {
  const problem = schemaLimitProblem(schema);
  if (problem) throw new Error(problem);
  return new Ajv2020({ strict: false, code: { regExp: linear } }).compile(schema as object);
}

/** Why this JSON can't be validated, if it can't. */
export function dataProblem(text: string, data: unknown): string | undefined {
  if (new TextEncoder().encode(text).byteLength > MAX_DATA_BYTES) return `the JSON is larger than ${MAX_DATA_BYTES / 1024} KiB`;
  if (depth(data) > MAX_DATA_DEPTH) return `the JSON nests deeper than ${MAX_DATA_DEPTH}`;
  return undefined;
}
