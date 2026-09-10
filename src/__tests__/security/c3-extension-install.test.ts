
import { afterAll, expect, mock, test, beforeAll } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import { ADMIN_USER, MEMBER_USER, createMockEvent, mockServerAlias } from "../helpers/mock-request";

mockServerAlias();
const scopes = () => ({ requireScope: () => null });
mock.module("$lib/server/security/api-keys", scopes);
mock.module("../../../web/src/lib/server/security/api-keys", scopes);
const { POST } = await import("../../../web/src/routes/api/extensions/+server");
afterAll(() => restoreModuleMocks());

test("neither role can install, execute or grant authority through the retired endpoint", async () => {
  for (const user of [ADMIN_USER, MEMBER_USER]) {
    for (const id of ["installation"]) {
      for (const body of [{ source: "local", path: "/tmp/attacker-extension", permissions: { shell: true, filesystem: ["/"], network: true }, enabled: true }, { source: "github", repo: "attacker/extension", permissions: { shell: true }, enabled: true }, { source: "local", path: "/tmp/extension" }]) {
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


import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../helpers/test-pglite";
import { createProject } from "../../db/queries/projects";
import { extensions, extensionSecrets, projectMembers, users } from "../../db/schema";
import { setSecret, deleteSecret } from "../../extensions/secrets-store";
import { resolveProjectSourceCredential } from "../../extensions/source-import";
import type { LifecycleActor } from "../../extensions/v4/types";

mockDbConnection();
const root = await mkdtemp(join(tmpdir(), "ez-source-secret-db-"));
beforeAll(async () => {
  await setupTestDb();
  for (const args of [["init"], ["remote", "add", "origin", "git@github.com:owner/private.git"]]) {
    const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const errors = await new Response(child.stderr).text();
    if (await child.exited !== 0) throw new Error(errors);
  }
});
afterAll(async () => { await closeTestDb(); await rm(root, { recursive: true, force: true }); });

test("production project lookup reads encrypted credentials and observes rotation and account revocation", async () => {
  const database = getTestDb();
  const [user] = await database.insert(users).values({ email: "private-source@example.test", name: "Source owner", passwordHash: "unused", role: "admin", status: "active" }).returning();
  const project = await createProject({ name: "Private repository", path: root }, user!.id);
  const actor: LifecycleActor = { principalId: user!.id, kind: "human", scope: "global" };
  await database.insert(extensions).values({ name: "github-projects", version: "1.0.0", source: "test:fixture", manifest: { schemaVersion: 4, name: "github-projects", version: "1.0.0", description: "Credential fixture", author: { name: "Test" }, permissions: {} } });
  await expect(resolveProjectSourceCredential(actor, "owner/private", project.id)).rejects.toThrow("Configure the host-owned");
  await expect(resolveProjectSourceCredential(actor, "owner/private")).resolves.toBeNull();
  await expect(resolveProjectSourceCredential({ ...actor, kind: "agent" }, "owner/private", project.id)).rejects.toThrow("active human");
  await expect(resolveProjectSourceCredential(actor, "owner/private", "invalid project id!")).rejects.toThrow("valid project");
  await expect(resolveProjectSourceCredential(actor, "owner/private", crypto.randomUUID())).rejects.toThrow("membership");
  await setSecret("github-projects", project.id, "apiToken", "first-private-source-fixture");
  const stored = await database.select().from(extensionSecrets);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.ciphertext).not.toContain("first-private-source-fixture");
  expect(await resolveProjectSourceCredential(actor, "owner/private", project.id)).toBe("first-private-source-fixture");
  await setSecret("github-projects", project.id, "apiToken", "rotated-private-source-fixture");
  expect(await resolveProjectSourceCredential(actor, "owner/private", project.id)).toBe("rotated-private-source-fixture");
  await expect(resolveProjectSourceCredential(actor, "owner/other", project.id)).rejects.toThrow("exact GitHub repository");
  await expect(resolveProjectSourceCredential(actor, "owner/private/extra", project.id)).rejects.toThrow("exact GitHub repository");
  await database.update(users).set({ status: "inactive" }).where(eq(users.id, user!.id));
  await expect(resolveProjectSourceCredential(actor, "owner/private", project.id)).rejects.toThrow("active user");
  await database.update(users).set({ status: "active" }).where(eq(users.id, user!.id));
  await deleteSecret("github-projects", project.id, "apiToken");
  await expect(resolveProjectSourceCredential(actor, "owner/private", project.id)).rejects.toThrow("Configure the host-owned");
  await setSecret("github-projects", project.id, "apiToken", "member-source-fixture");
  await database.update(users).set({ role: "member" }).where(eq(users.id, user!.id));
  expect(await resolveProjectSourceCredential(actor, "owner/private", project.id)).toBe("member-source-fixture");
  await database.delete(projectMembers).where(eq(projectMembers.userId, user!.id));
  await expect(resolveProjectSourceCredential(actor, "owner/private", project.id)).rejects.toThrow("membership");
  await database.insert(projectMembers).values({ userId: user!.id, projectId: project.id, role: "unknown" as never });
  await expect(resolveProjectSourceCredential(actor, "owner/private", project.id)).rejects.toThrow("membership");
  await database.update(projectMembers).set({ role: "member" }).where(eq(projectMembers.userId, user!.id));
  expect(await resolveProjectSourceCredential(actor, "owner/private", project.id)).toBe("member-source-fixture");
  await expect(resolveProjectSourceCredential({ ...actor, principalId: "missing-user" }, "owner/private", project.id)).rejects.toThrow("active user");
});
