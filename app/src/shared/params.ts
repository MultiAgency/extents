/**
 * `extents_objective::Params` and the NEP-616 address it deploys to. The
 * borsh schemas below mirror `contracts/objective/src/state.rs` field for
 * field; any drift changes the derived address, which the tests pin
 * against the contract's own vectors (`contracts/objective/tests/vectors`).
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { b } from "@zorsh/zorsh";
import { deriveAccountId } from "near-kit";

/** 100% in pips (`defuse_fees::Pips::MAX`). */
export const PIPS_MAX = 1_000_000;
export const MAX_CONTRIBUTORS = 10;

/** JSON form, as passed to every contract method. */
export interface Params {
  sponsor: string;
  /** `nep245:<verifier>:<token id inside the verifier>` */
  token: string;
  evaluator: string;
  /** Account id to share in pips. */
  contributors: Record<string, number>;
  /**
   * Contributor to the account that may take its slot if it has not
   * committed by `commit_by`.
   */
  backups?: Record<string, string>;
  /** RFC 3339, up to nanoseconds. Funding, commitment and delivery end here. */
  deadline: string;
  /** RFC 3339. After it, a backup may commit in its contributor's place. */
  commit_by?: string;
  /**
   * If set, once every contributor has delivered, the evaluator has at
   * least this long to attest; without a verdict the objective then
   * resolves as accepted and pays out.
   */
  acceptance_window_secs?: number;
  spec_hash: string;
  auth_caller?: string;
  salt: string;
}

const accountId = b.string();
const nanos = b.i64();
const hash = b.bytes(32);

/** `defuse_token_id::TokenId`, variants in discriminant order. */
const tokenId = b.enum({
  Nep141: b.struct({ contract_id: accountId }),
  Nep171: b.struct({ contract_id: accountId, nft_token_id: b.string() }),
  Nep245: b.struct({ contract_id: accountId, mt_token_id: b.string() }),
  Imt: b.struct({ minter_id: accountId, token_id: b.string() }),
});

const paramsSchema = b.struct({
  sponsor: accountId,
  token: tokenId,
  evaluator: accountId,
  contributors: b.hashMap(accountId, b.u32()),
  backups: b.hashMap(accountId, accountId),
  deadline: nanos,
  commit_by: b.option(nanos),
  acceptance_window_secs: b.option(b.u32()),
  spec_hash: hash,
  auth_caller: b.option(accountId),
  salt: hash,
});

const unit = b.unit();
/** `ContractStorage`: `None` once the objective is being deleted. */
const storageSchema = b.option(
  b.struct({
    params_hash: hash,
    funded: b.u128(),
    committed: b.u16(),
    delivered: b.u16(),
    taken: b.u16(),
    outcome: b.option(b.enum({ Achieved: unit, Failed: unit, Expired: unit, Accepted: unit })),
    owed: b.hashMap(b.enum({ Sponsor: unit, Contributor: b.u8() }), b.u128()),
    deadline: nanos,
    in_flight: b.u32(),
  }),
);

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** Nanoseconds since the epoch, exactly, from RFC 3339 with up to 9 fraction digits. */
export function timestampNanos(rfc3339: string): bigint {
  const m = /^((\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d))(?:\.(\d{1,9}))?(Z|[+-](\d\d):(\d\d))$/.exec(rfc3339);
  if (!m) throw new Error(`${JSON.stringify(rfc3339)} is not RFC 3339`);
  // Date.parse rolls impossible fields over (February 30th becomes March 2nd), so the wall clock must round-trip
  const [y, mo, d, h, mi, s] = m.slice(2, 8).map(Number) as [number, number, number, number, number, number];
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const real =
    wall.getUTCFullYear() === y &&
    wall.getUTCMonth() === mo - 1 &&
    wall.getUTCDate() === d &&
    wall.getUTCHours() === h &&
    wall.getUTCMinutes() === mi &&
    wall.getUTCSeconds() === s &&
    (m[9] === "Z" || (Number(m[10]) <= 23 && Number(m[11]) <= 59));
  const millis = Date.parse(`${m[1]}${m[9]}`);
  if (!real || Number.isNaN(millis)) throw new Error(`${JSON.stringify(rfc3339)} is not a date`);
  return BigInt(millis) * 1_000_000n + BigInt((m[8] ?? "").padEnd(9, "0"));
}

