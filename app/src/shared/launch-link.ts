/**
 * A drafted objective as a link its sponsor opens to launch it in the
 * browser: `/o/<objective>#launch=<terms>`. The terms ride in the fragment,
 * which no server sees, and the page rebuilds the objective from them, so a
 * link whose terms don't derive its address offers nothing to sign.
 */
import { z } from "zod";

import { proposal } from "./objective.ts";
import { accountId } from "./spec.ts";

export const launchLink = z.object({ proposal, sponsor: accountId, salt: z.string().regex(/^[0-9a-f]{64}$/) });
export type LaunchLink = z.infer<typeof launchLink>;

const PREFIX = "#launch=";

/** The fragment: the terms as base64url UTF-8 JSON. */
export function launchFragment(link: LaunchLink): string {
  const bytes = new TextEncoder().encode(JSON.stringify(link));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The terms in `hash`; undefined without any, an error when they don't parse. */
export function parseLaunchFragment(hash: string): LaunchLink | Error | undefined {
  if (!hash.startsWith(PREFIX)) return undefined;
  try {
    const binary = atob(hash.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/"));
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    const parsed = launchLink.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : new Error(`the link's terms are invalid: ${z.prettifyError(parsed.error)}`);
  } catch {
    return new Error("the link's terms can't be read; ask for the link again");
  }
}
