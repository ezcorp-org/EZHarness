/**
 * Coverage for the host-side extension-secrets store
 * (`src/extensions/secrets-store.ts`).
 *
 * Exercises every branch: set→get round-trip + SECRET_SET audit; get miss /
 * decrypt-fail → null; the lastUsedAt debounce (touch+SECRET_USED gating);
 * hasSecret true/false; deleteSecret hit (SECRET_DELETED) / miss;
 * listSecretMeta (no ciphertext); and the github-projects backfill —
 * success, decrypt-failure, and idempotency.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../__tests__/helpers/test-pglite";

mockDbConnection();

import {
  setSecret,
  getSecret,
  hasSecret,
  deleteSecret,
  listSecretMeta,
  backfillGithubProjectsApiTokens,
} from "../secrets-store";
import { encrypt, decryptWithAad } from "../../providers/encryption";
import { getSecretRow } from "../../db/queries/extension-secrets";
import { extensions, extensionSecrets, projects, settings, auditLog, users } from "../../db/schema";
import { eq, sql } from "drizzle-orm";

const EXT_ID = "test-ext";
const GH_EXT = "github-projects";
const USER_ID = "33333333-3333-3333-3333-333333333333";
let projectId: string;

async function seedExtension(name: string): Promise<void> {
  await getTestDb().insert(extensions).values({
    name,
    version: "1.0.0",
    source: "test:fixture",
    manifest: sql`${JSON.stringify({
      schemaVersion: 2,
      name,
      version: "1.0.0",
      description: "",
      author: { name: "test" },
      kind: "subprocess",
      entrypoint: { command: ["true"] },
    })}::jsonb`,
  });
}

async function seed(): Promise<void> {
  await seedExtension(EXT_ID);
  const rows = await getTestDb()
    .insert(projects)
    .values({ name: "Secrets Project", path: "/tmp/secrets" })
    .returning({ id: projects.id });
  projectId = rows[0]!.id;
  // FK parent for user-scoped secrets (setSecret/deleteSecret pass userId).
  await getTestDb().insert(users).values({
    id: USER_ID,
    email: "secrets-store@example.com",
    passwordHash: "x",
    name: "Secrets Store User",
  });
}

async function auditRows(action: string) {
  return getTestDb().select().from(auditLog).where(eq(auditLog.action, action));
}

beforeEach(async () => {
  await setupTestDb();
  await seed();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("setSecret / getSecret", () => {
  test("round-trips the plaintext (global scope) and writes a SECRET_SET audit row", async () => {
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_live");
    expect(await getSecret(EXT_ID, projectId, "apiToken")).toBe("ghp_live");

    const sets = await auditRows("ext:secret-set");
    expect(sets).toHaveLength(1);
    expect(sets[0]!.target).toBe(EXT_ID);
    expect(sets[0]!.userId).toBeNull(); // no opts.userId → system actor
    expect(sets[0]!.metadata).toMatchObject({ projectId, name: "apiToken" });
    // The plaintext value must NEVER appear in the audit metadata.
    expect(JSON.stringify(sets[0]!.metadata)).not.toContain("ghp_live");
  });

  test("user-scoped secret: actor + scope are the supplied userId, round-trips under that userId", async () => {
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_user", { userId: USER_ID });
    // A user-scoped secret is a DISTINCT slot from the global one — reading
    // without the userId misses; reading with it hits.
    expect(await getSecret(EXT_ID, projectId, "apiToken")).toBeNull();
    expect(await getSecret(EXT_ID, projectId, "apiToken", { userId: USER_ID })).toBe("ghp_user");
    const sets = await auditRows("ext:secret-set");
    expect(sets[0]!.userId).toBe(USER_ID);
  });

  test("ciphertext is AAD-bound to the scope (stored row decrypts only under its scope)", async () => {
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_live");
    const row = await getSecretRow({ extensionId: EXT_ID, projectId, userId: null, name: "apiToken" });
    expect(decryptWithAad(row!.ciphertext, `${EXT_ID}:${projectId}`)).toBe("ghp_live");
    expect(() => decryptWithAad(row!.ciphertext, `${EXT_ID}:other`)).toThrow();
  });

  test("getSecret returns null on a miss", async () => {
    expect(await getSecret(EXT_ID, projectId, "nope")).toBeNull();
  });

  test("getSecret returns null when the ciphertext fails to decrypt (tampered row)", async () => {
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_live");
    // Corrupt the stored ciphertext in place.
    await getTestDb()
      .update(extensionSecrets)
      .set({ ciphertext: "v1:deadbeef:deadbeef:deadbeef" })
      .where(eq(extensionSecrets.name, "apiToken"));
    expect(await getSecret(EXT_ID, projectId, "apiToken")).toBeNull();
  });

  test("rotation: a second setSecret replaces the value", async () => {
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_old");
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_new");
    expect(await getSecret(EXT_ID, projectId, "apiToken")).toBe("ghp_new");
  });
});

describe("getSecret lastUsedAt debounce", () => {
  test("touches + audits SECRET_USED when lastUsedAt is stale (>60s)", async () => {
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_live");
    // Backdate lastUsedAt to 2 minutes ago.
    const twoMinAgo = new Date(Date.now() - 120_000);
    await getTestDb()
      .update(extensionSecrets)
      .set({ lastUsedAt: twoMinAgo })
      .where(eq(extensionSecrets.name, "apiToken"));

    expect(await getSecret(EXT_ID, projectId, "apiToken")).toBe("ghp_live");
    const used = await auditRows("ext:secret-used");
    expect(used).toHaveLength(1);
    const row = await getSecretRow({ extensionId: EXT_ID, projectId, userId: null, name: "apiToken" });
    expect(row!.lastUsedAt!.getTime()).toBeGreaterThan(twoMinAgo.getTime());
  });

  test("does NOT touch / re-audit when lastUsedAt is fresh (<60s)", async () => {
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_live");
    await getTestDb()
      .update(extensionSecrets)
      .set({ lastUsedAt: new Date() })
      .where(eq(extensionSecrets.name, "apiToken"));

    expect(await getSecret(EXT_ID, projectId, "apiToken")).toBe("ghp_live");
    expect(await auditRows("ext:secret-used")).toHaveLength(0);
  });
});

describe("hasSecret", () => {
  test("true when present + decryptable", async () => {
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_live");
    expect(await hasSecret(EXT_ID, projectId, "apiToken")).toBe(true);
  });

  test("false when absent", async () => {
    expect(await hasSecret(EXT_ID, projectId, "apiToken")).toBe(false);
  });

  test("false when present but undecryptable", async () => {
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_live");
    await getTestDb()
      .update(extensionSecrets)
      .set({ ciphertext: "v1:dead:beef:cafe" })
      .where(eq(extensionSecrets.name, "apiToken"));
    expect(await hasSecret(EXT_ID, projectId, "apiToken")).toBe(false);
  });
});

describe("deleteSecret", () => {
  test("hit: removes the row and audits SECRET_DELETED", async () => {
    await setSecret(EXT_ID, projectId, "apiToken", "ghp_live", { userId: USER_ID });
    expect(await deleteSecret(EXT_ID, projectId, "apiToken", { userId: USER_ID })).toBe(true);
    expect(await getSecret(EXT_ID, projectId, "apiToken", { userId: USER_ID })).toBeNull();
    const del = await auditRows("ext:secret-deleted");
    expect(del).toHaveLength(1);
    expect(del[0]!.userId).toBe(USER_ID);
  });

  test("miss: returns false and writes no audit row", async () => {
    expect(await deleteSecret(EXT_ID, projectId, "apiToken")).toBe(false);
    expect(await auditRows("ext:secret-deleted")).toHaveLength(0);
  });
});

describe("listSecretMeta", () => {
  test("returns metadata, never the ciphertext", async () => {
    await setSecret(EXT_ID, null, "apiToken", "ghp_global");
    await setSecret(EXT_ID, projectId, "webhook", "ghp_proj");
    const all = await listSecretMeta(EXT_ID);
    expect(all).toHaveLength(2);
    for (const m of all) {
      expect(m).not.toHaveProperty("ciphertext");
    }
    const projOnly = await listSecretMeta(EXT_ID, { projectId });
    expect(projOnly).toHaveLength(1);
    expect(projOnly[0]!.name).toBe("webhook");
  });
});

describe("backfillGithubProjectsApiTokens", () => {
  test("migrates a decryptable PAT, deletes the settings key, returns counts", async () => {
    await seedExtension(GH_EXT);
    const key = `githubProjects:${projectId}:apiToken`;
    await getTestDb().insert(settings).values({ key, value: encrypt("ghp_live") });

    const result = await backfillGithubProjectsApiTokens();
    expect(result).toEqual({ migrated: 1, cleared: 1 });

    // The migrated secret decrypts under the github-projects scope AAD.
    const row = await getSecretRow({ extensionId: GH_EXT, projectId, userId: null, name: "apiToken" });
    expect(row).toBeDefined();
    expect(decryptWithAad(row!.ciphertext, `${GH_EXT}:${projectId}`)).toBe("ghp_live");

    // The broadly-readable settings key is gone.
    const left = await getTestDb().select().from(settings).where(eq(settings.key, key));
    expect(left).toHaveLength(0);
  });

  test("decrypt-failure: clears the settings key but inserts no secret row", async () => {
    await seedExtension(GH_EXT);
    const key = `githubProjects:${projectId}:apiToken`;
    await getTestDb().insert(settings).values({ key, value: "not-a-valid-ciphertext" });

    const result = await backfillGithubProjectsApiTokens();
    expect(result).toEqual({ migrated: 0, cleared: 1 });

    const row = await getSecretRow({ extensionId: GH_EXT, projectId, userId: null, name: "apiToken" });
    expect(row).toBeUndefined();
    const left = await getTestDb().select().from(settings).where(eq(settings.key, key));
    expect(left).toHaveLength(0);
  });

  test("idempotent: a second run finds no matching keys", async () => {
    await seedExtension(GH_EXT);
    const key = `githubProjects:${projectId}:apiToken`;
    await getTestDb().insert(settings).values({ key, value: encrypt("ghp_live") });

    await backfillGithubProjectsApiTokens();
    const second = await backfillGithubProjectsApiTokens();
    expect(second).toEqual({ migrated: 0, cleared: 0 });
  });

  test("uses a passed executor handle (the migrate path) without getDb()", async () => {
    await seedExtension(GH_EXT);
    const key = `githubProjects:${projectId}:apiToken`;
    // A valid PAT encrypted with the PLAIN encrypt() (the legacy on-disk form).
    await getTestDb().insert(settings).values({ key, value: encrypt("ghp_via_handle") });
    // Pass an explicit executor handle — proves the parameter path (the
    // migrate pass supplies its own db handle rather than relying on getDb()).
    const result = await backfillGithubProjectsApiTokens(getTestDb());
    expect(result).toEqual({ migrated: 1, cleared: 1 });
    const row = await getSecretRow({ extensionId: GH_EXT, projectId, userId: null, name: "apiToken" });
    expect(decryptWithAad(row!.ciphertext, `${GH_EXT}:${projectId}`)).toBe("ghp_via_handle");
    const left = await getTestDb().select().from(settings).where(eq(settings.key, key));
    expect(left).toHaveLength(0);
  });
});
