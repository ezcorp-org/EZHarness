/**
 * Server-handler unit tests for /api/extensions/[id]/permissions (+server.ts).
 *
 * GET: any authenticated user — 401, 404 + happy path.
 * PUT: admin-only — 401, 403, 404, 400 on missing/invalid permissions.
 * clampToManifest logic is internal and exercised indirectly via the
 * happy path; DB + registry are mocked.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/extensions", () => ({
  getExtension: vi.fn(),
  updateExtension: vi.fn(),
}));

vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: vi.fn(async () => undefined) }),
  },
}));

vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { getExtension, updateExtension } = await import(
  "$server/db/queries/extensions"
);
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { GET, PUT } = await import(
  "../routes/api/extensions/[id]/permissions/+server.ts"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: string;
}) {
  const id = opts.id ?? "ext-1";
  const href = `http://localhost/api/extensions/${id}/permissions`;
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(href, {
      method: opts.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const adminUser = { id: "u1", email: "a@x", name: "a", role: "admin" };
const regularUser = { id: "u2", email: "u@x", name: "u", role: "user" };

describe("GET /api/extensions/[id]/permissions", () => {
  beforeEach(() => {
    vi.mocked(getExtension).mockReset();
  });

  test("unauthenticated request throws 401", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("unknown extension returns 404", async () => {
    vi.mocked(getExtension).mockResolvedValue(null as any);
    const res = await GET(makeEvent({ locals: { user: regularUser } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("happy path: returns granted permissions", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      grantedPermissions: { grantedAt: {}, shell: true },
    } as any);
    const res = await GET(makeEvent({ locals: { user: regularUser } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shell?: boolean };
    expect(body.shell).toBe(true);
  });
});

describe("PUT /api/extensions/[id]/permissions", () => {
  beforeEach(() => {
    vi.mocked(getExtension).mockReset();
    vi.mocked(updateExtension).mockReset();
  });

  test("unauthenticated request RETURNS 401 (not thrown → no 500)", async () => {
    const res = await PUT(
      makeEvent({
        locals: {},
        method: "PUT",
        body: { permissions: {} },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
  });

  test("non-admin authenticated user RETURNS 403 (not thrown → no 500)", async () => {
    const res = await PUT(
      makeEvent({
        locals: { user: regularUser },
        method: "PUT",
        body: { permissions: {} },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
  });

  // Track 1 regression: an API-key principal (extensions/admin SCOPE but
  // member ROLE) gets a clean 403 JSON — pre-fix the raw thrown Response
  // surfaced as a 500 for key callers, an RCE-adjacent footgun.
  test("API-key caller (member role) RETURNS 403 JSON, never 500", async () => {
    const res = await PUT(
      makeEvent({
        locals: {
          user: { id: "u2", email: "u@x", name: "u", role: "member" },
          apiKeyScopes: ["extensions", "admin"],
        },
        method: "PUT",
        body: { permissions: { shell: true } },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error!.length).toBeGreaterThan(0);
    expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
  });

  // Scope-axis regression: an admin-ROLE key needs the admin SCOPE too. A key
  // minted `--scopes extensions --role admin` clears the role wall but not the
  // scope wall → clean 403 "Insufficient scope", and the write never happens.
  test("admin-role key WITHOUT admin scope RETURNS 403; no write (scope axis)", async () => {
    const res = await PUT(
      makeEvent({
        locals: {
          user: { id: "u1", email: "a@x", name: "a", role: "admin" },
          apiKeyScopes: ["extensions"],
        },
        method: "PUT",
        body: { permissions: { shell: true } },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("admin");
    expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
  });

  // With BOTH the admin role and the admin scope the key clears every gate and
  // the clamp/write proceeds → 200.
  test("admin-role key WITH admin scope clears both gates → 200", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      grantedPermissions: { grantedAt: {} },
      manifest: { permissions: { shell: true } },
    } as any);
    vi.mocked(updateExtension).mockResolvedValue({ id: "ext-1" } as any);
    const res = await PUT(
      makeEvent({
        locals: {
          user: { id: "u1", email: "a@x", name: "a", role: "admin" },
          apiKeyScopes: ["extensions", "admin"],
        },
        method: "PUT",
        body: { permissions: { shell: true } },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(updateExtension)).toHaveBeenCalledTimes(1);
  });

  test("unknown extension returns 404", async () => {
    vi.mocked(getExtension).mockResolvedValue(null as any);
    const res = await PUT(
      makeEvent({
        locals: { user: adminUser },
        method: "PUT",
        body: { permissions: {} },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("missing permissions returns 400", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      grantedPermissions: { grantedAt: {} },
      manifest: { permissions: {} },
    } as any);
    const res = await PUT(
      makeEvent({
        locals: { user: adminUser },
        method: "PUT",
        body: {},
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("permissions required");
  });

  test("non-object permissions returns 400", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      grantedPermissions: { grantedAt: {} },
      manifest: { permissions: {} },
    } as any);
    const res = await PUT(
      makeEvent({
        locals: { user: adminUser },
        method: "PUT",
        body: { permissions: "bogus" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("happy path: clamps submitted permissions to manifest declaration", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      grantedPermissions: { grantedAt: {} },
      manifest: { permissions: { shell: true } },
    } as any);
    vi.mocked(updateExtension).mockResolvedValue({ id: "ext-1" } as any);
    const res = await PUT(
      makeEvent({
        locals: { user: adminUser },
        method: "PUT",
        body: {
          permissions: {
            shell: true,
            // filesystem isn't declared in manifest — clamp drops it.
            filesystem: ["/etc"],
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const call = vi.mocked(updateExtension).mock.calls[0]!;
    const update = call[1] as unknown as {
      grantedPermissions: Record<string, unknown>;
    };
    expect(update.grantedPermissions.shell).toBe(true);
    expect(update.grantedPermissions.filesystem).toBeUndefined();
  });

  // Phase 3 §5.2 — the Capabilities panel writes the search GRANT override
  // through THIS admin route (not a new one). Verify the three-state
  // override round-trips through clampExtensionPermissions.
  describe("search capability override (Phase 3)", () => {
    test("non-admin CANNOT write a capability override → 403", async () => {
      vi.mocked(getExtension).mockResolvedValue({
        id: "ext-1",
        grantedPermissions: { grantedAt: {}, search: "inherit" },
        manifest: { permissions: { search: "inherit" } },
      } as any);
      const res = await PUT(
        makeEvent({
          locals: { user: regularUser },
          method: "PUT",
          body: { permissions: { search: { quota: 500 } } },
        }),
      );
      expect(res.status).toBe(403);
      expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
    });

    test("admin Custom override → { quota: 500 } persists when the manifest ceiling permits it", async () => {
      // The manifest must declare a quota ceiling ≥ 500 — clampSearchPermission
      // caps the override at the narrower of submitted and manifest (a
      // `"inherit"` manifest defaults the ceiling to 100, blocking 500).
      vi.mocked(getExtension).mockResolvedValue({
        id: "ext-1",
        grantedPermissions: { grantedAt: {}, search: "inherit" },
        manifest: { permissions: { search: { quota: 1000 } } },
      } as any);
      vi.mocked(updateExtension).mockResolvedValue({ id: "ext-1" } as any);
      const res = await PUT(
        makeEvent({
          locals: { user: adminUser },
          method: "PUT",
          body: { permissions: { search: { quota: 500 } } },
        }),
      );
      expect(res.status).toBe(200);
      const update = vi.mocked(updateExtension).mock.calls[0]![1] as unknown as {
        grantedPermissions: Record<string, unknown>;
      };
      expect(update.grantedPermissions.search).toEqual({ quota: 500 });
    });

    test("admin override ABOVE the manifest ceiling is clamped DOWN (security bound)", async () => {
      vi.mocked(getExtension).mockResolvedValue({
        id: "ext-1",
        grantedPermissions: { grantedAt: {}, search: "inherit" },
        manifest: { permissions: { search: "inherit" } }, // → 100 ceiling
      } as any);
      vi.mocked(updateExtension).mockResolvedValue({ id: "ext-1" } as any);
      const res = await PUT(
        makeEvent({
          locals: { user: adminUser },
          method: "PUT",
          body: { permissions: { search: { quota: 500 } } },
        }),
      );
      expect(res.status).toBe(200);
      const update = vi.mocked(updateExtension).mock.calls[0]![1] as unknown as {
        grantedPermissions: Record<string, unknown>;
      };
      // Clamped to the manifest's 100 ceiling — admin can't exceed the author.
      expect(update.grantedPermissions.search).toEqual({ quota: 100 });
    });

    test("admin Disabled → grant search:false persists", async () => {
      vi.mocked(getExtension).mockResolvedValue({
        id: "ext-1",
        grantedPermissions: { grantedAt: {}, search: "inherit" },
        manifest: { permissions: { search: "inherit" } },
      } as any);
      vi.mocked(updateExtension).mockResolvedValue({ id: "ext-1" } as any);
      const res = await PUT(
        makeEvent({
          locals: { user: adminUser },
          method: "PUT",
          body: { permissions: { search: false } },
        }),
      );
      expect(res.status).toBe(200);
      const update = vi.mocked(updateExtension).mock.calls[0]![1] as unknown as {
        grantedPermissions: Record<string, unknown>;
      };
      expect(update.grantedPermissions.search).toBe(false);
    });
  });

  // Phase B — typed CAPABILITY_POLICY_WRITE audit row (additive over the
  // existing legacy blob + per-field rows).
  describe("capability-policy-write audit row (Phase B)", () => {
    function policyWriteCalls() {
      return vi
        .mocked(insertAuditEntry)
        .mock.calls.filter((c) => c[1] === "ext:capability-policy-write");
    }

    beforeEach(() => {
      vi.mocked(insertAuditEntry).mockClear();
    });

    test("a changed search policy emits exactly one typed row with the full before→after value", async () => {
      vi.mocked(getExtension).mockResolvedValue({
        id: "ext-1",
        grantedPermissions: { grantedAt: {}, search: "inherit" },
        manifest: { permissions: { search: { quota: 1000 } } },
      } as any);
      vi.mocked(updateExtension).mockResolvedValue({ id: "ext-1" } as any);
      await PUT(
        makeEvent({
          locals: { user: adminUser },
          method: "PUT",
          body: { permissions: { search: { quota: 500 } } },
        }),
      );
      const calls = policyWriteCalls();
      expect(calls.length).toBe(1);
      const [actorId, action, target, meta] = calls[0]!;
      expect(actorId).toBe(adminUser.id);
      expect(action).toBe("ext:capability-policy-write");
      expect(target).toBe("ext-1");
      expect(meta).toMatchObject({
        capability: "search",
        oldValue: "inherit",
        newValue: { quota: 500 },
        actor: adminUser.id,
        reason: "admin-policy-write",
        route: "permissions",
      });
    });

    test("the legacy blob + per-field rows are NOT regressed (additive)", async () => {
      vi.mocked(getExtension).mockResolvedValue({
        id: "ext-1",
        grantedPermissions: { grantedAt: {}, search: "inherit" },
        manifest: { permissions: { search: { quota: 1000 } } },
      } as any);
      vi.mocked(updateExtension).mockResolvedValue({ id: "ext-1" } as any);
      await PUT(
        makeEvent({
          locals: { user: adminUser },
          method: "PUT",
          body: { permissions: { search: { quota: 500 } } },
        }),
      );
      const actions = vi.mocked(insertAuditEntry).mock.calls.map((c) => c[1]);
      // Legacy blob row preserved.
      expect(actions).toContain("extension:permissions_granted");
      // New typed row present additively.
      expect(actions).toContain("ext:capability-policy-write");
    });

    test("no typed row when the search policy is unchanged", async () => {
      vi.mocked(getExtension).mockResolvedValue({
        id: "ext-1",
        grantedPermissions: { grantedAt: {}, search: "inherit" },
        manifest: { permissions: { search: "inherit" } },
      } as any);
      vi.mocked(updateExtension).mockResolvedValue({ id: "ext-1" } as any);
      await PUT(
        makeEvent({
          locals: { user: adminUser },
          method: "PUT",
          body: { permissions: { search: "inherit" } },
        }),
      );
      expect(policyWriteCalls().length).toBe(0);
    });
  });
});
