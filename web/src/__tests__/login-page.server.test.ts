/**
 * Unit tests for /(auth)/login/+page.server.ts load().
 *
 * Covers the returnTo round-trip and the existing redirect-to-setup /
 * already-logged-in fast-paths:
 *   - count === 0 → 302 /setup (returnTo ignored — first-run setup wins)
 *   - No cookie → returns { returnTo } so the client can read it
 *   - Valid JWT + session row → 302 to returnTo (or "/" when missing)
 *   - Stale JWT (verifyJWT null) → returns { returnTo }, no redirect
 *   - Valid JWT + missing session row → clears cookie, returns { returnTo }
 *   - Malicious returnTo (//evil.com, https://..., backslash, no slash) → "/"
 *
 * Mirrors the mock layout of onboarding-page.server.test.ts.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(),
}));
vi.mock("$server/auth/jwt", () => ({
  verifyJWT: vi.fn(),
  getJwtSecret: vi.fn(async () => "secret"),
}));
vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async (t: string) => `hash:${t}`),
  getSessionByTokenHash: vi.fn(),
}));

const { getUserCount } = await import("$server/db/queries/users");
const { verifyJWT } = await import("$server/auth/jwt");
const { getSessionByTokenHash } = await import("$server/db/queries/sessions");
const { load } = await import("../routes/(auth)/login/+page.server");

function isRedirect(err: unknown): err is { status: number; location: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as any).status === "number" &&
    typeof (err as any).location === "string"
  );
}

function makeEvent(opts: { returnTo?: string; cookie?: string } = {}) {
  const search = opts.returnTo
    ? `?returnTo=${encodeURIComponent(opts.returnTo)}`
    : "";
  const cookies = {
    get: vi.fn((name: string) =>
      opts.cookie && name === "ezcorp_session" ? opts.cookie : undefined,
    ),
    set: vi.fn(),
    delete: vi.fn(),
  };
  return {
    url: new URL(`http://localhost/login${search}`),
    cookies,
    locals: {},
    request: new Request(`http://localhost/login${search}`),
    params: {},
    route: { id: "/(auth)/login" },
    fetch: vi.fn(),
    setHeaders: vi.fn(),
    isDataRequest: false,
    isSubRequest: false,
  } as any;
}

async function captureRedirect(event: any): Promise<{ status: number; location: string }> {
  let thrown: unknown;
  try {
    await load(event);
  } catch (err) {
    thrown = err;
  }
  if (!isRedirect(thrown)) {
    throw new Error(`expected redirect, got: ${String(thrown)}`);
  }
  return thrown;
}

describe("/(auth)/login/+page.server load() — returnTo handling", () => {
  beforeEach(() => {
    vi.mocked(getUserCount).mockReset();
    vi.mocked(verifyJWT).mockReset();
    vi.mocked(getSessionByTokenHash).mockReset();
    // Default: at least one user exists; no auth cookie so the function
    // returns { returnTo } rather than redirecting.
    vi.mocked(getUserCount).mockResolvedValue(1);
  });

  // ── No-auth: load returns returnTo for the client ────────────────

  describe("no auth cookie → returns { returnTo }", () => {
    test("no returnTo param → returnTo defaults to '/'", async () => {
      const data = (await load(makeEvent())) as { returnTo: string };
      expect(data).toEqual({ returnTo: "/" });
    });

    test("legitimate same-origin path passes through", async () => {
      const data = (await load(makeEvent({ returnTo: "/chat/xyz" }))) as {
        returnTo: string;
      };
      expect(data.returnTo).toBe("/chat/xyz");
    });

    test("path with query string preserved", async () => {
      const data = (await load(
        makeEvent({ returnTo: "/projects/abc?tab=files" }),
      )) as { returnTo: string };
      expect(data.returnTo).toBe("/projects/abc?tab=files");
    });

    test("protocol-relative URL collapses to '/'", async () => {
      const data = (await load(makeEvent({ returnTo: "//evil.com/x" }))) as {
        returnTo: string;
      };
      expect(data.returnTo).toBe("/");
    });

    test("absolute URL collapses to '/'", async () => {
      const data = (await load(
        makeEvent({ returnTo: "https://evil.com" }),
      )) as { returnTo: string };
      expect(data.returnTo).toBe("/");
    });

    test("backslash-prefixed path collapses to '/'", async () => {
      const data = (await load(makeEvent({ returnTo: "/\\evil.com" }))) as {
        returnTo: string;
      };
      expect(data.returnTo).toBe("/");
    });

    test("path without leading slash collapses to '/'", async () => {
      const data = (await load(makeEvent({ returnTo: "chat/abc" }))) as {
        returnTo: string;
      };
      expect(data.returnTo).toBe("/");
    });
  });

  // ── First-run setup gate (count=0) ───────────────────────────────

  describe("first-run setup (no users)", () => {
    test("count=0 → 302 /setup, ignores returnTo", async () => {
      vi.mocked(getUserCount).mockResolvedValue(0);
      const r = await captureRedirect(makeEvent({ returnTo: "/projects/abc" }));
      expect(r.status).toBe(302);
      expect(r.location).toBe("/setup");
      // verifyJWT must NOT be consulted — no users means no sessions.
      expect(vi.mocked(verifyJWT)).not.toHaveBeenCalled();
    });
  });

  // ── Already-logged-in fast-path ──────────────────────────────────

  describe("already-logged-in fast-path", () => {
    beforeEach(() => {
      vi.mocked(verifyJWT).mockResolvedValue({
        id: "u-1",
        email: "u@test.com",
        name: "U",
        role: "member",
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 3600,
      } as any);
      vi.mocked(getSessionByTokenHash).mockResolvedValue({
        id: "sess-1",
        userId: "u-1",
      } as any);
    });

    test("valid session + returnTo → 302 to returnTo", async () => {
      const r = await captureRedirect(
        makeEvent({ cookie: "valid-jwt", returnTo: "/projects/abc" }),
      );
      expect(r.status).toBe(302);
      expect(r.location).toBe("/projects/abc");
    });

    test("valid session + no returnTo → 302 to /", async () => {
      const r = await captureRedirect(makeEvent({ cookie: "valid-jwt" }));
      expect(r.location).toBe("/");
    });

    test("valid session + malicious returnTo → 302 to / (sanitized)", async () => {
      // sec: even an authenticated user shouldn't be steerable to evil.com
      const r = await captureRedirect(
        makeEvent({ cookie: "valid-jwt", returnTo: "//evil.com" }),
      );
      expect(r.location).toBe("/");
    });

    test("DB unavailable on session lookup → JWT-only fallback still redirects", async () => {
      vi.mocked(getSessionByTokenHash).mockRejectedValue(new Error("DB down"));
      const r = await captureRedirect(
        makeEvent({ cookie: "valid-jwt", returnTo: "/admin" }),
      );
      expect(r.location).toBe("/admin");
    });
  });

  // ── Stale-token edge cases ──────────────────────────────────────

  describe("stale / revoked tokens", () => {
    test("verifyJWT returns null (stale token) + returnTo → returns { returnTo }, no redirect", async () => {
      vi.mocked(verifyJWT).mockResolvedValue(null);
      const data = (await load(
        makeEvent({ cookie: "stale-jwt", returnTo: "/chat/abc" }),
      )) as { returnTo: string };
      expect(data.returnTo).toBe("/chat/abc");
    });

    test("valid JWT + missing session row → clears cookie and returns { returnTo }", async () => {
      vi.mocked(verifyJWT).mockResolvedValue({
        id: "u-1",
        email: "u@test.com",
        name: "U",
        role: "member",
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 3600,
      } as any);
      vi.mocked(getSessionByTokenHash).mockResolvedValue(null);

      const event = makeEvent({ cookie: "valid-but-revoked", returnTo: "/admin" });
      const data = (await load(event)) as { returnTo: string };
      expect(data.returnTo).toBe("/admin");
      // Cookie should have been cleared so the next nav starts clean.
      expect(event.cookies.delete).toHaveBeenCalledWith("ezcorp_session", { path: "/" });
    });
  });
});
