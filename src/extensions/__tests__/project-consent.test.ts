import { afterAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { createPermissionEngine, type AuthorizeContext } from "../permission-engine";
import { hasProjectOperationConsent } from "../project-consent";
import { createExtension, updateExtension } from "../../db/queries/extensions";
import { createProject } from "../../db/queries/projects";
import { createConversation } from "../../db/queries/conversations";
import { users } from "../../db/schema";
import type { ExtensionRegistry } from "../registry";
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
  const binding = { id: "binding", projectId: project.id, ownerId: user!.id, releaseId: "release", generation: 1, writePaths: ["docs/"] };
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
