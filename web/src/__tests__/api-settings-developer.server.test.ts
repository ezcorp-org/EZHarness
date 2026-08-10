/**
 * Server-handler unit tests for /api/settings/developer/+server.ts.
 *
 * Covers:
 *  - requireScope gates (read for GET, admin for POST/DELETE).
 *  - requireAuth 401 for missing locals.user.
 *  - Happy paths for POST (token generation) and GET (hasToken flag) and
 *    DELETE (204) with settings queries mocked at the module boundary.
 *  - Hash-at-rest storage: POST persists only a SHA-256 tokenHash (never the
 *    raw token); GET treats legacy plaintext rows as "no token".
 */

import crypto from "node:crypto";
import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectThrownResponse as expectThrown } from "./helpers/server-route-test-utils";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(),
  upsertSetting: vi.fn(async () => undefined),
  deleteSetting: vi.fn(async () => true),
}));

const { getSetting, upsertSetting, deleteSetting } = await import(
  "$server/db/queries/settings"
);
const { GET, POST, DELETE } = await import(
  "../routes/api/settings/developer/+server"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  method?: "GET" | "POST" | "DELETE";
}) {
  const method = opts.method ?? "GET";
  return makeRequestEvent("http://localhost/api/settings/developer", {
    locals: opts.locals ?? {},
    request: { method },
  });
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

describe("GET /api/settings/developer", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockReset();
  });

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => GET(makeEvent({})), 401);
  });

  test("rejects 403 when API-key lacks 'read' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("read");
  });

  test("returns { hasToken: false } when no token stored", async () => {
    vi.mocked(getSetting).mockResolvedValue(undefined as any);
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasToken?: boolean };
    expect(body.hasToken).toBe(false);
  });

  test("returns { hasToken: true } when a hashed token is stored", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      tokenHash: "a".repeat(64),
      createdAt: Date.now(),
    } as any);
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasToken?: boolean };
    expect(body.hasToken).toBe(true);
  });

  test("returns { hasToken: false } for a legacy plaintext row (forces re-issue)", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      token: "abc",
      createdAt: Date.now(),
    } as any);
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasToken?: boolean };
    expect(body.hasToken).toBe(false);
  });
});

describe("POST /api/settings/developer", () => {
  beforeEach(() => {
    vi.mocked(upsertSetting).mockClear();
  });

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => POST(makeEvent({ method: "POST" })), 401);
  });

  test("rejects 403 when API-key lacks 'admin' scope", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { ...authedUser, apiKeyScopes: ["read"] },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("admin");
  });

  test("returns 200 with a 64-char hex token and writes only its hash to settings", async () => {
    const res = await POST(makeEvent({ method: "POST", locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string };
    expect(typeof body.token).toBe("string");
    expect(body.token!).toMatch(/^[0-9a-f]{64}$/);
    const expectedHash = crypto
      .createHash("sha256")
      .update(body.token!)
      .digest("hex");
    expect(upsertSetting).toHaveBeenCalledWith(
      "publish:token:u1",
      expect.objectContaining({ tokenHash: expectedHash }),
    );
    // The raw token must never be stored at rest.
    const stored = vi.mocked(upsertSetting).mock.calls[0]![1] as Record<string, unknown>;
    expect(stored.token).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(body.token!);
  });
});

describe("DELETE /api/settings/developer", () => {
  beforeEach(() => {
    vi.mocked(deleteSetting).mockClear();
  });

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => DELETE(makeEvent({ method: "DELETE" })), 401);
  });

  test("rejects 403 when API-key lacks 'admin' scope", async () => {
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: { ...authedUser, apiKeyScopes: ["read"] },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("returns 204 on successful revoke", async () => {
    const res = await DELETE(
      makeEvent({ method: "DELETE", locals: authedUser }),
    );
    expect(res.status).toBe(204);
    expect(deleteSetting).toHaveBeenCalledWith("publish:token:u1");
  });
});
