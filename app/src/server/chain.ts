import { Near } from "near-kit";

import { accountId as accountSchema } from "../shared/spec.ts";
import type { Dao } from "../shared/attest.ts";
import { NETWORK, objectiveCodeHash, TOKEN, VERIFIER } from "../shared/config.ts";
import { readLaunchDocuments } from "./fastdata.ts";
import { initState, objectiveAccountId, validateParams, type Params } from "../shared/params.ts";
import { query, RpcReadError, view } from "./rpc.ts";

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
  const [state, documents, balance] = await Promise.all([
    viewObjective(accountId, signal),
    readLaunchDocuments(accountId, objectiveCodeHash(), signal),
    verifierBalance(accountId, signal),
  ]);
  const evaluator_dao = documents ? await sputnikDao(documents.params.evaluator, signal) : undefined;
  return {
    deployed: state !== undefined,
    state,
    documents,
    verifier_balance: balance.toString(),
    ...(evaluator_dao ? { evaluator_dao } : {}),
  };
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
export async function deployObjective(params: Params): Promise<{ accountId: string; txHash?: string }> {
  const problem = validateParams(params);
  if (problem) throw new Error(problem);
  const codeHash = objectiveCodeHash();
  const accountId = objectiveAccountId(params, codeHash);
  if (await accountExists(accountId)) return { accountId };

  const { near, accountId: signer } = deployer();
  const outcome = await near
    .transaction(signer)
    .stateInit({ code: { codeHash }, data: initState(params), deposit: 0n })
    .send({ waitUntil: "FINAL" });
  if (!(await accountExists(accountId))) throw new Error(`StateInit did not create ${accountId}`);
  return { accountId, txHash: outcome.transaction.hash };
}
