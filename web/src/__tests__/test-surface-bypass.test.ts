/**
 * Unit tests for the loopback auth-bypass used by hooks.server.ts to let
 * pi-ai's internal mock-LLM call through. Security-critical: it must reject
 * non-loopback peers, proxied requests, the /script sub-path, and anything
 * when the test surface is off.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isLoopbackTestBypass } from "$lib/server/test-surface";

const COMPLETIONS = "/api/__test/mock-llm/v1/chat/completions";

const savedE2E = process.env.PI_E2E_REAL;
const savedNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.PI_E2E_REAL = "1";
  delete process.env.NODE_ENV; // non-production
});
afterEach(() => {
  if (savedE2E === undefined) delete process.env.PI_E2E_REAL; else process.env.PI_E2E_REAL = savedE2E;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
});

describe("isLoopbackTestBypass", () => {
  test("loopback + flag + completions path → bypass", () => {
    expect(isLoopbackTestBypass(COMPLETIONS, "127.0.0.1", false)).toBe(true);
    expect(isLoopbackTestBypass(COMPLETIONS, "::1", false)).toBe(true);
  });

  test("the /script seed sub-path is NOT bypassed (needs real auth)", () => {
    expect(isLoopbackTestBypass("/api/__test/mock-llm/script", "127.0.0.1", false)).toBe(false);
  });

  test("non-loopback peer → no bypass", () => {
    expect(isLoopbackTestBypass(COMPLETIONS, "10.0.0.5", false)).toBe(false);
    expect(isLoopbackTestBypass(COMPLETIONS, undefined, false)).toBe(false);
  });

  test("proxy-forwarding headers present → no bypass (peer untrustworthy)", () => {
    expect(isLoopbackTestBypass(COMPLETIONS, "127.0.0.1", true)).toBe(false);
  });

  test("test surface disabled → no bypass even on loopback", () => {
    delete process.env.PI_E2E_REAL;
    expect(isLoopbackTestBypass(COMPLETIONS, "127.0.0.1", false)).toBe(false);
  });

  test("production → no bypass", () => {
    process.env.NODE_ENV = "production";
    expect(isLoopbackTestBypass(COMPLETIONS, "127.0.0.1", false)).toBe(false);
  });

  test("unrelated path → no bypass", () => {
    expect(isLoopbackTestBypass("/api/conversations", "127.0.0.1", false)).toBe(false);
  });
});
