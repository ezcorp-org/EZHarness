
import { afterAll, expect, mock, test, beforeEach } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import { ADMIN_USER, MEMBER_USER, createMockEvent, mockServerAlias } from "../helpers/mock-request";

mockServerAlias();
const scopes = () => ({ requireScope: () => null });
mock.module("$lib/server/security/api-keys", scopes);
mock.module("../../../web/src/lib/server/security/api-keys", scopes);
const { POST } = await import("../../../web/src/routes/api/extensions/[id]/activate/+server");
afterAll(() => restoreModuleMocks());

test("neither role can install, execute or grant authority through the retired endpoint", async () => {
  for (const user of [ADMIN_USER, MEMBER_USER]) {
    for (const id of ["installation", "unknown"]) {
      for (const body of [{}, { grantedPermissions: { shell: true, filesystem: ["/"], network: true, storage: true } }, { grantedPermissions: "invalid" }]) {
        const event = createMockEvent({ method: "POST", url: "http://localhost/api/extensions/" + id, params: { id }, user, body });
        const response = await POST(event as never);
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({ code: "extension_v4_required", controlUrl: "/api/extensions/control", openUrl: "/extensions/author" });
      }
    }
  }
});

test("unauthenticated requests remain denied before the retirement response", async () => {
  const event = createMockEvent({ method: "POST", url: "http://localhost/api/extensions/installation", params: { id: "installation" }, body: {} });
  let response: Response;
  try { response = await POST(event as never); }
  catch (error) { if (!(error instanceof Response)) throw error; response = error; }
  expect(response.status).toBe(401);
});

async function _retiredActivation(user: typeof ADMIN_USER | typeof MEMBER_USER, body: unknown, id = "installation") {
  return POST(createMockEvent({ method: "POST", url: `http://localhost/api/extensions/${id}/activate`, params: { id }, user, body }) as never);
}


import { sql } from "drizzle-orm";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../helpers/test-pglite";
import { createPermissionEngine, type AuthorizeContext } from "../../extensions/permission-engine";
import { hasProjectOperationConsent } from "../../extensions/project-consent";
import { createExtension, updateExtension } from "../../db/queries/extensions";
import { createProject } from "../../db/queries/projects";
import { createConversation } from "../../db/queries/conversations";
import { users } from "../../db/schema";
import type { ExtensionRegistry } from "../../extensions/registry";
import { validateManifest } from "@ezcorp/extension-contract";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);
async function fixture() {
  const database = getTestDb();
  const [user] = await database.insert(users).values({ email: `${crypto.randomUUID()}@example.test`, name: "Owner", passwordHash: "unused" }).returning();
  const project = await createProject({ name: "Owned project", path: "/project" }, user!.id);
  const conversation = await createConversation(project.id, { title: "Owned", userId: user!.id });
  const id = crypto.randomUUID();
  const manifest = validateManifest({ schemaVersion: 4, name: `project-${id}`, version: "1.0.0", author: { name: "Test" }, description: "Consent fixture", permissions: { shell: true, network: ["api.github.com"] } });
  const grants = { shell: true, network: ["api.github.com"], grantedAt: { shell: Date.now(), network: Date.now() } };
  await createExtension({ id, name: manifest.name, manifest, version: manifest.version, creatorUserId: user!.id, source: "release-v4", enabled: true, grantedPermissions: grants });
  const installation = { id, ownerId: user!.id, scope: "global", activeReleaseId: "release", generation: 1, enabled: true, uninstalled: false };
  const binding = { id: "binding", projectId: project.id, ownerId: user!.id, releaseId: "release", generation: 1, approvedAt: "2026-01-01T00:00:00.000Z", writePaths: ["docs/"] };
  await database.execute(sql`INSERT INTO extension_release_installations(id,owner_id,scope,payload) VALUES(${id},${user!.id},'global',${JSON.stringify(installation)})`);
  await database.execute(sql`INSERT INTO extension_project_bindings(installation_id,payload) VALUES(${id},${JSON.stringify(binding)})`);
  const registry = { getManifest: () => manifest, getGrantedPermissions: () => grants } as unknown as ExtensionRegistry;
  const engine = createPermissionEngine({ registry, db: database, bus: { emit() {}, on() {} } as never });
  const context: AuthorizeContext = { extensionId: id, userId: user!.id, conversationId: conversation.id, toolName: "project.gitHead", projectConsent: { projectId: project.id, bindingId: "binding" } };
  return { database, user: user!, project, id, installation, binding, context, engine };
}

