// -*- mode: Bluespec; -*-
/**
 * One objective of `contracts/objective` as a state machine, written from the rules in
 * docs/spec.md §7 and checked against the contract's code (`contract/commit.rs`,
 * `contract/settle.rs`, `contract/tokens.rs`, `contract/cleanup.rs`).
 *
 * Two contributor slots (70% and 30%), a backup for slot 0, a sponsor, an evaluator and a
 * stranger, on a clock of whole ticks. The acceptance window is chosen at `init`: none, or two
 * ticks. Every call any actor makes is a step, and a call the contract refuses leaves the state as
 * it was. Payouts go out as one batch whose transfers may each fail; `ob_close` may read the
 * objective's Verifier balance, and only that reading deletes it. A plain transfer into the
 * account (`strayDeposit`) is a balance nobody funded.
 *
 * `quint run` explores random runs against the invariants below, and
 * `src/contract/model.rs` replays its runs against the contract itself (see README.md).
 */
module objective {
  // ---- the terms, fixed by Params ----

  pure val SPONSOR = "sponsor"
  pure val EVALUATOR = "evaluator"
  pure val C0 = "c0"
  pure val C1 = "c1"
  pure val B0 = "b0"
  pure val STRANGER = "stranger"
  pure val ACTORS = Set(SPONSOR, EVALUATOR, C0, C1, B0, STRANGER)

  pure val SLOTS = Set(0, 1)
  /** A payout's recipient: a slot, or the sponsor. */
  pure val TO_SPONSOR = -1
  pure val RECIPIENTS = Set(TO_SPONSOR, 0, 1)

  pure val MAX_PIPS = 1000000
  pure def share(slot: int): int = if (slot == 0) 700000 else 300000
  pure def listed(slot: int): str = if (slot == 0) C0 else C1
  /** The backup of a slot, or "" for none. */
  pure def backupOf(slot: int): str = if (slot == 0) B0 else ""

  pure val COMMIT_BY = 2
  pure val DEADLINE = 5
  pure val MAX_TIME = 10
  pure val WINDOWS = Set(0, 2)

  pure val PAYING = Set("achieved", "accepted", "released")
  pure val OUTCOMES = Set("achieved", "failed", "expired", "accepted", "released", "cancelled")

  // ---- state ----

  type State = {
    now: int,
    /** `acceptance_window_secs`, in ticks; 0 is none. */
    window: int,
    /** The funding not yet allocated. */
    funded: int,
    /** Everything the sponsor ever funded. */
    totalFunded: int,
    /** Plain transfers into the account: nobody's funding. */
    stray: int,
    /** The objective's balance on the Verifier. */
    balance: int,
    committed: Set[int],
    /** Slots a backup holds. */
    taken: Set[int],
    delivered: Set[int],
    everCommitted: Set[int],
    everDelivered: Set[int],
    /** When each backup took its slot. */
    takenAt: int -> int,
    /** The last moment to attest: the deadline, extended by the window once all delivered. */
    attestBy: int,
    /** "" until resolved. */
    outcome: str,
    resolvedBy: str,
    resolvedAt: int,
    attestByAtResolve: int,
    committedAtResolve: Set[int],
    deliveredAtResolve: Set[int],
    fundedAtResolve: int,
    resolutions: int,
    /** Allocated but not sent. */
    owed: int -> int,
    /** The batch of transfers sent, awaiting its callback. */
    sending: int -> int,
    /** Balance reads sent, awaiting their callbacks. */
    readsPending: int,
    /** The contract's `in_flight`: callbacks it awaits. */
    inFlight: int,
    /** What each account received from the objective. */
    paid: str -> int,
    failures: int,
    deleted: bool,
    /** What the last step did, "refused" when the contract refused the call. */
    last: str,
  }

  var st: State

  // ---- derived ----

