/**
 * Server-handler unit tests for the dev-indicator wiring in
 * `web/src/hooks.server.ts`: the options passed to resolve() carry exactly
 * what `devPageTransform()` returns — the transform function in dev mode,
 * undefined in production — built fresh once per request. The transform's own
 * behaviour (env gating, attr stamping, DEV title, favicons) is covered by
 * the bun suite in src/__tests__/dev-git-info.test.ts.
 *
 * Mirrors hooks-server-onboarding-redirect.server.test.ts's mock preamble.
 */

process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(),
  getUserById: vi.fn(),
}));
vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => {}),
}));
vi.mock("$server/startup/background-timers", () => ({
  startBackgroundTimers: vi.fn(async () => {}),
}));
vi.mock("$lib/server/security/bearer-auth", () => ({
  attachBearerAuth: vi.fn(async () => {}),
}));
vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async () => "hash"),
  lookupSessionByTokenHash: vi.fn(async () => ({
    session: { id: "sess-1", userId: "u-1" },
    viaPrevious: false,
  })),
  touchSession: vi.fn(async () => {}),
  rotateSessionToken: vi.fn(async () => null),
}));
vi.mock("$server/auth/jwt", () => ({
  verifyJWT: vi.fn(async () => ({
    id: "u-1",
    email: "u@test.com",
    name: "U",
    role: "member",
  })),
  getJwtSecret: vi.fn(async () => "secret"),
}));
vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(async () => undefined),
}));
vi.mock("$server/dev-git-info", () => ({
  devPageTransform: vi.fn(),
}));

import { getUserById, getUserCount } from "$server/db/queries/users";
import { devPageTransform } from "$server/dev-git-info";
const { handle } = await import("../hooks.server");

function makeAuthedEvent(path: string) {
  const cookies = {
    get: vi.fn((name: string) => (name === "ezcorp_session" ? "valid-jwt-token" : undefined)),
    set: vi.fn(),
    delete: vi.fn(),
  };
  return {
    request: new Request(`http://localhost${path}`, {
      method: "GET",
      headers: { cookie: "ezcorp_session=valid-jwt-token" },
    }),
    url: new URL(`http://localhost${path}`),
    cookies,
    locals: {},
    getClientAddress: () => "127.0.0.1",
    route: { id: path },
    params: {},
    setHeaders: vi.fn(),
    fetch: vi.fn(),
    isDataRequest: false,
    isSubRequest: false,
  } as any;
}

const ONBOARDED = {
  id: "u-1",
  email: "u@test.com",
  name: "U",
  role: "member" as const,
  status: "active" as const,
  passwordHash: "x",
  createdAt: new Date(),
  onboardedAt: new Date(),
};

describe("hooks.server.ts — dev indicator transformPageChunk wiring", () => {
  beforeEach(() => {
    vi.mocked(devPageTransform).mockReset();
    vi.mocked(getUserById).mockReset();
    // Onboarded authed user → handle falls through to resolve().
    vi.mocked(getUserById).mockResolvedValue(ONBOARDED as any);
    vi.mocked(getUserCount).mockResolvedValue(1);
  });

  test("dev mode → resolve() receives devPageTransform()'s transform, built per request", async () => {
    const marker = ({ html }: { html: string }) => `transformed:${html}`;
    vi.mocked(devPageTransform).mockReturnValue(marker);

    let captured: any;
    const resolve = vi.fn(async (_event: any, opts: any) => {
      captured = opts;
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    await handle({ event: makeAuthedEvent("/projects/abc"), resolve } as any);

    expect(resolve).toHaveBeenCalledTimes(1);
    // The wiring passes the built transform through untouched…
    expect(captured.transformPageChunk).toBe(marker);
    // …and builds it exactly once per request (fresh git info per reload).
    expect(devPageTransform).toHaveBeenCalledTimes(1);
  });

  test("production → devPageTransform() is undefined and so is the resolve option", async () => {
    vi.mocked(devPageTransform).mockReturnValue(undefined);

    let captured: any;
    const resolve = vi.fn(async (_event: any, opts: any) => {
      captured = opts;
      return new Response("ok", { status: 200 });
    });

    await handle({ event: makeAuthedEvent("/projects/abc"), resolve } as any);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(captured.transformPageChunk).toBeUndefined();
  });
});
