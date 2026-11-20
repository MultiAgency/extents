/**
 * Every call the app has a wallet or DAO sign, built in one place: the page
 * signs these, and the agent API hands the same objects to agents as unsigned
 * transactions, so the two can't drift apart in method, arguments or gas.
 */
import { attestArgs, attestProposal, attestTgas, closeTgas, type Attestation } from "./attest.ts";
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

/** Gas for each call that isn't sized by its Params; `ob_attest` and `ob_close` are (`attestTgas`, `closeTgas`). */
const TGAS = {
  publish: 20,
  fund: 100,
  // the contract's gas::CALL: at most 1.7 Tgas burnt at the largest valid state
  commit: 10,
  deliver: 10,
  propose: 50,
} as const;

/** `params.token` is `nep245:<verifier>:<token id on it>`. */
const TOKEN_ID = /^nep245:([^:]+):(.+)$/;
const verifierOf = (p: Params) => TOKEN_ID.exec(p.token)![1]!;
const tokenOf = (p: Params) => TOKEN_ID.exec(p.token)![2]!;
/** What funding tells the objective, by transaction or by intent alike. */
const fundMsg = (params: Params) => JSON.stringify({ params, action: { action: "fund" } });

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
      msg: fundMsg(params),
    },
    tgas: TGAS.fund,
    yocto: 1n,
  }),

  commit: (objective: string, params: Params): Call => ({ receiver: objective, method: "ob_commit", args: { params }, tgas: TGAS.commit }),

  /** The slot's holder gives it back, before delivering. */
  withdraw: (objective: string, params: Params): Call => ({
    receiver: objective,
    method: "ob_withdraw",
    args: { params },
    tgas: TGAS.commit,
  }),

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

  /** The sponsor takes the funding back while no slot is committed. One payout, so the attest budget covers it. */
  cancel: (objective: string, params: Params): Call => ({
    receiver: objective,
    method: "ob_cancel",
    args: { params },
    tgas: attestTgas(params),
  }),

  close: (objective: string, params: Params): Call => ({
    receiver: objective,
    method: "ob_close",
    args: { params },
    tgas: closeTgas(params),
  }),
};

/**
 * The same funding as a Verifier `transfer` intent, for a sponsor who signs
 * intents rather than NEAR transactions: signed by the sponsor (its
 * `signer_id`) and relayed with `execute_intents`.
 */
export const fundIntent = (objective: string, params: Params, amount: bigint) => ({
  intent: "transfer" as const,
  receiver_id: objective,
  tokens: { [tokenOf(params)]: amount.toString() },
  msg: fundMsg(params),
});

/**
 * A call as a raw NEAR function call: gas in gas units and deposit in
 * yoctoNEAR, both decimal strings. These are the field names and units of the
 * NEAR Intents Agent API's `native/near/call` body, which an agent's own NEAR
 * account sends as is.
 */
export const nearCall = ({ receiver, method, args, tgas, yocto }: Call) => ({
  receiver_id: receiver,
  method_name: method,
  args,
  gas: (BigInt(tgas) * 10n ** 12n).toString(),
  ...(yocto !== undefined ? { deposit: yocto.toString() } : {}),
});

/** A call as an agent reads it: gas and deposit in the units wallets take, and the same call as `near_call`. */
export const describe = (call: Call) => ({
  receiver: call.receiver,
  method: call.method,
  args: call.args,
  gas: `${call.tgas} Tgas`,
  ...(call.yocto !== undefined ? { deposit: `${call.yocto} yocto` } : {}),
  near_call: nearCall(call),
});