/** Account ids compared as bytes, like Rust's `BTreeMap<AccountId, _>`. */
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function contributorsInOrder(p: Params): [string, number][] {
  return Object.entries(p.contributors).sort(([a], [b]) => byteOrder(a, b));
}

function nep245(token: string) {
  const m = /^nep245:([^:]+):(.+)$/.exec(token);
  if (!m) throw new Error(`token ${JSON.stringify(token)} is not a NEP-245 token id`);
  return { Nep245: { contract_id: m[1]!, mt_token_id: m[2]! } };
}

export function borshParams(p: Params): Uint8Array {
  return paramsSchema.serialize({
    sponsor: p.sponsor,
    token: nep245(p.token),
    evaluator: p.evaluator,
    contributors: new Map(Object.entries(p.contributors)),
    backups: new Map(Object.entries(p.backups ?? {})),
    deadline: timestampNanos(p.deadline),
    commit_by: p.commit_by === undefined ? null : timestampNanos(p.commit_by),
    acceptance_window_secs: p.acceptance_window_secs ?? null,
    spec_hash: hexToBytes(p.spec_hash),
    auth_caller: p.auth_caller ?? null,
    salt: hexToBytes(p.salt),
  });
}

/** `Params::hash`: keccak256 of the borsh encoding. */
export const paramsHash = (p: Params): string => bytesToHex(keccak_256(borshParams(p)));

/** `ContractStorage::init_state`: one entry under the empty key. */
export function initState(p: Params): Map<Uint8Array, Uint8Array> {
  const storage = storageSchema.serialize({
    params_hash: keccak_256(borshParams(p)),
    funded: 0n,
    committed: 0,
    delivered: 0,
    taken: 0,
    outcome: null,
    owed: new Map(),
    deadline: timestampNanos(p.deadline),
    in_flight: 0,
  });
  return new Map([[new Uint8Array(), storage]]);
}

/** The objective's account id for code published under `codeHash` (base58). */
export const objectiveAccountId = (p: Params, codeHash: string): string => deriveAccountId({ code: { codeHash }, data: initState(p) });

/** Mirrors `Params::validate`, so a bad draft is caught before anyone signs. */
export function validateParams(p: Params): string | undefined {
  const verifier = /^nep245:([^:]+):.+$/.exec(p.token)?.[1];
  if (!verifier) return "token is not a NEP-245 token id";
  // on_auth trusts its caller to have checked a signature: only the token's own Verifier does
  if (p.auth_caller !== undefined && p.auth_caller !== verifier) return "auth_caller must be the token's Verifier";
  const window = p.acceptance_window_secs;
  if (window !== undefined && !(Number.isInteger(window) && window > 0 && window <= 0xffff_ffff)) {
    return "acceptance_window_secs must be a positive whole number of seconds";
  }
  const shares = Object.values(p.contributors);
  if (shares.length < 1 || shares.length > MAX_CONTRIBUTORS) return `needs 1 to ${MAX_CONTRIBUTORS} contributors`;
  if (shares.some((s) => !Number.isInteger(s) || s <= 0)) return "every share must be a positive whole number of pips";
  if (shares.reduce((a, b) => a + b, 0) !== PIPS_MAX) return "shares must sum to exactly 100%";
  if (p.evaluator in p.contributors) return "the evaluator cannot also be a contributor";
  for (const [field, value] of [
    ["deadline", p.deadline],
    ["commit_by", p.commit_by],
  ] as const) {
    if (value === undefined) continue;
    let nanos: bigint;
    try {
      nanos = timestampNanos(value);
    } catch {
      return `${field} is not a real RFC 3339 date and time`;
    }
    // the contract stores time as i64 nanoseconds: roughly 1677 to 2262
    if (nanos < I64_MIN || nanos > I64_MAX) return `${field} is outside the time range the contract can store (1677 to 2262)`;
  }

  const backups = Object.entries(p.backups ?? {});
  const timed =
    p.commit_by === undefined ? backups.length === 0 : backups.length > 0 && timestampNanos(p.commit_by) < timestampNanos(p.deadline);
  const seen = new Set<string>();
  const distinct = backups.every(
    ([c, backup]) => c in p.contributors && !(backup in p.contributors) && !seen.has(backup) && seen.add(backup),
  );
  if (!timed || !distinct) {
    return "backups need a commit_by before the deadline, each for a listed contributor and distinct from every contributor and other backup";
  }
  if (backups.some(([, backup]) => backup === p.evaluator)) return "the evaluator cannot also be a backup";
  return undefined;
}

export const randomSalt = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
