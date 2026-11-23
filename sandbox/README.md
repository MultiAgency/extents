# extents-sandbox

Integration tests of `extents-objective` on a local NEAR sandbox, against the
same Verifier binary that runs at mainnet `intents.near` and testnet
`verifier.tidepool-sandbox.testnet` (`defuse` v0.4.5).

On a public network only the Verifier's operator can make a transfer fail. In
the sandbox the test holds the operator's roles, so it can lock an
objective's account and let the Verifier's own code reject its payouts. No
failure is simulated.

## Requirements

- **Docker.** `near-kit-sandbox` runs nearcore 2.14 (protocol 88) from the
  `nearprotocol/sandbox` image.
- **The objective's wasm**. Set `EXTENTS_OBJECTIVE_WASM` to test a given
  file, such as the exact artifact to publish. Otherwise the local build is
  used, built from the current source as below. Each run prints the sha256
  of the build it tested.

  ```sh
  (cd contracts/objective && cargo near build non-reproducible-wasm --locked \
    --features=contract --abi-features=abi,contract)
  ```

- **Network access on first run.** Third-party code is fetched once, cached
  in `target/sandbox/`, and used only if its sha256 matches the pin:
  - the Verifier, from testnet `verifier.tidepool-sandbox.testnet` or else
    mainnet `intents.near`: `a1afab98…b547`, which is code hash
    `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk` at both;
  - the Sputnik DAO, from mainnet `agentic.sputnik-dao.near`:
    `bf6f951e…d7f6`;
  - the NEP-171 contract of `tests/proof.rs`, `releases/non-fungible-token.wasm`
    of `near/intents` at `dbad9c8`, from GitHub: `38cfeef9…abbc`;
  - the NEP-141 test token, `releases/fungible-token.wasm` of `near/intents`
    at `dbad9c8`, from GitHub: `12c5f9bd…a354`.

## Run

```sh
cargo nextest run -p extents-sandbox --run-ignored only
```

