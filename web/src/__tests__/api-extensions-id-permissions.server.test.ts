
import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/extensions", () => ({
  getExtensionByRef: vi.fn(),
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

const { getExtensionByRef, updateExtension } = await import(
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
  return makeRequestEvent(href, {
    locals: opts.locals ?? {},
    params: { id },
    request: {
      method: opts.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  });
}

const adminUser = { id: "u1", email: "a@x", name: "a", role: "admin" };
const regularUser = { id: "u2", email: "u@x", name: "u", role: "user" };

describe("GET /api/extensions/[id]/permissions", () => {
  beforeEach(() => {
    vi.mocked(getExtensionByRef).mockReset();
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
    vi.mocked(getExtensionByRef).mockResolvedValue(null as any);
    const res = await GET(makeEvent({ locals: { user: regularUser } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("happy path: returns granted permissions", async () => {
    vi.mocked(getExtensionByRef).mockResolvedValue({
      id: "ext-1",
      grantedPermissions: { grantedAt: {}, shell: true },
    } as any);
    const res = await GET(makeEvent({ locals: { user: regularUser } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shell?: boolean };
    expect(body.shell).toBe(true);
  });
});


describe("retired permission mutations cannot replace sealed release approval", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  for (const permissions of [{ shell: true, filesystem: ["/"] }, { search: { quota: 500 } }, { search: false }, { acceptsCallerCaps: true, escalateChildCaps: true }, null, [], "invalid"]) {
    test(`refuses mutation ${JSON.stringify(permissions)} without changing grants or audit`, async () => {
      const response = await PUT(makeEvent({ method: "PUT", locals: { user: adminUser }, body: { permissions } }));
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ reviewUrl: "/extensions/author?installation=ext-1" });
      expect(updateExtension).not.toHaveBeenCalled();
      expect(insertAuditEntry).not.toHaveBeenCalled();
    });
  }
});
