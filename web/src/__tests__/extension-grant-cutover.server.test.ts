import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getExtensionByRef: vi.fn(), updateExtension: vi.fn(), upsertSetting: vi.fn() }));
vi.mock("$server/db/queries/extensions", () => mocks);
vi.mock("$server/db/queries/settings", () => mocks);
vi.mock("$server/auth/middleware", () => ({ requireAuth: (locals: { user?: unknown }) => { if (!locals.user) throw new Response("Unauthorized", { status: 401 }); return locals.user; } }));
vi.mock("$lib/server/security/api-keys", () => ({ requireScope: (locals: { authMethod?: string; scopes?: string[] }, scope: string) => locals.authMethod === "session" || locals.scopes?.includes(scope) ? null : new Response("Forbidden", { status: 403 }) }));
import { POST } from "../routes/api/extensions/[id]/reapprove/+server";
import { GET, PUT } from "../routes/api/extensions/[id]/permissions/+server";

function event(authMethod = "session", scopes = ["extensions", "read"], user: unknown = { id: "owner", role: "admin" }) {
  return { params: { id: "installation" }, locals: { authMethod, scopes, user }, request: { json: vi.fn(() => { throw new Error("Retired mutations must not parse attacker input"); }) } } as unknown as Parameters<typeof POST>[0];
}
beforeEach(() => { vi.clearAllMocks(); mocks.getExtensionByRef.mockResolvedValue({ grantedPermissions: { storage: true } }); });

test("old grant mutations are gone even for human admins and full-scope API keys", async () => {
  for (const handler of [POST, PUT]) for (const auth of ["session", "api-key", "internal"]) {
    const input = event(auth);
    const response = await handler(input);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "extension_v4_required", reviewUrl: "/extensions/author?installation=installation" });
    expect(input.request.json).not.toHaveBeenCalled();
  }
  expect(mocks.updateExtension).not.toHaveBeenCalled();
  expect(mocks.upsertSetting).not.toHaveBeenCalled();
  expect(mocks.getExtensionByRef).not.toHaveBeenCalled();
});

test("retired mutations still require authentication and extension scope", async () => {
  for (const handler of [POST, PUT]) {
    expect((await handler(event("api-key", ["read"]))).status).toBe(403);
    await expect(handler(event("session", [], null))).rejects.toMatchObject({ status: 401 });
  }
});

test("permission reads require read scope and cannot expose uninstalled references", async () => {
  expect((await GET(event("api-key", ["extensions"]) as Parameters<typeof GET>[0])).status).toBe(403);
  expect(mocks.getExtensionByRef).not.toHaveBeenCalled();
  const response = await GET(event() as Parameters<typeof GET>[0]);
  expect(await response.json()).toEqual({ storage: true });
  expect(mocks.getExtensionByRef).toHaveBeenCalledWith("installation");
  mocks.getExtensionByRef.mockResolvedValue(null);
  expect((await GET(event() as Parameters<typeof GET>[0])).status).toBe(404);
});
