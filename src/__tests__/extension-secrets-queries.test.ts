import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import {
  getSecretRow,
  insertOrReplaceSecret,
  deleteSecret,
  touchLastUsed,
  listSecretMeta,
} from "../db/queries/extension-secrets";
import type { SecretScope } from "../db/queries/extension-secrets";
import { extensions, projects, users } from "../db/schema";
import { sql } from "drizzle-orm";

const EXT_ID = "test-ext";
const USER_ID = "22222222-2222-2222-2222-222222222222";
let projectId: string;

// Seed the FK parent rows: an `extensions` row whose `name` is the slug the
// secrets reference, a `projects` row, and a `users` row (for user-scoped
// secrets).
async function seed(): Promise<void> {
  const db = getTestDb();
  await db.insert(extensions).values({
    name: EXT_ID,
    version: "1.0.0",
    source: "test:fixture",
    manifest: sql`${JSON.stringify({
      schemaVersion: 2,
      name: EXT_ID,
      version: "1.0.0",
      description: "",
      author: { name: "test" },
      kind: "subprocess",
      entrypoint: { command: ["true"] },
    })}::jsonb`,
  });
  const projRows = await db
    .insert(projects)
    .values({ name: "Secrets Project", path: "/tmp/secrets" })
    .returning({ id: projects.id });
  projectId = projRows[0]!.id;
  await db.insert(users).values({
    id: USER_ID,
    email: "secrets@example.com",
    passwordHash: "x",
    name: "Secrets User",
  });
}

function globalScope(name = "apiToken"): SecretScope {
  return { extensionId: EXT_ID, projectId: null, userId: null, name };
}

function projectScope(name = "apiToken"): SecretScope {
  return { extensionId: EXT_ID, projectId, userId: null, name };
}

beforeEach(async () => {
  await setupTestDb();
  await seed();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("getSecretRow", () => {
  test("returns undefined on a miss", async () => {
    expect(await getSecretRow(globalScope())).toBeUndefined();
  });

  test("returns the row on a hit (null-scope columns addressed via IS NULL)", async () => {
    await insertOrReplaceSecret(globalScope(), "ct-A");
    const row = await getSecretRow(globalScope());
    expect(row).toBeDefined();
    expect(row!.ciphertext).toBe("ct-A");
    expect(row!.projectId).toBeNull();
    expect(row!.userId).toBeNull();
    expect(row!.rotatedAt).toBeNull();
  });

  test("distinguishes scopes (global vs project) at the same name", async () => {
    await insertOrReplaceSecret(globalScope(), "ct-global");
    await insertOrReplaceSecret(projectScope(), "ct-project");
    expect((await getSecretRow(globalScope()))!.ciphertext).toBe("ct-global");
    expect((await getSecretRow(projectScope()))!.ciphertext).toBe("ct-project");
  });
});

describe("insertOrReplaceSecret", () => {
  test("insert path: creates a fresh row with rotatedAt null", async () => {
    await insertOrReplaceSecret(projectScope(), "ct-1");
    const row = await getSecretRow(projectScope());
    expect(row!.ciphertext).toBe("ct-1");
    expect(row!.rotatedAt).toBeNull();
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  test("update path: replaces ciphertext + stamps rotatedAt, keeps the id", async () => {
    await insertOrReplaceSecret(projectScope(), "ct-1");
    const first = await getSecretRow(projectScope());
    await insertOrReplaceSecret(projectScope(), "ct-2");
    const second = await getSecretRow(projectScope());
    expect(second!.id).toBe(first!.id);
    expect(second!.ciphertext).toBe("ct-2");
    expect(second!.rotatedAt).toBeInstanceOf(Date);
  });
});

describe("deleteSecret", () => {
  test("hit: returns true and removes the row", async () => {
    await insertOrReplaceSecret(globalScope(), "ct");
    expect(await deleteSecret(globalScope())).toBe(true);
    expect(await getSecretRow(globalScope())).toBeUndefined();
  });

  test("miss: returns false", async () => {
    expect(await deleteSecret(globalScope())).toBe(false);
  });
});

describe("touchLastUsed", () => {
  test("stamps lastUsedAt on the addressed row", async () => {
    await insertOrReplaceSecret(globalScope(), "ct");
    expect((await getSecretRow(globalScope()))!.lastUsedAt).toBeNull();
    await touchLastUsed(globalScope());
    expect((await getSecretRow(globalScope()))!.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe("listSecretMeta", () => {
  test("returns metadata for the extension, never the ciphertext", async () => {
    await insertOrReplaceSecret(globalScope("apiToken"), "ct-1");
    await insertOrReplaceSecret(projectScope("webhook"), "ct-2");
    const meta = await listSecretMeta({ extensionId: EXT_ID });
    expect(meta).toHaveLength(2);
    for (const m of meta) {
      expect(m).not.toHaveProperty("ciphertext");
      expect(m.name).toBeDefined();
      expect(m.createdAt).toBeInstanceOf(Date);
    }
  });

  test("filters to a project when projectId is supplied", async () => {
    await insertOrReplaceSecret(globalScope("apiToken"), "ct-1");
    await insertOrReplaceSecret(projectScope("webhook"), "ct-2");
    const projOnly = await listSecretMeta({ extensionId: EXT_ID, projectId });
    expect(projOnly).toHaveLength(1);
    expect(projOnly[0]!.name).toBe("webhook");
    expect(projOnly[0]!.projectId).toBe(projectId);

    const globalOnly = await listSecretMeta({ extensionId: EXT_ID, projectId: null });
    expect(globalOnly).toHaveLength(1);
    expect(globalOnly[0]!.name).toBe("apiToken");
    expect(globalOnly[0]!.projectId).toBeNull();
  });
});
