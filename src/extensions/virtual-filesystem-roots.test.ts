import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";
import { conversations, projectMembers, projects, users } from "../db/schema";
import { extensionDataDir } from "./extension-data-dir";
import { productionFilesystemPorts } from "./virtual-filesystem";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

test("production virtual roots enforce current user, conversation ownership and project membership", async () => {
  const database = getTestDb();
  const [owner, outsider, admin] = await database.insert(users).values([
    { email: "fs-owner@test.local", name: "Owner", passwordHash: "fixture", role: "member", status: "active" },
    { email: "fs-outsider@test.local", name: "Outsider", passwordHash: "fixture", role: "member", status: "active" },
    { email: "fs-admin@test.local", name: "Admin", passwordHash: "fixture", role: "admin", status: "active" },
  ]).returning();
  const [project] = await database.insert(projects).values({ name: "Private", path: "/private-project" }).returning();
  const [conversation] = await database.insert(conversations).values({ projectId: project!.id, userId: owner!.id }).returning();
  const identity = { extensionId: "installation", extensionName: "fixture", userId: owner!.id, conversationId: conversation!.id };
  const roots = (overrides: Partial<typeof identity> = {}) => productionFilesystemPorts.roots({ ...identity, ...overrides });
  await expect(roots({ extensionName: "../other" })).rejects.toThrow("namespace");
  await expect(roots({ userId: "missing" })).rejects.toThrow("Active user");
  expect(await productionFilesystemPorts.roots({ ...identity, conversationId: null })).toEqual({ data: extensionDataDir("fixture") });
  await expect(roots({ conversationId: "missing" })).rejects.toThrow("Conversation access");
  await expect(roots({ userId: outsider!.id })).rejects.toThrow("Conversation access");
  await expect(roots()).rejects.toThrow("Project membership");
  expect(await roots({ userId: admin!.id })).toEqual({ data: extensionDataDir("fixture"), project: "/private-project" });
  await database.insert(projectMembers).values({ projectId: project!.id, userId: owner!.id });
  expect(await roots()).toEqual({ data: extensionDataDir("fixture"), project: "/private-project" });
  await database.update(projects).set({ path: "" }).where(eq(projects.id, project!.id));
  await expect(roots()).rejects.toThrow("Project root unavailable");
  await database.delete(projectMembers).where(eq(projectMembers.userId, owner!.id));
  await expect(roots()).rejects.toThrow("Project membership");
  await database.update(users).set({ status: "inactive" }).where(eq(users.id, owner!.id));
  await expect(roots()).rejects.toThrow("Active user");
});
