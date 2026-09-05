import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { createProject } from "../../db/queries/projects";
import { extensions, extensionSecrets, users } from "../../db/schema";
import { setSecret, deleteSecret } from "../secrets-store";
import { resolveProjectSourceCredential } from "../source-import";
import type { LifecycleActor } from "../v4/types";

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
  await setSecret("github-projects", project.id, "apiToken", "first-private-source-fixture");
  const stored = await database.select().from(extensionSecrets);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.ciphertext).not.toContain("first-private-source-fixture");
  expect(await resolveProjectSourceCredential(actor, "owner/private", project.id)).toBe("first-private-source-fixture");
  await setSecret("github-projects", project.id, "apiToken", "rotated-private-source-fixture");
  expect(await resolveProjectSourceCredential(actor, "owner/private", project.id)).toBe("rotated-private-source-fixture");
  await expect(resolveProjectSourceCredential(actor, "owner/other", project.id)).rejects.toThrow("exact GitHub repository");
  await database.update(users).set({ status: "suspended" }).where(eq(users.id, user!.id));
  await expect(resolveProjectSourceCredential(actor, "owner/private", project.id)).rejects.toThrow("active user");
  await database.update(users).set({ status: "active" }).where(eq(users.id, user!.id));
  await deleteSecret("github-projects", project.id, "apiToken");
  await expect(resolveProjectSourceCredential(actor, "owner/private", project.id)).rejects.toThrow("Configure the host-owned");
});
