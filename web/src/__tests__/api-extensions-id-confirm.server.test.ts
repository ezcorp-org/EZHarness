/**
 * Server-handler unit tests for /api/extensions/[id]/confirm (+server.ts).
 *
 * Runtime shell/filesystem permission confirmation gate. Covers auth gate,
 * 404 when extension is unknown, and both validation gates for
 * operationType + action. Happy path: action === 'always_allow' writes
 * a sensitive-allow toggle.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectDenied } from "./fixtures/expect-denied";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/extensions", () => ({
  getExtension: vi.fn(),
}));

vi.mock("$server/extensions/permissions", () => ({
  setSensitiveAlwaysAllow: vi.fn(async () => undefined),
}));

const { getExtension } = await import("$server/db/queries/extensions");
const { setSensitiveAlwaysAllow } = await import(
  "$server/extensions/permissions"
);
const { POST } = await import(
  "../routes/api/extensions/[id]/confirm/+server.ts"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const id = opts.id ?? "ext-1";
  return makeRequestEvent(`http://localhost/api/extensions/${id}/confirm`, {
    locals: opts.locals ?? {},
    params: { id },
    request: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body ?? {}),
    },
  });
}

const user = { id: "u1", email: "u@x", name: "u", role: "admin" };
const nonAdminUser = { id: "u2", email: "n@x", name: "n", role: "user" };

describe("POST /api/extensions/[id]/confirm", () => {
  beforeEach(() => {
    vi.mocked(getExtension).mockReset();
    vi.mocked(setSensitiveAlwaysAllow).mockReset();
  });

  // 403, not 401: this route's gate is now the role-only `requireAdmin`,
  // which RETURNS its denial (requireRole THREW one, so the caller actually
  // got a 500). requireAdmin answers "not an admin principal" uniformly — a
  // missing principal is not an admin either. Unreachable in production
  // regardless: hooks.server.ts 401s unauthenticated /api/* before the handler.
  test("unauthenticated request RETURNS 403 (not thrown → no 500)", async () => {
    const res = await expectDenied(() => POST(makeEvent({ locals: {} })), 403);
    expect(res.status).toBe(403);
  });

  test("non-admin user RETURNS 403 (not thrown → no 500)", async () => {
    const res = await expectDenied(() => POST(
            makeEvent({
              locals: { user: nonAdminUser },
              body: { operationType: "shell", action: "allow_once" },
            }),
          ), 403);
    expect(res.status).toBe(403);
    const body = (await res!.json()) as { error?: string };
    // requireAdmin's message; requireRole said "Insufficient permissions" but
    // THREW it, so a caller never actually read that body — it got the 500
    // "Internal Error" page instead.
    expect(body.error).toBe("Admin role required");
  });

  test("unknown extension returns 404", async () => {
    vi.mocked(getExtension).mockResolvedValue(null as any);
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { operationType: "shell", action: "allow_once" },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("rejects missing operationType with 400", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    const res = await POST(
      makeEvent({ locals: { user }, body: { action: "allow_once" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("operationType");
  });

  test("rejects invalid operationType with 400", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { operationType: "network", action: "allow_once" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("operationType");
  });

  test("rejects invalid action with 400", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { operationType: "shell", action: "bogus" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("action");
  });

  test("action=allow_once returns confirmed=true without always-allow write", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { operationType: "shell", action: "allow_once" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmed: boolean };
    expect(body.confirmed).toBe(true);
    expect(vi.mocked(setSensitiveAlwaysAllow)).not.toHaveBeenCalled();
  });

  test("action=always_allow writes sensitive allow flag", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { operationType: "filesystem", action: "always_allow" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmed: boolean };
    expect(body.confirmed).toBe(true);
    expect(vi.mocked(setSensitiveAlwaysAllow)).toHaveBeenCalledWith(
      "ext-1",
      "filesystem",
      true,
    );
  });

  test("action=deny returns confirmed=false", async () => {
    vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { operationType: "shell", action: "deny" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmed: boolean };
    expect(body.confirmed).toBe(false);
  });
});
