import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listExtensions: vi.fn(), listProjects: vi.fn(), checkProjectRole: vi.fn(), list: vi.fn(), inspect: vi.fn(), resolveControlActor: vi.fn() }));
vi.mock("$server/db/queries/extensions", () => mocks);
vi.mock("$server/db/queries/projects", () => mocks);
vi.mock("$server/extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => mocks }));
vi.mock("$lib/server/extensions/control-actor", () => mocks);
vi.mock("$server/auth/middleware", () => ({ checkProjectRole: mocks.checkProjectRole, requireSessionAuth: (locals: { user?: unknown; authMethod?: string }) => locals.user && locals.authMethod === "session" ? locals.user : new Response(null, { status: 403 }) }));
import { load } from "../routes/(app)/extensions/import-source/+page.server";
function event(query = "", role = "member", authMethod = "session") { return { url: new URL(`http://localhost/extensions/import-source${query}`), locals: { user: { id: "owner", role }, authMethod } } as Parameters<typeof load>[0]; }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
  mocks.inspect.mockRejectedValue(new Error("Missing installation"));
  mocks.resolveControlActor.mockResolvedValue({ principalId: "owner", scope: "global", kind: "human" });
  mocks.listExtensions.mockResolvedValue([{ id: "owned", name: "My extension", creatorUserId: "owner", installPath: "/secret/path" }, { id: "second", name: "Another extension", creatorUserId: "owner" }, { id: "foreign", name: "Foreign private name", creatorUserId: "stranger" }]);
  mocks.listProjects.mockResolvedValue([{ id: "allowed", name: "Allowed", path: "/allowed" }, { id: "foreign", name: "Private project", path: "/private" }, { id: "remote", name: "Remote", path: null }]);
  mocks.checkProjectRole.mockImplementation(async (_context, id) => id === "allowed" ? undefined : new Response(null, { status: 403 }));
});
test("source page requires a human session before reading resources", async () => {
  await expect(load(event("", "admin", "api-key"))).rejects.toMatchObject({ status: 403 });
  expect(mocks.listExtensions).not.toHaveBeenCalled();
});
test("source page lists only owned targets and local projects with current membership", async () => {
  expect(await load(event("?installation=owned"))).toEqual({ canCreate: false, targets: [{ id: "second", name: "Another extension" }, { id: "owned", name: "My extension" }], projects: [{ id: "allowed", name: "Allowed" }], selectedTarget: "owned" });
  expect(await load(event("", "admin"))).toMatchObject({ canCreate: true, selectedTarget: "" });
});
test("a foreign or absent selected target is not disclosed even to another administrator", async () => {
  for (const target of ["foreign", "missing"]) await expect(load(event(`?installation=${target}`, "admin"))).rejects.toMatchObject({ status: 404 });
});

test("owned unpublished and project-scoped targets stay available before activation", async () => {
  mocks.list.mockResolvedValue([{ id: "new", uninstalled: false }, { id: "owned", uninstalled: false }, { id: "removed", uninstalled: true }]);
  mocks.inspect.mockImplementation(async (_actor, id) => ({ installation: { id, ownerId: "owner", uninstalled: false }, releases: id === "scoped" ? { first: { manifest: { name: "Older release" }, createdAt: "2026-01-01" }, latest: { manifest: { name: "Scoped source" }, createdAt: "2026-02-01" } } : {} }));
  const loaded = await load(event("?installation=scoped"));
  expect(loaded).toMatchObject({ selectedTarget: "scoped", targets: expect.arrayContaining([{ id: "new", name: "Unpublished installation · new" }, { id: "scoped", name: "Scoped source" }]) });
  expect(mocks.inspect).not.toHaveBeenCalledWith(expect.anything(), "removed");
});

test("current ownership loss is denied and unexpected unselected storage failures remain errors", async () => {
  mocks.inspect.mockResolvedValue({ installation: { ownerId: "stranger", uninstalled: false }, releases: {} });
  await expect(load(event("?installation=foreign"))).rejects.toMatchObject({ status: 404 });
  mocks.list.mockResolvedValue([{ id: "new", uninstalled: false }]);
  const failure = new Error("Storage unavailable"); mocks.inspect.mockRejectedValue(failure);
  await expect(load(event())).rejects.toBe(failure);
});