  pure def sumOf(m: int -> int): int = m.keys().fold(0, (acc, k) => acc + m.get(k))
  pure def zeros: int -> int = RECIPIENTS.mapBy(_ => 0)
  pure def max(a: int, b: int): int = if (a > b) a else b

  /** Who holds a slot: its backup once taken, else its listed contributor. */
  pure def holder(s: State, slot: int): str = if (s.taken.contains(slot)) backupOf(slot) else listed(slot)
  pure def account(s: State, r: int): str = if (r == TO_SPONSOR) SPONSOR else holder(s, r)

  /** `Params::split` for paying outcomes: each share rounded down, the remainder to the sponsor. */
  pure def allocation(outcome: str, f: int): int -> int =
    if (PAYING.contains(outcome)) {
      val s0 = f * share(0) / MAX_PIPS
      val s1 = f * share(1) / MAX_PIPS
      Map(TO_SPONSOR -> (f - s0 - s1), 0 -> s0, 1 -> s1)
    } else Map(TO_SPONSOR -> f, 0 -> 0, 1 -> 0)

  /** Resolved and paid out, whatever is still in flight. */
  pure def paidOut(s: State): bool = s.outcome != "" and s.funded == 0 and sumOf(s.owed) == 0 and sumOf(s.sending) == 0

  /** `State::is_settled`: paid out, nothing in flight, past the last moment to attest. */
  pure def isSettled(s: State): bool = paidOut(s) and s.inFlight == 0 and s.now > s.attestBy

  /** Contributors may act: no verdict, and the original deadline not passed (`open_for`). */
  pure def open(s: State): bool = s.outcome == "" and s.now <= DEADLINE

  /** The one slot `actor` is named for, as its listed contributor or its backup, or -1. */
  pure def slotOf(actor: str): int =
    SLOTS.fold(-1, (found, slot) => if (listed(slot) == actor or backupOf(slot) == actor) slot else found)

  /** The slot `actor` holds, committed and not delivered (`held_undelivered`), or -1. */
  pure def heldUndelivered(s: State, actor: str): int =
    SLOTS.fold(-1, (found, slot) =>
      if (holder(s, slot) == actor and s.committed.contains(slot) and not(s.delivered.contains(slot))) slot else found)

  pure def refused(s: State): State = { ...s, last: "refused" }

  pure def resolved(s: State, o: str, by: str): State = {
    val alloc = allocation(o, s.funded)
    {
      ...s,
      outcome: o,
      resolvedBy: by,
      resolvedAt: s.now,
      attestByAtResolve: s.attestBy,
      committedAtResolve: s.committed,
      deliveredAtResolve: s.delivered,
      fundedAtResolve: s.funded,
      resolutions: s.resolutions + 1,
      funded: 0,
      owed: RECIPIENTS.mapBy(r => s.owed.get(r) + alloc.get(r)),
    }
  }

  /** `dispatch`: everything owed goes out as one batch under one callback. */
  pure def dispatched(s: State): State =
    if (sumOf(s.owed) == 0) s
    else { ...s, sending: RECIPIENTS.mapBy(r => s.sending.get(r) + s.owed.get(r)), owed: zeros, inFlight: s.inFlight + 1 }

  // ---- actions: every call any actor makes, refused or not ----

