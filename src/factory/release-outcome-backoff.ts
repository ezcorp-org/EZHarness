/** The first wait before the release-outcome role tries a release again after a pass could not move it (W09e R5). */
export const FACTORY_RELEASE_OUTCOME_BACKOFF_BASE_MS = 5_000;

/** The longest wait between two tries of one release: each wait doubles up to this. */
export const FACTORY_RELEASE_OUTCOME_BACKOFF_CAP_MS = 5 * 60_000;

/**
 * The waits of the releases the release-outcome role could not move (W09e R5).
 *
 * The role passes every idle delay (a quarter second). A release waiting for consent, or a stopped release
 * whose provider has not answered, would otherwise be tried, and reported, on every pass. Each such release
 * waits instead: the base interval after its first try, doubled after each further one, never more than the
 * cap. A release that moves forgets its wait, so its next absence starts from the base again.
 *
 * The waits live in the role's process, keyed by release. A restart tries each release once more at once,
 * which is the same one line a new wait would report. A wait that ended a whole cap ago belongs to a release
 * the role no longer lists (settled elsewhere or gone), so it is forgotten.
 */
export class FactoryReleaseOutcomeBackoff {
  readonly #waits = new Map<string, { readonly tries: number; readonly untilMs: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True while this release waits; forgets every wait that ended a whole cap ago. */
  waiting(key: string): boolean {
    const now = this.now();
    for (const [other, wait] of this.#waits) if (wait.untilMs <= now - FACTORY_RELEASE_OUTCOME_BACKOFF_CAP_MS) this.#waits.delete(other);
    return (this.#waits.get(key)?.untilMs ?? 0) > now;
  }

  /** One more try could not move this release: it waits, and the wait is returned. */
  defer(key: string): number {
    const tries = (this.#waits.get(key)?.tries ?? 0) + 1;
    const waitMs = Math.min(FACTORY_RELEASE_OUTCOME_BACKOFF_BASE_MS * 2 ** (tries - 1), FACTORY_RELEASE_OUTCOME_BACKOFF_CAP_MS);
    this.#waits.set(key, { tries, untilMs: this.now() + waitMs });
    return waitMs;
  }

  /** The release moved: its next absence starts from the base again. */
  moved(key: string): void { this.#waits.delete(key); }

  /** How many releases wait now; for tests and an operator's view. */
  get size(): number { return this.#waits.size; }
}
