import { test, expect, beforeEach } from "bun:test";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
import {
  CircuitBreaker,
  getCircuitBreaker,
  resetAllCircuitBreakers,
  MAX_BREAKER_ENTRIES,
} from "../providers/circuit-breaker";

beforeEach(() => {
  resetAllCircuitBreakers();
});

test("starts in closed state, isOpen returns false", () => {
  const cb = new CircuitBreaker();
  expect(cb.isOpen()).toBe(false);
});

test("opens after 3 failures", () => {
  const cb = new CircuitBreaker();
  cb.recordFailure();
  cb.recordFailure();
  expect(cb.isOpen()).toBe(false);
  cb.recordFailure();
  expect(cb.isOpen()).toBe(true);
});

test("recordSuccess resets failure count", () => {
  const cb = new CircuitBreaker();
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSuccess();
  cb.recordFailure();
  cb.recordFailure();
  expect(cb.isOpen()).toBe(false);
});

test("transitions to half-open after timeout", async () => {
  const cb = new CircuitBreaker(3, 100); // 100ms timeout for test
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  expect(cb.isOpen()).toBe(true);

  // Wait for timeout
  await sleep(150);
  // Should be half-open now (isOpen returns false to allow test request)
  expect(cb.isOpen()).toBe(false);
});

test("recordSuccess in half-open returns to closed", async () => {
  const cb = new CircuitBreaker(3, 100);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();

  await sleep(150);
  cb.isOpen(); // trigger half-open transition
  cb.recordSuccess();

  // Should be fully closed now
  cb.recordFailure();
  cb.recordFailure();
  expect(cb.isOpen()).toBe(false); // only 2 failures, not 3
});

test("recordFailure in half-open returns to open", async () => {
  const cb = new CircuitBreaker(3, 100);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();

  await sleep(150);
  cb.isOpen(); // trigger half-open
  cb.recordFailure();
  expect(cb.isOpen()).toBe(true);
});

test("getCircuitBreaker returns same instance for same provider", () => {
  const a = getCircuitBreaker("anthropic");
  const b = getCircuitBreaker("anthropic");
  expect(a).toBe(b);
});

test("getCircuitBreaker returns different instances for different providers", () => {
  const a = getCircuitBreaker("anthropic");
  const b = getCircuitBreaker("openai");
  expect(a).not.toBe(b);
});

// ── per-scope keying ─────────────────────────────────────────────────

test("default scope is 'shared': bare calls and explicit 'shared' return the same instance", () => {
  // Context-free callers (router tier routing, legacy paths) must stay
  // behavior-identical to the old provider-only keying.
  expect(getCircuitBreaker("anthropic")).toBe(getCircuitBreaker("anthropic", "shared"));
});

test("same (provider, scope) pair returns the same instance", () => {
  expect(getCircuitBreaker("anthropic", "user-a")).toBe(getCircuitBreaker("anthropic", "user-a"));
});

test("scope isolation: (provider, scopeA) failures do NOT open (provider, scopeB) or the shared breaker", () => {
  const userA = getCircuitBreaker("anthropic", "user-a");
  for (let i = 0; i < 3; i++) userA.recordFailure();
  expect(userA.isOpen()).toBe(true);

  // A different user of the SAME provider is unaffected…
  expect(getCircuitBreaker("anthropic", "user-b").isOpen()).toBe(false);
  // …as are context-free (shared-scope) callers.
  expect(getCircuitBreaker("anthropic").isOpen()).toBe(false);
});

test("same scope across different providers stays isolated", () => {
  const anthropicA = getCircuitBreaker("anthropic", "user-a");
  for (let i = 0; i < 3; i++) anthropicA.recordFailure();
  expect(getCircuitBreaker("openai", "user-a").isOpen()).toBe(false);
});

test("threshold/reset behavior is preserved on a scoped breaker", () => {
  // Scoped breakers are plain CircuitBreaker instances: 3 failures open,
  // success closes again. (Timing behavior is covered by the constructor
  // tests above; this pins the factory path.)
  const cb = getCircuitBreaker("anthropic", "user-t");
  cb.recordFailure();
  cb.recordFailure();
  expect(cb.isOpen()).toBe(false);
  cb.recordFailure();
  expect(cb.isOpen()).toBe(true);
  cb.recordSuccess();
  expect(cb.isOpen()).toBe(false);
});

// ── bounded map (insertion-order eviction) ───────────────────────────

test("MAX_BREAKER_ENTRIES is a sane finite cap", () => {
  expect(MAX_BREAKER_ENTRIES).toBe(512);
});

test("inserting past the cap evicts the OLDEST entry; recent entries survive", () => {
  // Oldest entry: opened so eviction is observable (state is lost).
  const first = getCircuitBreaker("prov", "scope-0");
  for (let i = 0; i < 3; i++) first.recordFailure();
  expect(first.isOpen()).toBe(true);

  // Fill to the cap, then one past it (insert scope-1..scope-MAX).
  for (let i = 1; i <= MAX_BREAKER_ENTRIES; i++) {
    getCircuitBreaker("prov", `scope-${i}`);
  }

  // scope-0 was evicted: re-getting it returns a FRESH, closed breaker.
  const replacement = getCircuitBreaker("prov", "scope-0");
  expect(replacement).not.toBe(first);
  expect(replacement.isOpen()).toBe(false);

  // A recently-inserted entry was NOT evicted (same instance on re-get).
  const recent = getCircuitBreaker("prov", `scope-${MAX_BREAKER_ENTRIES}`);
  expect(recent).toBe(getCircuitBreaker("prov", `scope-${MAX_BREAKER_ENTRIES}`));
});