test("exact human project consent satisfies only fixed reads after normal live grant checks", async () => {
  const { context, engine, id, database } = await fixture();
  expect((await engine.authorize(context, [{ kind: "shell" }])).decision).toBe("allow");
  expect((await engine.authorize({ ...context, projectConsent: undefined }, [{ kind: "shell" }])).decision).toBe("prompt");
  expect((await engine.authorize({ ...context, toolName: "shell.run" }, [{ kind: "shell" }])).decision).toBe("deny");
  expect((await engine.authorize({ ...context, capContext: [] }, [{ kind: "shell" }])).decision).toBe("deny");
  await updateExtension(id, { grantedPermissions: { grantedAt: {} } });
  expect((await engine.authorize(context, [{ kind: "shell" }])).decision).toBe("deny");
  await database.execute(sql`UPDATE extension_project_bindings SET payload='invalid-json' WHERE installation_id=${id}`);
  expect(await hasProjectOperationConsent(context, [{ kind: "shell" }])).toBe(false);
});

test("revoked or rebound projects and lost membership cannot reuse old consent", async () => {
  const { database, context, engine, id, binding, user } = await fixture();
  await database.execute(sql`UPDATE extension_project_bindings SET payload=${JSON.stringify({ ...binding, id: "replacement" })} WHERE installation_id=${id}`);
  expect((await engine.authorize(context, [{ kind: "shell" }])).decision).toBe("deny");
  await database.execute(sql`UPDATE extension_project_bindings SET payload=${JSON.stringify(binding)} WHERE installation_id=${id}`);
  await database.execute(sql`DELETE FROM project_members WHERE project_id=${binding.projectId} AND user_id=${user.id}`);
  expect((await engine.authorize(context, [{ kind: "shell" }])).decision).toBe("deny");
});

test("GitHub writes require a live executing human decision in addition to the binding", async () => {
  const { database, context, engine, id, binding, user } = await fixture();
  const write = { ...context, toolName: "project.pullRequest.write", projectConsent: { ...context.projectConsent!, proposalId: "proposal" } };
  const needed = [{ kind: "shell" as const }, { kind: "network" as const, value: "api.github.com" }];
  expect((await engine.authorize(write, needed)).decision).toBe("deny");
  const proposal = { ownerId: user.id, decidedBy: user.id, bindingId: binding.id, projectId: binding.projectId, decision: "finalize", createdAt: Date.now() };
  await database.execute(sql`INSERT INTO extension_project_decisions(id,installation_id,state,payload) VALUES('proposal',${id},'proposed',${JSON.stringify(proposal)})`);
  expect((await engine.authorize(write, needed)).decision).toBe("deny");
  await database.execute(sql`UPDATE extension_project_decisions SET state='executing' WHERE id='proposal'`);
  expect((await engine.authorize(write, needed)).decision).toBe("allow");
  await database.execute(sql`UPDATE extension_project_decisions SET state='completed' WHERE id='proposal'`);
  expect((await engine.authorize(write, needed)).decision).toBe("deny");
  expect(await hasProjectOperationConsent({ ...write, projectConsent: { ...context.projectConsent! } }, needed)).toBe(false);
  expect(await hasProjectOperationConsent(context, [{ kind: "fs.write", value: "/etc" }])).toBe(false);
  expect(await hasProjectOperationConsent({ ...context, userId: null }, needed)).toBe(false);
});

