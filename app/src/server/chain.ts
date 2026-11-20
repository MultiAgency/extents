import { Near } from "near-kit";

import { calls } from "../shared/calls.ts";
import { accountId as accountSchema, specHash, type Spec } from "../shared/spec.ts";
import type { Dao } from "../shared/attest.ts";
import { NETWORK, objectiveCodeHash, TOKEN, VERIFIER } from "../shared/config.ts";
import { readLaunchDocuments } from "./fastdata.ts";
import { initState, objectiveAccountId, validateParams, type Params } from "../shared/params.ts";
import { query, RPC_READ_MS, RpcReadError, view } from "./rpc.ts";
import { withTimeout } from "./bounded.ts";

export async function accountExists(accountId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await query({ request_type: "view_account", account_id: accountId }, signal);
    return true;
  } catch (e) {
    if (e instanceof RpcReadError && e.detail.cause?.name === "UNKNOWN_ACCOUNT") return false;
    throw e;
  }
}

/** The objective's on-chain state, or undefined if it is not deployed (or already deleted). */
export async function viewObjective(accountId: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  if (!(await accountExists(accountId, signal))) return undefined;
  return view(accountId, "ob_view", signal);
}

/** Balance of the objective's token on the Verifier, in its smallest unit. */
export async function verifierBalance(accountId: string, signal?: AbortSignal): Promise<bigint> {
  const balance = await view<string>(VERIFIER, "mt_balance_of", signal, { account_id: accountId, token_id: TOKEN.id });
  return BigInt(balance ?? "0");
}

interface Policy {
  roles: { kind: "Everyone" | { Group: string[] } | { Member: unknown }; permissions: string[] }[];
  proposal_bond: string;
}

/**
 * The account as a Sputnik DAO, or undefined if it is not one: its proposal
 * bond, and who may propose a function call (`"anyone"` for an Everyone role).
 */
export async function sputnikDao(accountId: string, signal?: AbortSignal): Promise<Dao | undefined> {
  // no contract, or not a Sputnik DAO: either way, not a DAO evaluator
  const policy = await view<Policy>(accountId, "get_policy", signal).catch((e) => {
    signal?.throwIfAborted();
    // Network failures must not turn an actual DAO into a direct-signing evaluator.
    if (e instanceof RpcReadError && ["UNKNOWN_ACCOUNT", "NO_CONTRACT_CODE"].includes(e.detail.cause?.name ?? "")) return undefined;
    if (e instanceof Error && /MethodNotFound|MethodResolveError|does not exist while viewing/.test(e.message)) return undefined;
    throw e;
  });
  if (!policy?.roles) return undefined;
  const grantsCalls = (permissions: string[]) =>
    permissions.some((p) => ["*:*", "call:*", "*:AddProposal", "call:AddProposal"].includes(p));
  const roles = policy.roles.filter((r) => grantsCalls(r.permissions));
  const proposers = roles.some((r) => r.kind === "Everyone")
    ? "anyone"
    : [...new Set(roles.flatMap((r) => (typeof r.kind === "object" && "Group" in r.kind ? r.kind.Group : [])))];
  return { proposal_bond: policy.proposal_bond, proposers };
}

/** An objective as the app shows it: on-chain state, its verified documents, and its evaluator if a DAO. */
export async function describeObjective(accountId: string, signal?: AbortSignal) {
  accountSchema.parse(accountId);
  const work = new AbortController();
  const deadline = withTimeout(signal ? AbortSignal.any([signal, work.signal]) : work.signal, RPC_READ_MS);
  try {
    const [state, documents, balance] = await Promise.all([
      viewObjective(accountId, deadline),
      readLaunchDocuments(accountId, objectiveCodeHash(), deadline),
      verifierBalance(accountId, deadline),
    ]);
    const evaluator_dao = documents ? await sputnikDao(documents.params.evaluator, deadline) : undefined;
    return {
      deployed: state !== undefined,
      state,
      documents,
      verifier_balance: balance.toString(),
      ...(evaluator_dao ? { evaluator_dao } : {}),
    };
  } finally {
    // A failed dependency must not leave sibling network reads running after the response ends.
    work.abort();
  }
}

function deployer(): { near: Near; accountId: string } {
  const accountId = process.env.DEPLOYER_ACCOUNT_ID;
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!accountId || !privateKey) throw new Error("DEPLOYER_ACCOUNT_ID and DEPLOYER_PRIVATE_KEY are not set");
  return { near: new Near({ network: NETWORK, privateKey: privateKey as `ed25519:${string}`, defaultSignerId: accountId }), accountId };
}

/**
 * Deploys the objective's `StateInit`, which no browser wallet can sign yet.
 * Safe to offer to anyone: the address is derived from `Params`, so the
 * deployer cannot change what is deployed, and an instance needs no NEAR.
 */
export async function deployObjective(params: Params, spec?: Spec): Promise<{ accountId: string; txHash?: string; published?: boolean }> {
  const problem = validateParams(params);
  if (problem) throw new Error(problem);
  if (spec && specHash(spec) !== params.spec_hash) throw new Error("the spec does not match params.spec_hash");
  const codeHash = objectiveCodeHash();
  const accountId = objectiveAccountId(params, codeHash);
  let txHash: string | undefined;
  if (!(await accountExists(accountId))) {
    const { near, accountId: signer } = deployer();
    const outcome = await near
      .transaction(signer)
      .stateInit({ code: { codeHash }, data: initState(params), deposit: 0n })
      .send({ waitUntil: "FINAL" });
    if (!(await accountExists(accountId))) throw new Error(`StateInit did not create ${accountId}`);
    txHash = outcome.transaction.hash;
  }
  return {
    accountId,
    ...(txHash ? { txHash } : {}),
    ...(spec ? { published: await publishTerms(accountId, params, spec, codeHash) } : {}),
  };
}

/**
 * Publishes the terms from the deployer, for a sponsor with no NEAR key to
 * publish them; the reader accepts the deployer's spec row. Skipped once they
 * are readable. The receipt fails by design (see `calls.publish`).
 */
async function publishTerms(objective: string, params: Params, spec: Spec, codeHash: string): Promise<boolean> {
  if (await readLaunchDocuments(objective, codeHash)) return false;
  const { near, accountId: signer } = deployer();
  const call = calls.publish(objective, { params, spec });
  try {
    await near
      .transaction(signer)
      .functionCall(call.receiver, call.method, call.args, { gas: `${call.tgas} Tgas` })
      .send({ waitUntil: "FINAL" });
  } catch (e) {
    if (!/MethodNotFound|MethodResolveError/.test(e instanceof Error ? e.message : String(e))) throw e;
  }
  return true;
}
