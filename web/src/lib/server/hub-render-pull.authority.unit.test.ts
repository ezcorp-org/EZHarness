import { beforeEach, expect, test, vi } from "vitest";
import { renderExtensionPage } from "./hub-render-pull";
import { ExtensionPageCache } from "$server/extensions/page-cache";
import type { Extension } from "$server/db/schema";

const fixture = vi.hoisted(() => ({ user: { id: "alice", status: "active", role: "member" }, scope: "global", binding: "release-1:g1:grants-1", members: new Set<string>(), active: true, enabled: true, grants: {} as Record<string, unknown> }));
vi.mock("$server/db/queries/users", () => ({ getUserById: async () => fixture.user }));
vi.mock("$server/db/queries/extensions", () => ({ getExtension: async () => ({ enabled: fixture.enabled, grantedPermissions: fixture.grants }) }));
vi.mock("$server/db/queries/project-members", () => ({ getProjectMembership: async (_user: string, project: string) => fixture.members.has(project) ? { role: "member" } : null }));
vi.mock("$server/db/queries/projects", () => ({ listProjects: async () => [{ id: "project-a" }, { id: "project-b" }] }));
vi.mock("$server/extensions/release-process", () => ({ getReleaseRuntime: () => ({}), resolveActiveRelease: async () => { if (!fixture.active) throw new Error("No active release"); return { installation: { scope: fixture.scope } }; }, releaseBinding: () => fixture.binding }));
vi.mock("$lib/server/context", () => ({ getBus: () => ({ on: () => {} }) }));

beforeEach(() => { fixture.user = { id: "alice", status: "active", role: "member" }; fixture.scope = "global"; fixture.binding = "release-1:g1:grants-1"; fixture.members.clear(); fixture.active = true; fixture.enabled = true; fixture.grants = {}; });

function page(perProject = false) {
  const extension = { id: crypto.randomUUID(), grantedPermissions: {} } as Extension;
  const callPage = vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: { title: "private", nodes: [] } }));
  const deps = { findPage: async () => ({ extension, page: { id: "dashboard", title: "private", perProject } }), callPage, cache: new ExtensionPageCache() };
  return { callPage, render: (project?: { id: string; name: string; path: string }) => renderExtensionPage("private", "dashboard", "alice", deps, project) };
}

test("live user and active release checks run even for a fresh cache hit", async () => {
  const current = page();
  expect((await current.render()).page?.title).toBe("private");
  fixture.user.status = "inactive";
  expect(await current.render()).toEqual({ notFound: true });
  fixture.user.status = "active";
  fixture.active = false;
  expect(await current.render()).toEqual({ notFound: true });
  fixture.active = true;
  fixture.enabled = false;
  expect(await current.render()).toEqual({ notFound: true });
  expect(current.callPage).toHaveBeenCalledTimes(1);
});

test("project installations and explicit project views recheck membership", async () => {
  const current = page(true);
  fixture.scope = "project:project-a";
  expect(await current.render()).toEqual({ notFound: true });
  fixture.members.add("project-a");
  expect((await current.render()).page).toBeDefined();
  expect(await current.render({ id: "project-b", name: "Other", path: "/host" })).toEqual({ notFound: true });
  fixture.user.role = "admin";
  expect((await current.render({ id: "project-b", name: "Other", path: "/host" })).page).toBeDefined();
  fixture.scope = "conversation:untrusted";
  expect(await current.render()).toEqual({ notFound: true });
});

test("visible project membership changes and release changes invalidate authority keys", async () => {
  const current = page(true);
  await current.render();
  fixture.members.add("project-a");
  await current.render();
  fixture.binding = "release-2:g2:grants-2";
  await current.render();
  fixture.members.delete("project-a");
  await current.render();
  fixture.grants = { storage: true };
  await current.render();
  expect(current.callPage).toHaveBeenCalledTimes(5);
});
