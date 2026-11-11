/** A pass the meeting runs again and again while people talk (the running list, the brainstorm
 *  map, the board): one at a time, on a timer, and after a failure only after a wait that doubles
 *  while it keeps failing, so an API outage isn't hit in a loop. */

/** The first wait after a failure, and the longest. */
export const RETRY_MS = 5_000;
export const RETRY_MAX_MS = 60_000;
export const retryWait = (failures: number) => (failures ? Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (failures - 1)) : 0);

export class PassRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = 0;
  private current: Promise<void> | null = null;
  private failures = 0;
  private stopped = false;

  constructor(
    /** One pass. It throws when it failed; one with nothing to do returns. */
    private readonly pass: () => Promise<unknown>,
    private readonly opts: {
      /** For the log: "[label] <about()>: <error>". */
      label: string;
      about: () => string;
      /** A timer already set keeps its time unless the new one is due sooner. Otherwise the new one replaces it. */
      keepEarlier?: boolean;
      /** After every pass, worked or not: the owner decides whether to schedule the next. */
      settled?: () => void;
    },
  ) {}

  /** A pass is running now. */
  get running(): boolean {
    return this.current !== null;
  }

  /** The next pass in `wait` ms, or later after failures. Nothing while one runs: settled() comes after it. */
  schedule(wait: number) {
    if (this.stopped || this.current) return;
    const ms = Math.max(0, wait, retryWait(this.failures));
    const at = Date.now() + ms;
    if (this.timer) {
      if (this.opts.keepEarlier && this.dueAt <= at) return;
      clearTimeout(this.timer);
    }
    this.dueAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  /** Resolves once no pass is running (at once when none is). */
  idle(): Promise<void> {
    return this.current ?? Promise.resolve();
  }

  /** A pass now, or the one already running. */
  run(): Promise<void> {
    if (this.current) return this.current;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = this.pass()
      .then(
        () => {
          this.failures = 0;
        },
        (e) => {
          this.failures++;
          console.error(`[${this.opts.label}] ${this.opts.about()}: ${(e as Error).message}`);
        },
      )
      .finally(() => {
        this.current = null;
        if (!this.stopped) this.opts.settled?.();
      });
    return this.current;
  }

  /** No more passes from the timer. One running finishes; run() still works, for a last pass. */
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
