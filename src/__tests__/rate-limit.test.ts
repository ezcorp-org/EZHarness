// Direct unit tests for src/extensions/rate-limit.ts.
//
// The helper's contract is already covered indirectly through the three
// handlers that use it (storage, agent-configs, emit-task-event). These
// tests lock the contract in place so future handlers can rely on it
// without having to reverse-engineer the semantics from the handler
// call sites.

import { test, expect, describe } from "bun:test";
import { createRateLimiter } from "../extensions/rate-limit";

describe("createRateLimiter — bucket isolation", () => {
  test("distinct ids have independent buckets", () => {
    const consume = createRateLimiter(5);
    for (let i = 0; i < 5; i++) expect(consume("a", 1)).toBe(true);
    expect(consume("a", 1)).toBe(false);
    // `b` is untouched — its bucket starts full.
    for (let i = 0; i < 5; i++) expect(consume("b", 1)).toBe(true);
  });

  test("distinct limiter instances do not share state", () => {
    const first = createRateLimiter(2);
    const second = createRateLimiter(2);
    expect(first("x", 2)).toBe(true);
    expect(first("x", 1)).toBe(false);
    // Second limiter sees a full bucket for the same id.
    expect(second("x", 2)).toBe(true);
  });
});

describe("createRateLimiter — consumption + refill", () => {
  test("allows exactly maxOpsPerSecond in a tight loop, then refuses", () => {
    const consume = createRateLimiter(10);
    let accepted = 0;
    for (let i = 0; i < 20; i++) {
      if (consume("id", 1)) accepted++;
    }
    // A tight loop cannot refill meaningfully, so ~10 should succeed.
    expect(accepted).toBeGreaterThanOrEqual(10);
    expect(accepted).toBeLessThanOrEqual(11);
  });

  test("count > available returns false without consuming", () => {
    const consume = createRateLimiter(3);
    expect(consume("id", 5)).toBe(false);
    // Budget intact: all 3 still available.
    expect(consume("id", 3)).toBe(true);
  });

  test("count === tokens exactly drains the bucket", () => {
    const consume = createRateLimiter(3);
    expect(consume("id", 3)).toBe(true);
    expect(consume("id", 1)).toBe(false);
  });

  test("bucket refills linearly with elapsed time (wall clock)", async () => {
    const consume = createRateLimiter(10);
    for (let i = 0; i < 10; i++) consume("id", 1);
    expect(consume("id", 1)).toBe(false);
    // 100ms elapsed → +1 token (10 per second). Sleep a bit more for
    // clock slop, so at least one token is definitely available.
    await new Promise((r) => setTimeout(r, 150));
    expect(consume("id", 1)).toBe(true);
  });

  test("refill caps at maxOpsPerSecond regardless of elapsed time", async () => {
    const consume = createRateLimiter(5);
    // Drain.
    for (let i = 0; i < 5; i++) consume("id", 1);
    // Wait long enough that unbounded refill would overflow the cap.
    await new Promise((r) => setTimeout(r, 2000));
    // Only 5 should be available (cap at max), not 10+.
    let accepted = 0;
    for (let i = 0; i < 10; i++) {
      if (consume("id", 1)) accepted++;
    }
    expect(accepted).toBeGreaterThanOrEqual(5);
    expect(accepted).toBeLessThanOrEqual(6);
  });
});

describe("createRateLimiter — edge cases", () => {
  test("first call for a new id creates a full bucket", () => {
    const consume = createRateLimiter(7);
    expect(consume("fresh", 7)).toBe(true);
    expect(consume("fresh", 1)).toBe(false);
  });

  test("zero-count consume succeeds and does not drain", () => {
    const consume = createRateLimiter(3);
    expect(consume("id", 0)).toBe(true);
    expect(consume("id", 3)).toBe(true);
  });

  test("maxOpsPerSecond=1 enforces strict one-per-second", () => {
    const consume = createRateLimiter(1);
    expect(consume("id", 1)).toBe(true);
    expect(consume("id", 1)).toBe(false);
  });
});
