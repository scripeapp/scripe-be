/**
 * In-memory counter for guessable secrets (pairing codes, till PINs): after
 * `limit` failures within `windowMs` a key is locked until the window ends.
 * Per process — enough to make guessing impractical on one server; a shared
 * store would be needed to extend it across instances.
 */
export class AttemptLimiter {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Milliseconds until the key may try again, or 0 when it isn't locked. */
  lockedFor(key: string, now = Date.now()): number {
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) return 0;
    return entry.count >= this.limit ? entry.resetAt - now : 0;
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}
