import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), inspect: vi.fn(), readWorkspace: vi.fn(), listProjects: vi.fn(), getExtensionProjectBinding: vi.fn(), checkProjectRole: vi.fn() }));
vi.mock("$lib/server/extensions/control-actor", () => ({ resolveControlActor: async (user: { id: string }, kind: string) => ({ principalId: user.id, scope: "global", kind }) }));
vi.mock("$server/db/queries/projects", () => mocks);
vi.mock("$server/extensions/project-binding", () => mocks);
vi.mock("$server/auth/middleware", () => ({ checkProjectRole: mocks.checkProjectRole, requireAuth: (locals: { user?: { id: string } }) => { if (!locals.user) throw new Response("Unauthorized", { status: 401 }); return locals.user; } }));
vi.mock("$server/extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => mocks }));
import { load } from "../routes/(app)/extensions/author/+page.server";

function event(query = "", authenticated = true) {
  return { url: new URL(`http://localhost/extensions/author${query}`), locals: { user: authenticated ? { id: "owner", role: "admin" } : undefined, authMethod: "session" } } as Parameters<typeof load>[0];
}

beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.listProjects.mockResolvedValue([]); mocks.getExtensionProjectBinding.mockResolvedValue(null); });

test("requires authentication before listing workspaces", async () => {
  await expect(load(event("", false))).rejects.toMatchObject({ status: 401 });
  expect(mocks.list).not.toHaveBeenCalled();
});

test("empty route lists only the current actor's workspaces", async () => {
  expect(await load(event())).toMatchObject({ state: null, files: {}, canApprove: true });
  expect(mocks.list).toHaveBeenCalledWith({ principalId: "owner", scope: "global", kind: "human" });
});

test("member sessions cannot approve releases", async () => {
  const member = event(); member.locals.user!.role = "member";
  expect(await load(member)).toMatchObject({ canApprove: false });
});

test("legacy draft URLs do not execute or install source", async () => {
  await expect(load(event("?prefill=old"))).rejects.toMatchObject({ status: 410 });
  expect(mocks.inspect).not.toHaveBeenCalled();
});

test("loads the selected immutable workspace through owner-scoped lifecycle", async () => {
  mocks.inspect.mockResolvedValue({ installation: { id: "installation" }, workspaces: {} });
  mocks.readWorkspace.mockResolvedValue({ workspace: { id: "workspace", revision: 2 }, files: { "nested/file.ts": "source" } });
  expect(await load(event("?installation=installation&workspace=workspace"))).toMatchObject({ workspace: { revision: 2 }, files: { "nested/file.ts": "source" } });
  expect(mocks.readWorkspace).toHaveBeenCalledWith({ principalId: "owner", scope: "global", kind: "human" }, "installation", "workspace");
});

test("foreign installations are not disclosed", async () => {
  mocks.inspect.mockRejectedValue({ code: "forbidden" });
  await expect(load(event("?installation=foreign"))).rejects.toMatchObject({ status: 404 });
  expect(mocks.readWorkspace).not.toHaveBeenCalled();
});

test("unexpected storage failures remain errors, not empty workspaces", async () => {
  const failure = new Error("storage unavailable");
  mocks.inspect.mockRejectedValue(failure);
  await expect(load(event("?installation=installation"))).rejects.toBe(failure);
});

test("an installation opens its most recent workspace without a workspace query", async () => {
  mocks.inspect.mockResolvedValue({ installation: { id: "installation" }, workspaces: { old: { id: "old", createdAt: "2026-01-01" }, latest: { id: "latest", createdAt: "2026-02-01" } } });
  mocks.readWorkspace.mockResolvedValue({ workspace: { id: "latest" }, files: {} });
  expect(await load(event("?installation=installation"))).toMatchObject({ workspace: { id: "latest" } });
  expect(mocks.readWorkspace).toHaveBeenCalledWith(expect.anything(), "installation", "latest");
});

test("project controls list only local member projects and owner session access", async () => {
  mocks.inspect.mockResolvedValue({ installation: { id: "installation", ownerId: "owner" }, workspaces: {} });
  mocks.listProjects.mockResolvedValue([{ id: "allowed", name: "Allowed", path: "/project" }, { id: "remote", name: "Remote", path: null }, { id: "foreign", name: "Foreign", path: "/foreign" }]);
  mocks.checkProjectRole.mockImplementation(async (_context, id) => id === "allowed" ? undefined : new Response(null, { status: 403 }));
  expect(await load(event("?installation=installation"))).toMatchObject({ projects: [{ id: "allowed", name: "Allowed" }], canBindProject: true, projectBinding: null });
});
