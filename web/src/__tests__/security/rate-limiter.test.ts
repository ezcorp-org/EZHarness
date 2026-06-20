import { test, expect, beforeEach } from "bun:test";
import { RateLimiter } from "../../lib/server/security/rate-limiter";

let limiter: RateLimiter;

beforeEach(() => {
  limiter = new RateLimiter(3, 1000); // 3 requests per 1s window
});

test("allows requests under limit", () => {
  const r1 = limiter.check("user1");
  const r2 = limiter.check("user1");
  const r3 = limiter.check("user1");
  expect(r1.allowed).toBe(true);
  expect(r2.allowed).toBe(true);
  expect(r3.allowed).toBe(true);
});

test("denies requests at limit with retryAfter", () => {
  limiter.check("user1");
  limiter.check("user1");
  limiter.check("user1");
  const r4 = limiter.check("user1");
  expect(r4.allowed).toBe(false);
  expect(r4.retryAfter).toBeGreaterThan(0);
});

test("resets after window expires", async () => {
  const fast = new RateLimiter(1, 50);
  fast.check("k");
  expect(fast.check("k").allowed).toBe(false);
  await new Promise((r) => setTimeout(r, 60));
  expect(fast.check("k").allowed).toBe(true);
});

test("supports custom limit override per check call", () => {
  const r1 = limiter.check("user2", 1);
  expect(r1.allowed).toBe(true);
  const r2 = limiter.check("user2", 1);
  expect(r2.allowed).toBe(false);
});

test("cleanup removes expired entries", async () => {
  const fast = new RateLimiter(5, 50);
  fast.check("a");
  fast.check("b");
  await new Promise((r) => setTimeout(r, 60));
  fast.cleanup();
  // After cleanup, counters should be gone so new requests allowed
  expect(fast.check("a").allowed).toBe(true);
  expect(fast.check("b").allowed).toBe(true);
});

test("tracks separate keys independently", () => {
  limiter.check("x");
  limiter.check("x");
  limiter.check("x");
  expect(limiter.check("x").allowed).toBe(false);
  expect(limiter.check("y").allowed).toBe(true);
});

test("firstBlock is true on the transition to blocked, false after", () => {
  // Burn through the limit (3 allowed, 4th is blocked).
  expect(limiter.check("z").allowed).toBe(true);
  expect(limiter.check("z").allowed).toBe(true);
  expect(limiter.check("z").allowed).toBe(true);

  const first = limiter.check("z");
  expect(first.allowed).toBe(false);
  expect(first.firstBlock).toBe(true);

  // Subsequent blocked calls in the same window do NOT re-fire firstBlock.
  const second = limiter.check("z");
  expect(second.allowed).toBe(false);
  expect(second.firstBlock).toBe(false);

  const third = limiter.check("z");
  expect(third.allowed).toBe(false);
  expect(third.firstBlock).toBe(false);
});

test("firstBlock fires again after the window rolls over", async () => {
  const fast = new RateLimiter(1, 50);
  expect(fast.check("k").allowed).toBe(true);
  const blocked = fast.check("k");
  expect(blocked.allowed).toBe(false);
  expect(blocked.firstBlock).toBe(true);
  expect(fast.check("k").firstBlock).toBe(false);

  await new Promise((r) => setTimeout(r, 60));
  // Window rolled over → first call is allowed (resets entry); next
  // blocked call should report firstBlock=true again.
  expect(fast.check("k").allowed).toBe(true);
  const reblocked = fast.check("k");
  expect(reblocked.allowed).toBe(false);
  expect(reblocked.firstBlock).toBe(true);
});

test("firstBlock is omitted (undefined) on allowed responses", () => {
  const r = limiter.check("ok-key");
  expect(r.allowed).toBe(true);
  expect(r.firstBlock).toBeUndefined();
});

// ── peek() — read-only limit probe ───────────────────────────────────

test("peek does not mutate the counter (no token consumed)", () => {
  // peek() any number of times on a fresh key — the key stays at zero, so a
  // later real check() still gets the full budget (3 allowed before block).
  for (let i = 0; i < 10; i++) {
    expect(limiter.peek("pk").allowed).toBe(true);
  }
  expect(limiter.check("pk").allowed).toBe(true);
  expect(limiter.check("pk").allowed).toBe(true);
  expect(limiter.check("pk").allowed).toBe(true);
  expect(limiter.check("pk").allowed).toBe(false);
});

test("peek reports allowed while under the limit and blocked once at it", () => {
  expect(limiter.peek("pk2").allowed).toBe(true); // 0 used
  limiter.check("pk2"); // 1
  limiter.check("pk2"); // 2
  expect(limiter.peek("pk2").allowed).toBe(true); // 2 < 3
  limiter.check("pk2"); // 3 (at limit)
  const blocked = limiter.peek("pk2");
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfter).toBeGreaterThan(0);
});

test("peek agrees with the next check() — they never disagree", () => {
  // Drive a key to exactly the limit, then assert peek() predicts what
  // check() does at every boundary step.
  const small = new RateLimiter(2, 1000);
  expect(small.peek("k").allowed).toBe(small.check("k").allowed); // both true (0→1)
  expect(small.peek("k").allowed).toBe(small.check("k").allowed); // both true (1→2)
  // Now at limit: peek says blocked, and check() also blocks.
  expect(small.peek("k").allowed).toBe(false);
  expect(small.check("k").allowed).toBe(false);
});

test("peek resets after the window rolls over", async () => {
  const fast = new RateLimiter(1, 50);
  fast.check("k"); // at limit
  expect(fast.peek("k").allowed).toBe(false);
  await new Promise((r) => setTimeout(r, 60));
  // Window expired — peek sees a stale window and reports allowed again,
  // WITHOUT resurrecting the entry (still read-only).
  expect(fast.peek("k").allowed).toBe(true);
});