  action init = {
    nondet window = WINDOWS.oneOf()
    st' = {
      now: 0, window: window,
      funded: 0, totalFunded: 0, stray: 0, balance: 0,
      committed: Set(), taken: Set(), delivered: Set(), everCommitted: Set(), everDelivered: Set(),
      takenAt: Map(),
      attestBy: DEADLINE,
      outcome: "", resolvedBy: "", resolvedAt: -1, attestByAtResolve: -1,
      committedAtResolve: Set(), deliveredAtResolve: Set(), fundedAtResolve: 0, resolutions: 0,
      owed: zeros, sending: zeros, readsPending: 0, inFlight: 0,
      paid: ACTORS.mapBy(_ => 0), failures: 0,
      deleted: false, last: "init",
    }
  }

  // docs/spec.md, "Only the sponsor funds": anyone else's funding is refused and returned, so it changes nothing.
  action fund(actor: str, amount: int): bool = {
    val ok = actor == SPONSOR and st.outcome == "" and st.now <= DEADLINE
    val funded: State = { ...st, funded: st.funded + amount, totalFunded: st.totalFunded + amount, balance: st.balance + amount, last: "fund" }
    all { not(st.deleted), st' = if (ok) funded else refused(st) }
  }

  action commit(actor: str): bool = {
    val slot = slotOf(actor)
    val backup = slot >= 0 and backupOf(slot) == actor
    // the listed contributor while it is open; its backup only after commit_by; either only into an empty slot
    val ok = open(st) and slot >= 0 and not(st.committed.contains(slot)) and (not(backup) or st.now > COMMIT_BY)
    val committed: State = {
      ...st,
      committed: st.committed.union(Set(slot)),
      everCommitted: st.everCommitted.union(Set(slot)),
      taken: if (backup) st.taken.union(Set(slot)) else st.taken,
      takenAt: if (backup) st.takenAt.put(slot, st.now) else st.takenAt,
      last: if (backup) "backup commits" else "commit",
    }
    all { not(st.deleted), st' = if (ok) committed else refused(st) }
  }

  action withdraw(actor: str): bool = {
    val slot = heldUndelivered(st, actor)
    val ok = open(st) and slot >= 0
    val withdrawn: State = { ...st, committed: st.committed.exclude(Set(slot)), taken: st.taken.exclude(Set(slot)), last: "withdraw" }
    all { not(st.deleted), st' = if (ok) withdrawn else refused(st) }
  }

  action deliver(actor: str): bool = {
    val slot = heldUndelivered(st, actor)
    val ok = open(st) and slot >= 0
    val delivered = st.delivered.union(Set(slot))
    val done: State = {
      ...st,
      delivered: delivered,
      everDelivered: st.everDelivered.union(Set(slot)),
      // the last delivery opens the window: at least `window` from now
      attestBy: if (delivered == SLOTS and st.window > 0) max(st.attestBy, st.now + st.window) else st.attestBy,
      last: "deliver",
    }
    all { not(st.deleted), st' = if (ok) done else refused(st) }
  }

  action attest(actor: str, verdict: str): bool = {
    // the evaluator judges either way; the sponsor may only concede
    val outcome = if (actor == EVALUATOR) verdict else if (actor == SPONSOR and verdict == "achieved") "released" else ""
    val ok = st.outcome == "" and outcome != "" and st.now <= st.attestBy and (verdict == "failed" or st.delivered == SLOTS)
    val attested: State = { ...dispatched(resolved(st, outcome, actor)), last: "attest" }
    all { not(st.deleted), st' = if (ok) attested else refused(st) }
  }

  action cancel(actor: str): bool = {
    val ok = actor == SPONSOR and st.outcome == "" and st.committed == Set()
    val cancelled: State = { ...dispatched(resolved(st, "cancelled", actor)), last: "cancel" }
    all { not(st.deleted), st' = if (ok) cancelled else refused(st) }
  }

  /**
   * `ob_close`, anyone: resolves a silent objective past the last moment to attest and sends what
   * is owed. Past that moment a batch it sends is followed by a balance read; with nothing to send,
   * a settled objective reads its balance at once.
   */
  action close: bool = {
    val resolving = st.outcome == "" and st.now > st.attestBy
    val ok = st.outcome != "" or resolving
    val silent = if (st.window > 0 and st.delivered == SLOTS) "accepted" else "expired"
    val r = if (resolving) resolved(st, silent, "close") else st
    val sent = dispatched(r)
    val batch = sent.inFlight > r.inFlight
    val reads = (batch and st.now > st.attestBy) or (not(batch) and isSettled(sent))
    val closed: State = {
      ...sent,
      readsPending: sent.readsPending + (if (reads) 1 else 0),
      inFlight: sent.inFlight + (if (reads) 1 else 0),
      last: "close",
    }
    all { not(st.deleted), st' = if (ok) closed else refused(st) }
  }

  /** The batch's callback: each transfer paid to whoever holds the slot, or owed again. */
  action payouts(failing: Set[int]): bool = {
    val paidNow = RECIPIENTS.filter(r => not(failing.contains(r)))
    val amount = paidNow.fold(0, (acc, r) => acc + st.sending.get(r))
    all {
      not(st.deleted), sumOf(st.sending) > 0,
      st' = {
        ...st,
        sending: zeros,
        owed: RECIPIENTS.mapBy(r => st.owed.get(r) + (if (failing.contains(r)) st.sending.get(r) else 0)),
        balance: st.balance - amount,
        paid: ACTORS.mapBy(a => st.paid.get(a) + paidNow.filter(r => account(st, r) == a).fold(0, (acc, r) => acc + st.sending.get(r))),
        failures: st.failures + RECIPIENTS.filter(r => failing.contains(r) and st.sending.get(r) > 0).size(),
        inFlight: st.inFlight - 1,
        last: "payouts",
      },
    }
  }

  /** A balance read's callback, after any batch before it: zero, on a settled objective, deletes it. */
  action balanceRead: bool = {
    val after: State = { ...st, readsPending: st.readsPending - 1, inFlight: st.inFlight - 1 }
    all {
      not(st.deleted), st.readsPending > 0, sumOf(st.sending) == 0,
      st' = { ...after, deleted: isSettled(after) and st.balance == 0, last: "balance read" },
    }
  }

  action strayDeposit(amount: int): bool = all {
    not(st.deleted),
    st' = { ...st, balance: st.balance + amount, stray: st.stray + amount, last: "stray deposit" },
  }

  action tick: bool = all {
    st.now < MAX_TIME,
    st' = { ...st, now: st.now + 1, last: "tick" },
  }

  action step = {
    nondet actor = ACTORS.oneOf()
    nondet amount = Set(1, 3, 10).oneOf()
    nondet verdict = Set("achieved", "failed").oneOf()
    nondet failing = RECIPIENTS.powerset().oneOf()
    any {
      fund(actor, amount),
      commit(actor),
      withdraw(actor),
      deliver(actor),
      attest(actor, verdict),
      cancel(actor),
      close,
      payouts(failing),
      balanceRead,
      strayDeposit(amount),
      tick,
    }
  }

  // ---- invariants ----

  /** Nothing is created or lost: the balance is the unallocated funding, what is owed or in flight, and stray deposits. */
  val conservation = st.deleted or st.balance == st.funded + sumOf(st.owed) + sumOf(st.sending) + st.stray

  // docs/spec.md, "A failed payout stays owed until it is retried"
  /** Every unit funded is unallocated, owed, in flight or paid, exactly once: a failed payout is owed again, never lost or paid twice. */
  val accounting =
    ACTORS.fold(0, (acc, a) => acc + st.paid.get(a)) + st.funded + sumOf(st.owed) + sumOf(st.sending) == st.totalFunded

  /** The contract awaits exactly the batch in flight and the balance reads sent; nothing is owed while a batch is out. */
  val callbacks = and {
    st.inFlight == (if (sumOf(st.sending) > 0) 1 else 0) + st.readsPending,
    not(sumOf(st.sending) > 0 and sumOf(st.owed) > 0),
  }

  // docs/spec.md, "One verdict"
  val oneVerdict =
    st.resolutions <= 1 and (st.outcome == "") == (st.resolutions == 0) and OUTCOMES.union(Set("")).contains(st.outcome)

  // docs/spec.md, "Only the sponsor funds"; docs/spec.md, "One verdict"
  val noFundingAfterVerdict = st.outcome == "" or st.funded == 0

  // docs/spec.md, "Paying out needs every slot delivered"
  val payingNeedsDelivery = not(PAYING.contains(st.outcome)) or st.deliveredAtResolve == SLOTS

  // docs/spec.md, "The sponsor may release but never fail"; docs/spec.md, "The evaluator attests before the last moment to attest"
  val whoResolves = and {
    st.outcome == "released" implies st.resolvedBy == SPONSOR,
    Set("achieved", "failed").contains(st.outcome) implies st.resolvedBy == EVALUATOR,
    Set("accepted", "expired").contains(st.outcome) implies st.resolvedBy == "close",
    st.outcome == "cancelled" implies st.resolvedBy == SPONSOR,
    // an attestation, the sponsor's release included, comes by the last moment to attest; a cancel has no deadline
    Set("achieved", "failed", "released").contains(st.outcome) implies st.resolvedAt <= st.attestByAtResolve,
    st.resolvedBy == "close" implies st.resolvedAt > st.attestByAtResolve,
  }

  // docs/spec.md, "The sponsor may cancel until someone commits"
  val cancelOnlyUncommitted = st.outcome == "cancelled" implies st.committedAtResolve == Set()

  // docs/spec.md, "Silence fails closed unless the terms say otherwise"
  val silence = and {
    st.outcome == "accepted" implies (st.window > 0 and st.deliveredAtResolve == SLOTS),
    st.outcome == "expired" implies not(st.window > 0 and st.deliveredAtResolve == SLOTS),
    st.attestBy == DEADLINE or (st.window > 0 and st.delivered == SLOTS) or st.outcome != "",
  }

  // docs/spec.md, "Only the holder acts for a slot"; docs/spec.md, "A delivery is final"
  val slots = and {
    st.taken.subseteq(st.committed),
    st.delivered.subseteq(st.committed),
    st.delivered == st.everDelivered,
    st.taken.forall(slot => backupOf(slot) != ""),
  }

  // docs/spec.md, "A backup takes an empty slot only after commit-by"
  val backupsAfterCommitBy = st.taken.forall(slot => st.takenAt.get(slot) > COMMIT_BY)

  // docs/spec.md, "Payouts are exact"
  val payoutsExact = paidOut(st) implies {
    val alloc = allocation(st.outcome, st.fundedAtResolve)
    and {
      st.paid.get(SPONSOR) == alloc.get(TO_SPONSOR),
      SLOTS.forall(slot => st.paid.get(holder(st, slot)) == alloc.get(slot)),
      // nobody but the holders and the sponsor is paid: a contributor whose slot a backup took gets nothing
      ACTORS.forall(a => a == SPONSOR or SLOTS.exists(slot => holder(st, slot) == a) or st.paid.get(a) == 0),
    }
  }

  // docs/spec.md, "Deletion only at a zero balance": a stray deposit is never paid out, so it blocks deletion for good
  val deletion = and {
    st.deleted implies (paidOut(st) and st.stray == 0 and st.balance == 0),
    paidOut(st) implies st.balance == st.stray,
  }

  val invariants = and {
    conservation, accounting, callbacks, oneVerdict, noFundingAfterVerdict, payingNeedsDelivery, whoResolves,
    cancelOnlyUncommitted, silence, slots, backupsAfterCommitBy, payoutsExact, deletion,
  }

  // ---- witnesses: states the simulator must reach, or the invariants above hold vacuously ----

  val releasedAndPaid = st.outcome == "released" and paidOut(st)
  val cancelledAfterWithdrawal = st.outcome == "cancelled" and st.everCommitted != Set() and st.totalFunded > 0
  val acceptedBySilence = st.outcome == "accepted" and paidOut(st)
  val backupPaid = st.paid.get(B0) > 0
  val paidAfterARetry = st.failures > 0 and paidOut(st) and PAYING.contains(st.outcome)
  val deletedAfterPaying = st.deleted and st.totalFunded > 0
  val failedRefund = st.outcome == "failed" and paidOut(st) and st.totalFunded > 0
}
