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
