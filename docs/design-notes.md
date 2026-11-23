# Contract design decisions

These decisions describe the current implementation and why it is so. The rules themselves are in
[`docs/spec.md` §7](spec.md#7-rules); README.md documents the interface; `contracts/objective/src` and
the pinned vectors define its encoding.

## Sponsor-only funding

Only the Params sponsor can fund, in the configured NEP-245 token, before the original deadline.
Funding uses `mt_transfer_call` or a sponsor-signed transfer intent with the fund message.
A refused notification is refunded by the Verifier. A plain transfer never increments `funded`.
Several sponsors must arrange their own funding before choosing one sponsor account; this contract
has no collection, voting, donation or multi-sponsor flow.

## Commitment, backups and silence

A named backup may take an empty slot after `commit_by`. A committed slot changes holder only if
its holder withdraws, which empties it. Delivery is an immutable hash, recorded by that holder
before the original deadline, and can never be withdrawn.

Either side can give up its own claim without a judge. A holder withdraws before delivering; the
sponsor cancels while no slot is committed, and releases once every slot has delivered. Nothing
enforced a commitment before withdrawal existed, since no stake backs one, so withdrawal replaces
silence until the deadline with a recorded exit. One commitment locks the funding against cancel.

The last delivery can extend the evaluator's deadline by the configured acceptance window.
It never extends funding, commitment or delivery. Without a verdict, close accepts only when
there is a window and every slot delivered; otherwise it expires and refunds the sponsor.
An achieved verdict requires every slot delivered. The evaluator remains the agreed authority;
this contract has no dispute or partial-verdict mechanism.

The sponsor can release: its own `achieved`, under the evaluator's conditions, pays the split and
resolves as `released`. A party may always give up its own claim, so the sponsor paying needs no
judge, and contributors already concede by not delivering. The sponsor can never attest `failed`.
An agreed settlement therefore needs no evaluator; a disputed one still does.

## Settlement and cleanup

Resolution allocates the funded amount. Dispatch sends payouts, and the callback requeues failures.
Events aggregate payments when one account holds more than one recipient role. Anyone can retry
with close. After the effective deadline, the contract deletes only when nothing is funded, owed
or in flight and the Verifier reports a zero balance.

A nonzero balance is not provenance: it may include a refused deposit awaiting refund. Such
balances are retained. A plain transfer can prevent deletion indefinitely. A lost payout callback
has no recovery path in the current state layout; its behavior is pinned by a unit test.

## Fixed interface and evidence

Params always includes `auth_caller`, even when it is absent in JSON. Disabling a build feature
must never remove it from Borsh or change the derived address. Direct and authenticated actions
share the same contract methods. The client leaves the acting account explicit at each call site.

The contract stores commitments, not documents. The app publishes reports in plaintext and verifies
delivery receipts. Specs and reviews have shared Rust/TypeScript vectors. Model receipts verify
provider signatures, not TEE execution or the truth of a real-world claim. See documents.md.

Gas figures scheduled by settlement live in `gas.rs`; callers use `Params::attest_gas` and
`Params::close_gas` (the attest budget plus the balance read and its callback, for a close that
retries every payout and deletes). Changes to payout recovery or either rule need sandbox evidence:
the suite attaches exactly these figures.
