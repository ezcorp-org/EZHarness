/**
 * Server-handler tests for POST /api/extensions/[id]/modifiable.
 *
 * Admin-only gate (the user can't self-enable; the in-chat LLM can
 * never reach this route), 404 unknown, 400 bundled / bad body,
 * idempotent no-op, happy path flips + writes the audit row.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/extensions", () => ({
  getExtension: vi.fn(),
  setExtensionModifiable: vi.fn(),
}));
vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => "audit-1"),
}));

const { getExtension, setExtensionModifiable } = await import(
  "$server/db/queries/extensions"
);
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { POST } = await import(
  "../routes/api/extensions/[id]/modifiable/+server.ts"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const id = opts.id ?? "ext-1";
  return makeRequestEvent(`http://localhost/api/extensions/${id}/modifiable`, {
    locals: opts.locals ?? {},
    params: { id },
    request: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body ?? {}),
    },
  });
}

const admin = { id: "admin-1", email: "a@x", name: "a", role: "admin" };
const member = { id: "u-2", email: "u@x", name: "u", role: "member" };

describe("POST /api/extensions/[id]/modifiable", () => {
  beforeEach(() => {
    vi.mocked(getExtension).mockReset();
    vi.mocked(setExtensionModifiable).mockReset();
    vi.mocked(insertAuditEntry).mockClear();
  });

  // 403, matching #84's uniform answer across the admin-gated routes:
  // `requireAdmin` treats "no principal" as "not an admin principal" rather
  // than distinguishing 401. Returned, never thrown (a thrown Response is what
  // SvelteKit renders as a 500). Hook-unreachable anyway — hooks.server.ts
  // 401s unauthenticated /api/* before the handler runs.
  test("unauthenticated → 403", async () => {
    const res = await POST(makeEvent({ locals: {}, body: { modifiable: true } }));
    expect(res.status).toBe(403);
  });

  test("non-admin → 403", async () => {
    const res = await POST(
      makeEvent({ locals: { user: member }, body: { modifiable: true } }),
    );
    expect(res.status).toBe(403);
  });

  // F2/F6: the local `try { requireRole } catch` wrapper was removed because
  // `checkRole` RETURNS its denial (a thrown Response renders as a 500, not
  // the intended 403) AND adds the scope axis. An admin-ROLE key minted
  // `--scopes read` is a full admin principal, so the old role-only gate let
  // it flip this flag. Asserting the denial arrives as a RETURN VALUE is what
  // measures the removed try/catch.
  test("admin-role key without the 'admin' scope → returned 403, never thrown", async () => {
    let threw = false;
    let res: Response | undefined;
    try {
      res = await POST(
        makeEvent({
          locals: { user: admin, apiKeyScopes: ["read"] },
          body: { modifiable: true },
        }),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("admin");
    // The flag was never flipped.
    expect(setExtensionModifiable).not.toHaveBeenCalled();
  });

  // Paired control — the fix must not deny everyone.
  test("admin-role key WITH the 'admin' scope still flips the flag", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      isBundled: false,
      modifiable: false,
    } as any);
    vi.mocked(setExtensionModifiable).mockResolvedValue({
      id: "ext-1",
      modifiable: true,
    } as any);
    const res = await POST(
      makeEvent({
        locals: { user: admin, apiKeyScopes: ["admin"] },
        body: { modifiable: true },
      }),
    );
    expect(res.status).toBe(200);
    expect(setExtensionModifiable).toHaveBeenCalledWith("ext-1", true);
  });

  test("malformed body → 400", async () => {
    const res = await POST(
      makeEvent({ locals: { user: admin }, body: { modifiable: "yes" } }),
    );
    expect(res.status).toBe(400);
  });

  test("unknown extension → 404", async () => {
    vi.mocked(getExtension).mockResolvedValue(null as any);
    const res = await POST(
      makeEvent({ locals: { user: admin }, body: { modifiable: true } }),
    );
    expect(res.status).toBe(404);
  });

  test("bundled extension → 400 (never user-modifiable)", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      isBundled: true,
      modifiable: false,
    } as any);
    const res = await POST(
      makeEvent({ locals: { user: admin }, body: { modifiable: true } }),
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(setExtensionModifiable)).not.toHaveBeenCalled();
  });

  test("idempotent no-op → 200, no write, no audit", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      isBundled: false,
      modifiable: true,
    } as any);
    const res = await POST(
      makeEvent({ locals: { user: admin }, body: { modifiable: true } }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(setExtensionModifiable)).not.toHaveBeenCalled();
    expect(vi.mocked(insertAuditEntry)).not.toHaveBeenCalled();
  });

  test("happy path: flips flag + writes audit with admin actor", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      isBundled: false,
      modifiable: false,
    } as any);
    vi.mocked(setExtensionModifiable).mockResolvedValue({
      id: "ext-1",
      modifiable: true,
    } as any);
    const res = await POST(
      makeEvent({ locals: { user: admin }, body: { modifiable: true } }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(setExtensionModifiable)).toHaveBeenCalledWith("ext-1", true);
    expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledWith(
      admin.id,
      "ext:modifiable-toggled",
      "ext-1",
      expect.objectContaining({
        oldValue: false,
        newValue: true,
        actor: admin.id,
      }),
    );
  });
});
