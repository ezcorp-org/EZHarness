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

  test("unauthenticated request throws 401", async () => {
    let res: Response | undefined;
    try {
      await PUT(
        makeEvent({
          locals: {},
          method: "PUT",
          body: { permissions: {} },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("non-admin authenticated user throws 403", async () => {
    let res: Response | undefined;
    try {
      await PUT(
        makeEvent({
          locals: { user: regularUser },
          method: "PUT",
          body: { permissions: {} },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
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
});
