import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), inspect: vi.fn(), readWorkspace: vi.fn() }));
vi.mock("$server/auth/middleware", () => ({ requireAuth: (locals: { user?: { id: string } }) => { if (!locals.user) throw new Response("Unauthorized", { status: 401 }); return locals.user; } }));
vi.mock("$server/extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => mocks }));
import { load } from "../routes/(app)/extensions/author/+page.server";

function event(query = "", authenticated = true) {
  return { url: new URL(`http://localhost/extensions/author${query}`), locals: { user: authenticated ? { id: "owner" } : undefined, authMethod: "session" } } as Parameters<typeof load>[0];
}

beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([]); });

test("requires authentication before listing workspaces", async () => {
  await expect(load(event("", false))).rejects.toMatchObject({ status: 401 });
  expect(mocks.list).not.toHaveBeenCalled();
});

test("empty route lists only the current actor's workspaces", async () => {
  expect(await load(event())).toMatchObject({ state: null, files: {}, canApprove: true });
  expect(mocks.list).toHaveBeenCalledWith({ principalId: "owner", scope: "global", kind: "human" });
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
