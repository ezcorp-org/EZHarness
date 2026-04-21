import { test, expect, beforeEach } from "bun:test";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
import {
  CircuitBreaker,
  getCircuitBreaker,
  resetAllCircuitBreakers,
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
