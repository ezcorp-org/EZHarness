/**
 * Activating a bundled extension reconciles conversation wiring without
 * a restart.
 *
 * The live failure this pins: `memory-extractor` was disabled for days
 * after a bootstrap failure, so every conversation created in that
 * window carried no `conversation_extensions` row. Re-activating the
 * release used to write `extensions.enabled = true` and stop there —
 * `EventSubscriptionDispatcher.dispatch()` still dropped every
 * `run:complete` for those conversations, and only the create-time hook
 * could ever wire one, which for an existing conversation is never.
 *
 * `publishExtensionGeneration` now reconciles the wiring whenever
 * activation enables one of the auto-wire bundled names. Driven here
 * against a real PGlite database and the real lifecycle repository, so
 * the assertion is on rows, not on a spy.
 *
 * The two negative cases matter as much as the positive one: an
 * ordinary third-party extension must NOT be wired into every
 * conversation, and a DEACTIVATION must not wire anything either.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { ADMIN_USER } from "./helpers/mock-request";

mockDbConnection();
mockRealSettings();

// ExtensionRegistry imports ExtensionProcess at module load and
// `publishExtensionGeneration` reloads the registry. Nothing here
// dispatches into a subprocess, so a no-op stub is enough.
mock.module("../extensions/subprocess", () => ({
  ExtensionProcess: class {
    isRunning = false;
    kill() {}
  },
  parseMemoryLimit: (_: string) => undefined,
}));

import { validateManifest, type ExtensionManifestV4 } from "@ezcorp/extension-contract";
import { eq } from "drizzle-orm";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { getConversationExtensionIds } from "../db/queries/conversation-extensions";
import { createConversation } from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";
import { ExtensionRegistry } from "../extensions/registry";
import { requestedReleaseGrants } from "../extensions/extension-control";
import { getExtensionLifecycle, publishExtensionGeneration } from "../extensions/extension-lifecycle-service";
import { conversationExtensions, conversations, extensions, users } from "../db/schema";
import { releaseRuntimeFixture } from "./helpers/release-runtime";

function buildManifest(name: string): ExtensionManifestV4 {
  return validateManifest({
    schemaVersion: 4,
    name,
    version: "1.0.0",
    description: "Activation wiring fixture",
    author: { name: "test" },
    entrypoint: "./index.js",
    tools: [],
    permissions: { eventSubscriptions: ["run:complete"] },
  });
}

/** Drive a real activation for `name`. `enabled: false` publishes the
 *  DEACTIVATION generation instead, which is the branch that must not
 *  wire anything. */
async function activate(name: string, enabled = true): Promise<string> {
  const manifest = buildManifest(name);
  const fixture = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: ADMIN_USER.id });
  fixture.snapshot.installation.grants = requestedReleaseGrants(manifest);
  fixture.snapshot.installation.enabled = enabled;
  const { installation, release } = fixture.snapshot;
  await new DatabaseLifecycleRepository(getTestDb()).create({ installation, releases: { [release.id]: release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  await publishExtensionGeneration(installation, release);
  return installation.id;
}

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  await getTestDb().insert(users).values({ id: ADMIN_USER.id, email: ADMIN_USER.email, passwordHash: "h", name: ADMIN_USER.name, role: "admin" });
  const project = await createProject({ name: "Activation wiring", path: "/tmp/activation-wiring" });
  projectId = project.id;
  await getExtensionLifecycle();
});

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  ExtensionRegistry.resetInstance();
  const db = getTestDb();
  await db.delete(conversationExtensions);
  await db.delete(conversations);
  await db.delete(extensions);
});

describe("activation reconciles bundled conversation wiring", () => {
  test("enabling memory-extractor wires conversations created while it was absent", async () => {
    // No extension row exists yet, so the create-time hook wires
    // nothing — exactly the state the disabled window leaves behind.
    const before = await createConversation(projectId);
    const alsoBefore = await createConversation(projectId);
    expect(await getConversationExtensionIds(before.id)).toEqual([]);

    const extensionId = await activate("memory-extractor");

    // No restart, no migration: the rows exist the moment activation
    // finishes.
    for (const conv of [before, alsoBefore]) {
      expect(await getConversationExtensionIds(conv.id)).toEqual([extensionId]);
    }
    const row = await getTestDb().select({ enabled: extensions.enabled }).from(extensions).where(eq(extensions.id, extensionId));
    expect(row[0]!.enabled).toBe(true);
  });

  test("activating an ordinary extension wires no conversation", async () => {
    const conv = await createConversation(projectId);

    const extensionId = await activate("ordinary-ext");

    // Auto-wiring is reserved for the narrow bundled list. A
    // third-party activation must never attach itself to every
    // conversation in the database.
    expect(await getConversationExtensionIds(conv.id)).toEqual([]);
    const row = await getTestDb().select({ enabled: extensions.enabled }).from(extensions).where(eq(extensions.id, extensionId));
    expect(row[0]!.enabled).toBe(true);
  });

  test("publishing a deactivation generation for memory-extractor wires no conversation", async () => {
    const conv = await createConversation(projectId);

    await activate("memory-extractor", false);

    // The reconcile is gated on the activation ENABLING the extension.
    // A deactivation generation reaches the same publish function, and
    // wiring every conversation to an extension the operator just
    // switched off would be the opposite of the intent.
    expect(await getConversationExtensionIds(conv.id)).toEqual([]);
    expect(await getTestDb().select().from(conversationExtensions)).toEqual([]);
    // The deactivation branch only UPDATEs an existing projection, so a
    // never-activated installation leaves no `extensions` row behind.
    expect(await getTestDb().select().from(extensions)).toEqual([]);
  });
});
