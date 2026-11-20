/**
 * The evaluator's attestation as calls to sign: `ob_attest` directly when the
 * evaluator is the signer's own account, or a Sputnik DAO `FunctionCall`
 * proposal that makes the same call once the DAO approves it.
 */
import { DOCUMENT_KEYS } from "./config.ts";
import { reviewHash, type Review } from "./spec.ts";
import type { Params } from "./params.ts";

/** A Sputnik DAO as an evaluator. */
export interface Dao {
  /** In yoctoNEAR, attached to `add_proposal`. */
  proposal_bond: string;
  /** Who may file a function-call proposal. */
  proposers: string[] | "anyone";
}

/**
 * Gas for `ob_attest`: the contract's `Params::attest_gas`, pinned by
 * `contracts/objective/tests/vectors/params.json`. A transfer per payout
 * (each contributor and the sponsor's remainder), their callback, and the
 * call itself.
 */
export const attestTgas = (params: Params) => (Object.keys(params.contributors).length + 1) * 15 + 10 + 35;

/**
 * Gas for `ob_close`, as `Params::close_gas`: its worst case retries every
 * payout as `ob_attest` sends them, then reads the Verifier balance and, at
 * zero, deletes the account.
 */
export const closeTgas = (params: Params) => attestTgas(params) + 5 + 35;

/** The contract's `Attestation`: a verdict and, optionally, the hash of the review behind it. */
export interface Attestation {
  verdict: Review["verdict"];
  review_hash?: string;
}

/** The attestation of a review: its verdict, committed to by its hash. */
export const attestationOf = (review: Review): Attestation => ({ verdict: review.verdict, review_hash: reviewHash(review) });

export const attestArgs = (params: Params, attestation: Attestation) => ({ params, attestation });

const base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** `add_proposal` args for a DAO evaluator: the same `ob_attest`, on approval. */
export function attestProposal(objective: string, params: Params, attestation: Attestation) {
  const args = attestArgs(params, attestation);
  const review = attestation.review_hash
    ? ` Review ${attestation.review_hash}, published on FastData under the objective's account as "${DOCUMENT_KEYS.review}".`
    : "";
  return {
    proposal: {
      description: `Attest ${attestation.verdict} on objective ${objective}.${review}`,
      kind: {
        FunctionCall: {
          receiver_id: objective,
          actions: [
            {
              method_name: "ob_attest",
              args: base64(JSON.stringify(args)),
              deposit: "0",
              gas: (BigInt(attestTgas(params)) * 10n ** 12n).toString(),
            },
          ],
        },
      },
    },
  };
}

export const mayPropose = (dao: Dao, account: string) => dao.proposers === "anyone" || dao.proposers.includes(account);
