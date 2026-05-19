/**
 * Server-handler unit tests for /api/auth/logout/+server.ts.
 *
 * Covers the cookie-clear path (no session token) and the
 * best-effort revocation path (token present; mocks the
 * session-query boundary so the test stays off PGlite).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async (t: string) => `hash:${t}`),
  getSessionByTokenHash: vi.fn(),
  revokeSession: vi.fn(async () => true),
}));

const { hashToken, getSessionByTokenHash, revokeSession } = await import(
  "$server/db/queries/sessions"
);
const { POST } = await import("../routes/api/auth/logout/+server");

type CookieStore = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function makeCookies(initial?: string): CookieStore {
  return {
    get: vi.fn((name: string) =>
      name === "ezcorp_session" ? initial : undefined,
    ),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

function makeEvent(cookies: CookieStore) {
  return {
    url: new URL("http://localhost/api/auth/logout"),
    locals: {},
    cookies,
    request: new Request("http://localhost/api/auth/logout", { method: "POST" }),
  } as any;
}

describe("POST /api/auth/logout", () => {
  beforeEach(() => {
    vi.mocked(hashToken).mockClear();
    vi.mocked(getSessionByTokenHash).mockReset();
    vi.mocked(revokeSession).mockClear();
  });

  test("clears session cookie and returns success when no token present", async () => {
    const cookies = makeCookies(undefined);
    const res = await POST(makeEvent(cookies));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
    expect(cookies.set).toHaveBeenCalledWith(
      "ezcorp_session",
      "",
      expect.objectContaining({ path: "/", maxAge: 0 }),
    );
    expect(getSessionByTokenHash).not.toHaveBeenCalled();
  });

  test("revokes matching session and clears cookie when token present", async () => {
    vi.mocked(getSessionByTokenHash).mockResolvedValue({ id: "sess-1" } as any);
    const cookies = makeCookies("raw-token");
    const res = await POST(makeEvent(cookies));
    expect(res.status).toBe(200);
    expect(hashToken).toHaveBeenCalledWith("raw-token");
    expect(getSessionByTokenHash).toHaveBeenCalledWith("hash:raw-token");
    expect(revokeSession).toHaveBeenCalledWith("sess-1");
    expect(cookies.set).toHaveBeenCalled();
  });

  test("swallows lookup errors and still clears cookie", async () => {
    vi.mocked(getSessionByTokenHash).mockRejectedValue(new Error("boom"));
    const cookies = makeCookies("raw-token");
    const res = await POST(makeEvent(cookies));
    expect(res.status).toBe(200);
    expect(cookies.set).toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
  });

  test("returns success when token hashes to a missing session", async () => {
    vi.mocked(getSessionByTokenHash).mockResolvedValue(null as any);
    const cookies = makeCookies("raw-token");
    const res = await POST(makeEvent(cookies));
    expect(res.status).toBe(200);
    expect(revokeSession).not.toHaveBeenCalled();
    expect(cookies.set).toHaveBeenCalled();
  });
});
