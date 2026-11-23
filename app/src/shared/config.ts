/** Testnet against Tidepool's Verifier, the same build as mainnet `intents.near`. */
export const NETWORK = "testnet" as const;
/** FastNEAR's testnet RPC: rpc.testnet.near.org rate-limits reads (429) under ordinary use. */
export const RPC_URL = "https://rpc.testnet.fastnear.com";
export const FASTDATA_URL = "https://kv.test.fastnear.com";
export const VERIFIER = "verifier.tidepool-sandbox.testnet";

/** The one resource objectives are funded in, for now. */
export const TOKEN = {
  /** Token id inside the Verifier. */
  id: "nep141:usdc.tidepool-sandbox.testnet",
  symbol: "USDC",
  decimals: 6,
} as const;

/** `Params.token`: the token as a NEP-245 balance on the Verifier. */
export const PARAMS_TOKEN = `nep245:${VERIFIER}:${TOKEN.id}`;

/** Suggested evaluator until agencies attest through Sputnik DAO proposals. */
export const DEFAULT_EVALUATOR = "agency.testnet";

/**
 * Base58 hash of the published `extents-objective` global contract. It must
 * be the build whose `Params` layout `shared/params.ts` mirrors, or deployed
 * instances will not match their addresses.
 */
export function objectiveCodeHash(): string {
  const hash = process.env.PUBLIC_OBJECTIVE_CODE_HASH;
  if (!hash) throw new Error("PUBLIC_OBJECTIVE_CODE_HASH is not set");
  return hash;
}

/**
 * Whether the published build lets the sponsor release its own funding
 * (`ob_attest` achieved, resolving as `released`). Set `PUBLIC_SPONSOR_RELEASE=1`
 * together with the code hash of a build that has it; an older build refuses
 * the call.
 */
export const sponsorMayRelease = (): boolean => process.env.PUBLIC_SPONSOR_RELEASE === "1";

/** FastData's method: a call to it is indexed even though the objective has no such method. */
export const FASTDATA_METHOD = "__fastdata_kv";

/**
 * FastData keys of an objective's documents, namespaced so another app's
 * writes of a generic key ("params") are never read as ours.
 */
export const DOCUMENT_KEYS = {
  params: "extents/v1/params",
  spec: "extents/v1/spec",
  deliverable: "extents/v1/deliverable",
  review: "extents/v1/review",
} as const;

export type DocumentName = keyof typeof DOCUMENT_KEYS;
