import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";
import { sql } from "drizzle-orm";

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");
const { createAgentConfig } = await import("../db/queries/agent-configs");

const BACKFILL_CONVERSATIONS = sql`
  UPDATE conversations SET user_id = (
    SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1
  ) WHERE user_id IS NULL`;

const BACKFILL_AGENT_CONFIGS = sql`
  UPDATE agent_configs SET user_id = (
    SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1
  ) WHERE user_id IS NULL`;

describe("Auth Migration — Data backfill", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  test("assigns ownerless conversations to admin user", async () => {
    const db = getTestDb();
    const project = await createProject({ name: "Test", path: "/tmp/test" });
    const convId = crypto.randomUUID();

    // Insert ownerless conversation
    await db.execute(
      sql`INSERT INTO conversations (id, project_id, title) VALUES (${convId}, ${project.id}, 'ownerless conv')`
    );

    // Create admin user
    const admin = await createUser({ email: "admin@test.com", passwordHash: "hash", name: "Admin", role: "admin" });

    // Run backfill
    await db.execute(BACKFILL_CONVERSATIONS);

    // Verify
    const rows = await db.execute(sql`SELECT user_id FROM conversations WHERE id = ${convId}`);
    expect(at(rows.rows, 0, "conversations row").user_id).toBe(admin.id);
  });

  test("assigns ownerless agent_configs to admin user", async () => {
    const db = getTestDb();

    // Insert ownerless agent config via raw SQL (createAgentConfig would set userId)
    const agentId = crypto.randomUUID();
    await db.execute(
      sql`INSERT INTO agent_configs (id, name, description, prompt, created_at, updated_at)
          VALUES (${agentId}, ${"Ownerless Agent"}, ${"desc"}, ${"prompt"}, NOW(), NOW())`
    );

    const admin = await createUser({ email: "admin2@test.com", passwordHash: "hash", name: "Admin", role: "admin" });

    await db.execute(BACKFILL_AGENT_CONFIGS);

    const rows = await db.execute(sql`SELECT user_id FROM agent_configs WHERE id = ${agentId}`);
    expect(at(rows.rows, 0, "agent_configs row").user_id).toBe(admin.id);
  });

  test("backfill is idempotent (running twice does not change already-assigned records)", async () => {
    const db = getTestDb();
    const project = await createProject({ name: "Idem", path: "/tmp/idem" });
    const convId = crypto.randomUUID();

    await db.execute(
      sql`INSERT INTO conversations (id, project_id, title) VALUES (${convId}, ${project.id}, 'idem test')`
    );

    const admin = await createUser({ email: "admin3@test.com", passwordHash: "hash", name: "Admin", role: "admin" });

    // Run backfill twice
    await db.execute(BACKFILL_CONVERSATIONS);
    await db.execute(BACKFILL_CONVERSATIONS);

    const rows = await db.execute(sql`SELECT user_id FROM conversations WHERE id = ${convId}`);
    expect(at(rows.rows, 0, "idempotent conversations row").user_id).toBe(admin.id);
  });

  test("backfill is no-op when no admin user exists (user_id stays NULL)", async () => {
    const db = getTestDb();
    const project = await createProject({ name: "NoAdmin", path: "/tmp/noadmin" });
    const convId = crypto.randomUUID();

    await db.execute(
      sql`INSERT INTO conversations (id, project_id, title) VALUES (${convId}, ${project.id}, 'no admin')`
    );

    // No admin user created — run backfill
    await db.execute(BACKFILL_CONVERSATIONS);

    const rows = await db.execute(sql`SELECT user_id FROM conversations WHERE id = ${convId}`);
    expect(at(rows.rows, 0, "no-admin conversations row").user_id).toBeNull();
  });

  test("records that already have a user_id are NOT overwritten", async () => {
    const db = getTestDb();
    const project = await createProject({ name: "Owned", path: "/tmp/owned" });

    // Create a regular user who owns the conversation
    const regularUser = await createUser({ email: "regular@test.com", passwordHash: "hash", name: "Regular", role: "member" });

    const convId = crypto.randomUUID();
    await db.execute(
      sql`INSERT INTO conversations (id, project_id, title, user_id) VALUES (${convId}, ${project.id}, 'owned conv', ${regularUser.id})`
    );

    // Create admin
    const admin = await createUser({ email: "admin4@test.com", passwordHash: "hash", name: "Admin", role: "admin" });

    // Run backfill
    await db.execute(BACKFILL_CONVERSATIONS);

    // Should still belong to regular user, NOT admin
    const rows = await db.execute(sql`SELECT user_id FROM conversations WHERE id = ${convId}`);
    expect(at(rows.rows, 0, "owned conversations row").user_id).toBe(regularUser.id);
  });
});
