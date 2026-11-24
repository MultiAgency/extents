/** The service's own ceiling was reached: the refusal is the service's, not the caller's. */
export class BudgetError extends Error {
  constructor() {
    super("Service budget reached; try again later");
    this.name = "BudgetError";
  }
}

/** Process-wide ceilings: caller-supplied accounts and proxy headers are not identities.
 * Multi-process deployments must enforce the same ceilings at their shared gateway. */
export class Budget {
  private started = 0;
  private used = 0;
  private active = 0;
  constructor(
    private readonly limit: number,
    private readonly concurrency: number,
    private readonly periodMs = 3_600_000,
    private readonly now = Date.now,
  ) {}

  acquire(): () => void {
    const now = this.now();
    if (now - this.started >= this.periodMs) {
      this.started = now;
      this.used = 0;
    }
    if (this.used >= this.limit || this.active >= this.concurrency) throw new BudgetError();
    this.used++;
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}
