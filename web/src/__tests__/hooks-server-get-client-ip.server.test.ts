/**
 * Unit tests for `getClientIp(request, socketAddress)` in `src/hooks.server.ts`.
 *
 * sec-finding: when NO trusted proxy is configured (TRUSTED_PROXY_COUNT=0, the
 * default + a SUPPORTED direct-exposure topology per docs/harness-contract.md),
 * client headers (`x-real-ip`, `x-forwarded-for`) are attacker-controlled. The
 * old code keyed rate limits on `x-real-ip`, so a spammer minted a fresh bucket
 * per request by rotating it. The fix keys on the trustworthy SOCKET peer in
 * that case. This suite proves:
 *
 *   - TRUSTED_PROXY_COUNT=0 → returns the socket peer, IGNORING x-real-ip /
 *     x-forwarded-for entirely (no spoof-driven bucket churn).
 *   - TRUSTED_PROXY_COUNT=0 with no socket peer → "unknown" (fail-safe single
 *     shared bucket, never a header-derived one).
 *   - TRUSTED_PROXY_COUNT>0 → the existing XFF-depth peel logic is BYTE-FOR-BYTE
 *     unchanged (this is the configured-reverse-proxy contract we must not move).
 *
 * `getClientIp` reads TRUSTED_PROXY_COUNT from the env on every call, so we flip
 * it per-case without re-importing the module.
 */

// CRITICAL: set BEFORE the dynamic import of hooks.server — its top-level
// `await ensureInitialized()` / background-timers are gated on PI_SKIP_INIT.
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, vi, afterEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(async () => 1),
  getUserById: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => {}),
}));
vi.mock("$server/startup/background-timers", () => ({
  startBackgroundTimers: vi.fn(async () => {}),
}));

const { getClientIp } = await import("../hooks.server");

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/login", { method: "POST", headers });
}

const ORIGINAL = process.env.TRUSTED_PROXY_COUNT;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TRUSTED_PROXY_COUNT;
  else process.env.TRUSTED_PROXY_COUNT = ORIGINAL;
});

describe("getClientIp — no trusted proxy (default, direct exposure)", () => {
  test("keys on the SOCKET peer, ignoring a spoofable x-real-ip", () => {
    process.env.TRUSTED_PROXY_COUNT = "0";
    expect(getClientIp(req({ "x-real-ip": "10.0.0.99" }), "203.0.113.5")).toBe("203.0.113.5");
  });

  test("ignores a spoofable x-forwarded-for too", () => {
    process.env.TRUSTED_PROXY_COUNT = "0";
    expect(
      getClientIp(req({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }), "203.0.113.6"),
    ).toBe("203.0.113.6");
  });

  test("rotating x-real-ip from one socket peer yields the SAME key", () => {
    process.env.TRUSTED_PROXY_COUNT = "0";
    const a = getClientIp(req({ "x-real-ip": "10.0.0.1" }), "203.0.113.7");
    const b = getClientIp(req({ "x-real-ip": "10.0.0.2" }), "203.0.113.7");
    expect(a).toBe(b);
    expect(a).toBe("203.0.113.7");
  });

  test("no socket peer → 'unknown' (never a header-derived bucket)", () => {
    process.env.TRUSTED_PROXY_COUNT = "0";
    expect(getClientIp(req({ "x-real-ip": "10.0.0.1" }), undefined)).toBe("unknown");
  });

  test("unset TRUSTED_PROXY_COUNT defaults to 0 → socket peer", () => {
    delete process.env.TRUSTED_PROXY_COUNT;
    expect(getClientIp(req({ "x-real-ip": "10.0.0.1" }), "203.0.113.8")).toBe("203.0.113.8");
  });
});

describe("getClientIp — trusted proxy configured (UNCHANGED XFF-depth logic)", () => {
  test("count=1 peels the right-most hop (the trusted proxy's view of the client)", () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    // chain: client, proxyA → with 1 trusted hop the client is the last entry.
    expect(
      getClientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), "10.0.0.1"),
    ).toBe("2.2.2.2");
  });

  test("count=2 peels two hops", () => {
    process.env.TRUSTED_PROXY_COUNT = "2";
    expect(
      getClientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }), "10.0.0.1"),
    ).toBe("2.2.2.2");
  });

  test("count exceeding the chain length clamps to index 0", () => {
    process.env.TRUSTED_PROXY_COUNT = "5";
    expect(getClientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), "10.0.0.1")).toBe("1.1.1.1");
  });

  test("with a configured proxy but NO x-forwarded-for, falls back to x-real-ip (unchanged)", () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    expect(getClientIp(req({ "x-real-ip": "9.9.9.9" }), "10.0.0.1")).toBe("9.9.9.9");
  });

  test("with a configured proxy but neither header, falls back to 'unknown' (unchanged)", () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    expect(getClientIp(req({}), "10.0.0.1")).toBe("unknown");
  });

  test("trusted-proxy path NEVER consults the socket peer", () => {
    process.env.TRUSTED_PROXY_COUNT = "1";
    // Socket peer differs from every XFF entry; result still comes from XFF.
    expect(
      getClientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), "203.0.113.99"),
    ).toBe("2.2.2.2");
  });
});