[`cargo-nextest`](https://nexte.st) runs the tests in parallel across files.
`.config/nextest.toml` caps the sandbox tests at three at a time, since each
starts its own Docker sandbox and more starve each other's block production,
and stops a test still running after 20 minutes as hung. Without nextest,
`cargo test -p extents-sandbox -- --ignored` runs the same tests one file
after another.

The tests are `#[ignore]` by default, so the workspace's `cargo test` does not
need Docker. Each test starts a fresh sandbox, and the tests run in parallel.
The suite takes several minutes; acceptance windows and cleanup advance sandbox block time.
An unattributed balance is retained however many blocks pass, and keeps the
objective from deleting itself.

## Environment

`Env::new` sets up the following:

- **Verifier.** Deployed with `wnear_id` set and no fee. A separate
  `operator` account holds `UnrestrictedAccountLocker` and
  `UnrestrictedAccountUnlocker`.
- **Test token.** Deployed with the sponsor as owner. The Verifier is
  registered for storage, and the whole supply is deposited for the sponsor
  with `ft_transfer_call`.
- **Objective.** Published as a global contract by code hash. Instances are
  deployed with a zero-deposit `StateInit`.
- **Accounts.** `sponsor`, `evaluator`, `closer`, and the requested number of
  contributors.

Every attestation, direct, by proposal or by signed intent, attaches exactly
`Params::attest_gas`, the rule the app and the testnet e2e also use, so the
suite tests that rule.

`Env::fast_forward_past(deadline)` produces empty blocks until block time
passes the deadline. Every step must advance final block time; stalled progress
is an error, and the entire wait has a 15-minute wall-clock timeout. A block
advances block time by about 0.3 s.

## Tests

`tests/retry.rs`:

| Test | Shows |
| --- | --- |
| `failed_payouts_are_requeued_and_retried` | With the objective locked on the Verifier, an achieved verdict's three payouts all fail with `account '0s…' is locked`. A `lost` event reports them, and `owed` holds exactly the split while the Verifier balance stays intact. `ob_close` while still locked fails the same way and loses nothing. After unlocking, `ob_close` pays every share exactly. Past the deadline, `ob_close` deletes the account. |
| `worst_case_close_retries_eleven_payouts_and_deletes` | The heaviest `ob_close`. With ten contributors and the objective locked, all eleven payouts (shares and the sponsor's remainder) fail. After the deadline and unlocking, one `ob_close` retries all eleven, reads the objective's Verifier balance and deletes the account, in a single transaction burning 57 Tgas. |

`tests/lifecycle.rs` covers the scenarios of the testnet [`e2e`](../e2e/README.md) run:

| Test | Shows |
| --- | --- |
| `achieved_pays_shares_from_a_zero_balance` | An achieved verdict is refused until both contributors have delivered: with one commitment, and again with both committed but neither delivered. Once both have delivered, it pays 70/30 exactly, with the rounding remainder to the sponsor, and emits `committed`, `resolved` (with `review_hash`) and `paid`. Each payout attaches 1 yoctoNEAR while the instance's NEAR balance stays 0. After the deadline, `ob_close` deletes the account. |
| `failed_returns_everything_to_the_sponsor` | A failed verdict returns the whole amount to the sponsor in one payout. |
| `expired_returns_funds_and_deletion_pays_the_closer` | A `StateInit` deposit is refunded to the signer, and the instance starts at 0 NEAR. NEAR sent by a plain transfer stays. `ob_close` is refused before the deadline. After it, `ob_close` resolves as expired and returns everything, and the account is deleted in the same transaction. The closer receives the instance's NEAR less the payout's 1 yoctoNEAR. |
| `fund_by_signed_transfer_intent` | Funding by a signed `transfer` intent whose `msg` is the fund message, as an account without NEAR for gas, or a DAO's derived account, funds. The Verifier calls `mt_on_transfer` with the signer as sender. A non-sponsor's identical intent is refused, and the Verifier refunds it. |
| `commit_and_attest_by_signed_intent` | Both contributors commit and deliver, and the evaluator attests, by signed `auth_call` intents relayed to `execute_intents`. Each contributor's key is registered with `add_public_key` first. The payouts are exact. |
| `ten_contributors_settle_in_one_transaction` | Ten contributors and eleven payouts in one `ob_attest`. Each `mt_transfer` uses less than its 15 Tgas, and the callback less than its 10. |
| `ten_contributors_settle_by_signed_intent` | The same, with the evaluator attesting by signed intent with `Params::attest_gas` (210 Tgas) as `min_gas`. The Verifier forwards more than that to `on_auth`. |

`tests/accounts.rs` shows that objectives work with any NEAR account, since
they check only the caller:

| Test | Shows |
| --- | --- |
| `implicit_accounts_sponsor_and_evaluate` | A hex implicit account, created by a plain transfer, funds with `mt_transfer_call`, and another attests with `ob_attest`. |
| `dao_sponsors_and_evaluates_by_proposal` | A Sputnik DAO running mainnet's agency DAO code (pinned like the Verifier: `DtHZA1mU…`, fetched from `agentic.sputnik-dao.near`) is sponsor and evaluator. It funds by a `FunctionCall` proposal to `mt_transfer_call`, and attests by one to `ob_attest`. Each runs on the council's last approval, with the DAO as caller. |
| `dao_attests_for_ten_contributors_by_proposal` | The heaviest attestation by proposal. A DAO evaluator attests for ten contributors with an `ob_attest` of `Params::attest_gas` (210 Tgas), inside a 300 Tgas vote. All eleven payouts succeed. |

`tests/stranded.rs` covers balances that arrive without the sponsor's
`mt_transfer_call`:

| Test | Shows |
| --- | --- |
| `a_plain_transfer_is_never_counted` | A plain `mt_transfer` never notifies the objective, so it is never counted as funding. A failed verdict refunds only what was funded, and the unattributed amount stays on the objective's balance. |
| `arrivals_after_the_verdict_are_retained` | An unattributed balance that arrives after the verdict is retained: closing after the deadline neither sends it anywhere nor deletes the objective. |
| `an_under_gassed_deposit_is_refunded_and_never_counted` | A funding deposit whose `mt_on_transfer` runs out of gas is refunded in full and never counted. Only a band of about 0.7 Tgas starves `mt_on_transfer` without starving the Verifier's own call, so the test steps up to it. Its `funded` log survives in the failed receipt, which is why events count only from successful receipts. |

`tests/release.rs` covers the sponsor releasing the payment itself, without
the evaluator:

| Test | Shows |
| --- | --- |
| `sponsor_releases_once_every_slot_delivered` | The sponsor's achieved verdict is refused until every contributor has delivered. Then it resolves as `released` and pays 70/30 exactly, with the remainder to the sponsor. A second verdict is refused. |
| `sponsor_can_never_attest_failed` | The sponsor's failed verdict is `unauthorized`, and the funds stay on the objective. |
| `sponsor_releases_by_signed_intent` | The same release by a signed `auth_call` intent relayed to `execute_intents`. |
| `a_sponsor_who_evaluates_attests_as_the_evaluator` | When the sponsor is also the evaluator, its achieved verdict records `achieved`, not `released`. |

`tests/cancel_withdraw.rs` covers leaving early:

| Test | Shows |
| --- | --- |
| `sponsor_cancels_before_any_commitment` | Only the sponsor can cancel. With no slot committed, cancelling refunds the whole amount and resolves as `cancelled`; funding and commitment are then refused. |
| `a_commitment_locks_the_funding_until_it_is_withdrawn` | Withdrawing without a commitment is refused. A commitment blocks cancelling; once it is withdrawn (a `withdrawn` event), the sponsor can cancel. |
| `a_withdrawn_slot_passes_between_contributor_and_backup` | The listed contributor commits, withdraws and commits again. After `commit_by` the backup takes the empty slot; the contributor can then neither take it back nor withdraw it. Delivered work cannot be withdrawn, and the holder at the verdict is paid the slot's share. |
| `withdraw_and_cancel_by_signed_intent` | Commitment, withdrawal and cancellation by signed `auth_call` intents. |

`tests/matching.rs` covers matching as NEAR Intents does it: a solver's quote
is its signed commitment, the sponsor answers with signed funding, and a
relayer sends both in one `execute_intents`. The app has no such flow.

| Test | Shows |
| --- | --- |
| `a_quote_and_its_funding_settle_in_one_transaction` | Both intents are signed for an address nobody has launched. A third party launches it, and one transaction funds and commits, in either order of the pair. |
| `the_verifier_accepts_the_pair_or_neither` | Funding the sponsor cannot cover fails the transaction, and the quote does not land; the same quote then matches funding the sponsor can cover. A quote signed with a key the Verifier does not know fails it too, and no funding moves. |
| `each_half_lands_without_the_other` | Nothing ties the two intents together. A quote relayed alone commits its solver to an unfunded objective, and the solver withdraws. Funding lands beside a commitment from an account the terms do not name, whose `on_auth` fails, and the sponsor cancels. |
| `a_pair_relayed_before_the_launch_is_spent` | The Verifier's intents cannot carry the launch. Relayed to an address with no account, the pair moves nothing, and relaying it again after the launch is refused: both signatures are spent. |

`tests/proof.rs` covers a fact as a token, settled as a swap on the Verifier
alone. An attester owns an NFT contract (the NEP-171 example of `near/intents`
at `dbad9c8`: `38cfeef9…abbc`) and deposits a token for the fact into the
Verifier, where it is the balance `nep171:<contract>:<fact>`. No objective
takes part, and neither the contract nor the app has such a flow.

| Test | Shows |
| --- | --- |
| `a_proof_swaps_for_the_payment_in_one_transaction` | The sponsor signs a `token_diff` paying for the proof before it exists. Once the attester mints it to the solver, the solver's opposite `token_diff` and the sponsor's settle in one transaction: the solver is paid and the sponsor holds the proof. |
| `neither_half_of_a_swap_lands_alone` | Either `token_diff` alone fails with `invariant violated` and stays unspent; the same two then settle together. |
| `only_the_named_issuers_proof_fills_the_offer` | A solver without the proof fails with `insufficient balance`. The same fact minted from the solver's own contract is a different token and fails with `invariant violated`. |
| `a_signed_offer_locks_nothing` | The sponsor moves its balance away after the solver holds the proof, and the swap fails with `insufficient balance`. |
| `the_deployed_verifier_has_no_mint_intent` | The `imt_mint` intent in the Verifier's source is refused by the deployed build as an unknown variant, which is why the proof is an NFT. |

`tests/escrow.rs` covers the same proof paid from an escrow: the
[`escrow-swap`](https://github.com/near/intents/tree/dbad9c8a4659e8bd7f42c152ec79448a8e9d281c/contracts/escrow-swap)
contract of `near/intents`, which locks the sponsor's payment at an address its
params derive and pays whoever sends it the token it names. No objective takes
part, and neither the contract nor the app has such a flow. The escrow has no
published build, so the tests read `EXTENTS_ESCROW_SWAP_WASM`, or else
`target/sandbox/defuse_escrow_swap.wasm`, and print the sha256 they ran. Build
it from the commit the `defuse-*` dependencies pin:

```sh
git clone https://github.com/near/intents && cd intents
git checkout dbad9c8a4659e8bd7f42c152ec79448a8e9d281c
(cd contracts/escrow-swap && cargo near build non-reproducible-wasm --locked \
  --features=contract --abi-features=abi,contract)
# target/near/defuse_escrow_swap/defuse_escrow_swap.wasm
```

| Test | Shows |
| --- | --- |
| `a_proof_fills_an_escrow_that_holds_the_payment` | The sponsor funds the escrow before the proof exists, and its `es_close` is `unauthorized`: the payment stays. Once the attester mints the proof to the solver, the solver's `mt_transfer_call` of it to the escrow pays the solver and hands the sponsor the proof, with every receipt succeeding and nothing left in the escrow. |
| `without_the_named_proof_the_payment_returns_at_the_deadline` | The same fact minted from the solver's own contract is refused as `wrong token` and returned. After the deadline a third party closes the escrow, and the whole payment returns to the sponsor. |

`tests/fastdata.rs` covers publishing to an objective's own account, which
FastData indexes from calls to `__fastdata_kv`:

| Test | Shows |
| --- | --- |
| `publishing_is_accepted_and_changes_nothing` | From an account with no role, the launch documents, an empty `{}` and a 100 KB document are each accepted, burning under 3 Tgas (1.3–1.5 measured). The objective's state, storage, NEAR and Verifier balances are identical before and after. |
| `a_publish_with_a_deposit_is_refused` | A publish attaching 1 yoctoNEAR is refused, the yoctoNEAR returns to the sender, and nothing about the objective changes. |

`tests/gas.rs` measures `ob_commit` and `ob_deliver` in an ordinary state and
at the largest valid one (ten contributors, each with a backup, a window,
`commit_by` and `auth_caller`). Both burn at most 1.7 Tgas, and the tests
require at least a fourfold margin under the client's `gas::CALL` (10 Tgas).

Every call is built by [`extents-client`](../crates/client) from the
objective's `Params`, the same code the testnet e2e sends. Signed intents
expire relative to block time, which in the sandbox runs ahead of wall-clock
time once blocks are fast-forwarded.
