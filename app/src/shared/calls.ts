/**
 * Every call the app has a wallet or DAO sign, built in one place: the page
 * signs these, and MCP hands the same objects to agents as unsigned
 * transactions, so the two can't drift apart in method, arguments or gas.
 */
import { attestArgs, attestProposal, attestTgas, type Attestation } from "./attest.ts";
import { DOCUMENT_KEYS, FASTDATA_METHOD, type DocumentName } from "./config.ts";
import type { Params } from "./params.ts";

export interface Call {
  receiver: string;
  method: string;
  args: object;
  /** Prepaid gas, in Tgas. */
  tgas: number;
  /** Attached deposit, in yoctoNEAR. */
  yocto?: bigint;
}

/** Gas for each call that isn't sized by its Params; `ob_attest` is (`attestTgas`). */
const TGAS = {
  publish: 20,
  fund: 100,
  // the contract's gas::CALL: at most 1.7 Tgas burnt at the largest valid state
  commit: 10,
  deliver: 10,
  propose: 50,
  // a close may retry every payout, read the balance and delete the account
  close: 300,
} as const;

/** `params.token` is `nep245:<verifier>:<token id on it>`. */
const TOKEN_ID = /^nep245:([^:]+):(.+)$/;
const verifierOf = (p: Params) => TOKEN_ID.exec(p.token)![1]!;
const tokenOf = (p: Params) => TOKEN_ID.exec(p.token)![2]!;

export const calls = {
  /**
   * Documents on FastData under the objective, each under its namespaced key.
   * The objective has no such method, so the receipt fails by design;
   * FastData indexes the call anyway.
   */
  publish: (objective: string, documents: Partial<Record<DocumentName, unknown>>): Call => ({
    receiver: objective,
    method: FASTDATA_METHOD,
    args: Object.fromEntries(Object.entries(documents).map(([name, value]) => [DOCUMENT_KEYS[name as DocumentName], value])),
    tgas: TGAS.publish,
  }),

  /** The sponsor's `mt_transfer_call` on the Verifier that `params.token` names. */
  fund: (objective: string, params: Params, amount: bigint): Call => ({
    receiver: verifierOf(params),
    method: "mt_transfer_call",
    args: {
      receiver_id: objective,
      token_id: tokenOf(params),
      amount: amount.toString(),
      msg: JSON.stringify({ params, action: { action: "fund" } }),
    },
    tgas: TGAS.fund,
    yocto: 1n,
  }),

  commit: (objective: string, params: Params): Call => ({ receiver: objective, method: "ob_commit", args: { params }, tgas: TGAS.commit }),

  deliver: (objective: string, params: Params, hash: string): Call => ({
    receiver: objective,
    method: "ob_deliver",
    args: { params, delivery: { hash } },
    tgas: TGAS.deliver,
  }),

  attest: (objective: string, params: Params, attestation: Attestation): Call => ({
    receiver: objective,
    method: "ob_attest",
    args: attestArgs(params, attestation),
    tgas: attestTgas(params),
  }),

  /** The same `ob_attest`, filed with a DAO evaluator as a proposal, with the DAO's bond. */
  propose: (objective: string, params: Params, attestation: Attestation, bond: string): Call => ({
    receiver: params.evaluator,
    method: "add_proposal",
    args: attestProposal(objective, params, attestation),
    tgas: TGAS.propose,
    yocto: BigInt(bond),
  }),

  close: (objective: string, params: Params): Call => ({ receiver: objective, method: "ob_close", args: { params }, tgas: TGAS.close }),
};

/** A call as an agent reads it: gas and deposit in the units wallets take. */
export const describe = ({ receiver, method, args, tgas, yocto }: Call) => ({
  receiver,
  method,
  args,
  gas: `${tgas} Tgas`,
  ...(yocto !== undefined ? { deposit: `${yocto} yocto` } : {}),
});
