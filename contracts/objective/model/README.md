# A formal model of the objective

`objective.qnt` is one objective as a [Quint](https://quint-lang.org) state machine: every call
any party makes, refused or not, through funding, commitment, withdrawal, delivery, verdicts,
release, cancel and silence, then the payout batch whose transfers may fail and be retried, the
balance read that may delete it, and stray deposits. It is written from the rules in
[`docs/spec.md` §7](../../../docs/spec.md#7-rules) and checked against the contract's code: the
time comparisons are the code's (contributors act until the original deadline, attestation until
the extended one, `ob_close` only after it, a backup only after `commit_by`).

Its invariants cite the rules they check, as tests do. The simulator explores random runs and
stops at the first state an invariant rejects:

```sh
npx -y @informalsystems/quint@0.34.0 run objective.qnt --invariant invariants \
  --max-samples 20000 --max-steps 80 --seed 1
```

The witnesses are states an invariant could hold vacuously without: released and paid, cancelled
after a withdrawal, accepted by silence, a backup paid, paid after a failed transfer, deleted after
paying, refunded after `failed`. Add `--witnesses releasedAndPaid cancelledAfterWithdrawal
acceptedBySilence backupPaid paidAfterARetry deletedAfterPaying failedRefund` to see how often each
is reached. `quint verify` checks every run up to `--max-steps` with Apalache (needs Java).

## What it leaves out

- **Signed intents.** `on_auth` reaches the same checks as a direct call, so it adds no state.
- **Overlapping roles.** The sponsor, evaluator, contributors and backup are distinct accounts.
  A sponsor that evaluates, or holds a slot, is covered by unit tests only.
- **Address derivation, Params validation and gas.** These are checked once, per call, by the
  unit tests and pinned vectors; the model starts from valid terms at the derived address.
- **Lost callbacks.** Each batch's and balance read's callback arrives, later, as its own step; one
  that never arrives, the known limit in the README, is not modelled. A balance read is answered
  only once no batch is in flight.

## Replaying it against the contract

`src/contract/model.rs` replays the model's runs against the contract with
[`quint-connect`](https://github.com/informalsystems/quint-connect): every call the model makes,
refused or not, is made on the contract under `near-sdk` mocking, and after each step the
contract's state (funding, slots, outcome, the last moment to attest, what is owed, the batch in
flight, `in_flight`) must be the model's. A refused call panics, and the driver puts the state back
as the chain would revert it. The batch a callback settles is read from the receipt the contract
created, not rebuilt.

It needs `quint` on `PATH` and the `near` cfg, which gives the contract the mocked block time the
driver moves rather than the system clock:

```sh
scripts/check --model-replay
```

or, with Quint installed, from `contracts/objective`:

```sh
RUSTFLAGS="--cfg near" CARGO_TARGET_DIR=../../target/model \
  cargo test -p extents-objective --lib contract_follows_the_model -- --ignored
```

CI runs it with a fresh seed each time. A divergence prints its `QUINT_SEED`; rerun with it and
`QUINT_VERBOSE=1` to see each step.