let bindingOwner = "";
mock.module("../../extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => ({ inspect: async () => ({ installation: { ownerId: bindingOwner } }) }) }));
const { getExtensionProjectBinding, setExtensionProjectBinding } = await import("../../extensions/project-binding");

test("human binds exact active release and revokes without child-writable storage", async () => {
  const { id, user, project } = await fixture();
  bindingOwner = user.id;
  const actor = { kind: "human" as const, principalId: user.id, scope: "global" };
  const input = { installationId: id, projectId: project.id, releaseId: "release", generation: 1 };
  expect(await getExtensionProjectBinding("missing")).toBeNull();
  const binding = await setExtensionProjectBinding(actor, input);
  expect(binding).toMatchObject({ projectId: project.id, ownerId: user.id, releaseId: "release", generation: 1 });
  expect(await getExtensionProjectBinding(id)).toEqual(binding);
  const replacement = await setExtensionProjectBinding(actor, { ...input, writePaths: ["docs/", "README.md", "docs/"] });
  expect(replacement?.id).not.toBe(binding?.id);
  expect(replacement?.writePaths).toEqual(["README.md", "docs/"]);
  expect(await setExtensionProjectBinding(actor, { ...input, projectId: null })).toBeNull();
  expect(await getExtensionProjectBinding(id)).toBeNull();
});

test("binding requires human active owner membership local project and exact revision", async () => {
  const { id, user, project, database, binding } = await fixture();
  bindingOwner = user.id;
  const actor = { kind: "human" as const, principalId: user.id, scope: "global" };
  const input = { installationId: id, projectId: project.id, releaseId: "release", generation: 1 };
  await expect(setExtensionProjectBinding({ ...actor, kind: "agent" }, input)).rejects.toThrow("human session");
  await expect(setExtensionProjectBinding(actor, { ...input, generation: -1 })).rejects.toThrow("exact release");
  for (const path of ["../outside", "/absolute", "docs//", "docs/./file", "docs/*", "docs/\\bad", ""]) await expect(setExtensionProjectBinding(actor, { ...input, writePaths: [path] })).rejects.toThrow("safe relative");
  bindingOwner = "other";
  await expect(setExtensionProjectBinding(actor, input)).rejects.toThrow("installation owner");
  bindingOwner = user.id;
  await database.execute(sql`UPDATE users SET status='inactive' WHERE id=${user.id}`);
  await expect(setExtensionProjectBinding(actor, input)).rejects.toThrow("active user");
  await database.execute(sql`UPDATE users SET status='active' WHERE id=${user.id}`);
  await database.execute(sql`UPDATE projects SET path='' WHERE id=${project.id}`);
  await expect(setExtensionProjectBinding(actor, input)).rejects.toThrow("local project");
  await database.execute(sql`UPDATE projects SET path='/project' WHERE id=${project.id}`);
  await expect(setExtensionProjectBinding(actor, { ...input, generation: 0 })).rejects.toThrow("active release changed");
  await database.execute(sql`DELETE FROM project_members WHERE project_id=${project.id} AND user_id=${user.id}`);
  await expect(setExtensionProjectBinding(actor, input)).rejects.toThrow("membership");
  expect(await getExtensionProjectBinding(id)).toEqual(binding);
});

test("disabled changed uninstalled or transferred releases immediately invalidate binding", async () => {
  const { id, user, project, database, installation } = await fixture();
  bindingOwner = user.id;
  const actor = { kind: "human" as const, principalId: user.id, scope: "global" };
  const input = { installationId: id, projectId: project.id, releaseId: "release", generation: 1 };
  await setExtensionProjectBinding(actor, input);
  for (const patch of [{ enabled: false }, { uninstalled: true }, { activeReleaseId: "new" }, { generation: 2 }, { ownerId: "other" }]) {
    await database.execute(sql`UPDATE extension_release_installations SET payload=${JSON.stringify({ ...installation, ...patch })} WHERE id=${id}`);
    expect(await getExtensionProjectBinding(id)).toBeNull();
    await expect(setExtensionProjectBinding(actor, input)).rejects.toThrow("active release changed");
  }
});
