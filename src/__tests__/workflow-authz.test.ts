/**
 * Unit tests for the shared workflow run/manage authorization rules.
 *
 * Driven against a real migrated PGlite so the extension-liveness re-check
 * and the `created_by` ownership read exercise the actual columns the
 * migration adds — a mocked query layer would pass even if the ALTER never
 * landed.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { extensions, users, workflowDefinitions } = await import("../db/schema");
const { canRunWorkflow, canActOnWorkflow, canManageWorkflow } = await import(
  "../runtime/workflow-authz",
);
const { createWorkflow } = await import("../db/queries/workflows");

import type { WorkflowDefinition } from "../types";
import type { WorkflowPrincipal } from "../runtime/workflow-authz";

const steps = [{ name: "s1", agent: "writer", input: {} as Record<string, string> }];

const owner: WorkflowPrincipal = { id: "u-owner", role: "member" };
const stranger: WorkflowPrincipal = { id: "u-stranger", role: "member" };
const admin: WorkflowPrincipal = { id: "u-admin", role: "admin" };

function def(over: Partial<WorkflowDefinition>): WorkflowDefinition {
  return { name: "w", description: "", steps: steps as never, ...over };
}

async function seedUser(id: string, role: "admin" | "member"): Promise<void> {
  await getTestDb().insert(users).values({
    id,
    email: `${id}@example.com`,
    passwordHash: "h",
    name: id,
    role,
  });
}

/**
 * Create a workflow row and stamp upstream's `created_by` owner on it.
 *
 * `createWorkflow` deliberately no longer accepts an author: the merged
 * create path writes ownership to `user_id`/`visibility` and leaves
 * `created_by` NULL. These tests are about upstream's `created_by` rule
 * specifically, so they set the column directly rather than asserting
 * against a writer that would never populate it — which would make every
 * denial below pass for the wrong reason.
 */
async function seedOwnedWorkflow(name: string, createdBy: string): Promise<void> {
  const { eq } = await import("drizzle-orm");
  await createWorkflow({ name, description: "", steps: steps as never });
  await getTestDb()
    .update(workflowDefinitions)
    .set({ createdBy })
    .where(eq(workflowDefinitions.name, name));
}

async function seedExtension(name: string, enabled: boolean): Promise<void> {
  await getTestDb().insert(extensions).values({
    name,
    version: "0.0.1",
    description: "",
    manifest: {
      schemaVersion: 2,
      name,
      version: "0.0.1",
      description: "",
      author: { name: "t" },
      permissions: {},
    } as never,
    source: "test",
    enabled,
    grantedPermissions: {} as never,
  });
}

describe("canActOnWorkflow", () => {
  test("an unowned (NULL created_by) row is actionable by anyone", () => {
    expect(canActOnWorkflow(null, stranger)).toBe(true);
    expect(canActOnWorkflow(undefined, stranger)).toBe(true);
    // Empty string is the same "no owner recorded" state, not a user id.
    expect(canActOnWorkflow("", stranger)).toBe(true);
  });

  test("an owned row is actionable by its owner", () => {
    expect(canActOnWorkflow("u-owner", owner)).toBe(true);
  });

  test("an owned row is actionable by an instance admin", () => {
    expect(canActOnWorkflow("u-owner", admin)).toBe(true);
  });

  test("an owned row is NOT actionable by another member", () => {
    expect(canActOnWorkflow("u-owner", stranger)).toBe(false);
  });
});

describe("canRunWorkflow", () => {
  beforeEach(async () => {
    await setupTestDb();
    await seedUser("u-owner", "member");
    await seedUser("u-stranger", "member");
    await seedUser("u-admin", "admin");
  });
  afterAll(async () => await closeTestDb());

  // ── Rule 4: the permissive default ──────────────────────────────

  test("allows a YAML workflow for any caller", async () => {
    const decision = await canRunWorkflow(def({ name: "demo", source: "yaml" }), stranger);
    expect(decision).toEqual({ allowed: true });
  });

  test("allows a hand-built definition with no source at all", async () => {
    const decision = await canRunWorkflow(def({ name: "adhoc" }), stranger);
    expect(decision).toEqual({ allowed: true });
  });

  test("a leading separator names no extension and stays permissive", async () => {
    const decision = await canRunWorkflow(def({ name: ":odd" }), stranger);
    expect(decision).toEqual({ allowed: true });
  });

  test("allows a DB workflow whose row has no owner (legacy / global)", async () => {
    await createWorkflow({ name: "legacy", description: "", steps: steps as never });
    const decision = await canRunWorkflow(def({ name: "legacy", source: "db" }), stranger);
    expect(decision).toEqual({ allowed: true });
  });

  test("allows a source:db definition whose row has since been deleted", async () => {
    const decision = await canRunWorkflow(def({ name: "vanished", source: "db" }), stranger);
    expect(decision).toEqual({ allowed: true });
  });

  // ── Rule 2: DB ownership ────────────────────────────────────────

  test("allows the owner to run their own DB workflow", async () => {
    await seedOwnedWorkflow("mine", "u-owner");
    const decision = await canRunWorkflow(def({ name: "mine", source: "db" }), owner);
    expect(decision).toEqual({ allowed: true });
  });

  test("allows an admin to run someone else's DB workflow", async () => {
    await seedOwnedWorkflow("mine", "u-owner");
    const decision = await canRunWorkflow(def({ name: "mine", source: "db" }), admin);
    expect(decision).toEqual({ allowed: true });
  });

  test("denies another member, naming the workflow", async () => {
    await seedOwnedWorkflow("mine", "u-owner");
    const decision = await canRunWorkflow(def({ name: "mine", source: "db" }), stranger);
    expect(decision).toEqual({
      allowed: false,
      reason: 'Workflow "mine" is owned by another user',
    });
  });

  test("ownership is read LIVE from the row, not from the cached definition", async () => {
    await seedOwnedWorkflow("mine", "u-owner");
    // The caller hands over a stale definition; the row is what decides.
    const decision = await canRunWorkflow(
      def({ name: "mine", description: "stale copy", source: "db" }),
      stranger,
    );
    expect(decision.allowed).toBe(false);
  });

  test("a source:yaml definition is NOT gated by a same-named DB row", async () => {
    // YAML wins execution on a name collision, so authz must decide about
    // the YAML entry — gating it on the DB row's owner would deny a run of
    // an object that row has nothing to do with.
    await seedOwnedWorkflow("collide", "u-owner");
    const decision = await canRunWorkflow(def({ name: "collide", source: "yaml" }), stranger);
    expect(decision).toEqual({ allowed: true });
  });

  // ── Rule 1: extension liveness ──────────────────────────────────

  test("allows an extension workflow while its extension is installed and enabled", async () => {
    await seedExtension("my-ext", true);
    const decision = await canRunWorkflow(
      def({ name: "my-ext:deploy", source: "extension" }),
      stranger,
    );
    expect(decision).toEqual({ allowed: true });
  });

  test("denies an extension workflow when the extension is disabled", async () => {
    await seedExtension("my-ext", false);
    const decision = await canRunWorkflow(
      def({ name: "my-ext:deploy", source: "extension" }),
      admin,
    );
    expect(decision).toEqual({
      allowed: false,
      reason: 'Workflow "my-ext:deploy" belongs to extension "my-ext", which is disabled',
    });
  });

  test("denies an extension workflow when the extension is not installed", async () => {
    const decision = await canRunWorkflow(
      def({ name: "ghost-ext:deploy", source: "extension" }),
      admin,
    );
    expect(decision).toEqual({
      allowed: false,
      reason:
        'Workflow "ghost-ext:deploy" belongs to extension "ghost-ext", which is not installed',
    });
  });

  test("the extension check runs off the NAME, so a squatting DB row is held to it", async () => {
    // A `chat`-scoped user creates `my-ext:deploy` in workflow_definitions.
    // The merged cache puts real extension assets first, but once that
    // extension is uninstalled the squatter surfaces — and must not run.
    await seedOwnedWorkflow("my-ext:deploy", "u-owner");
    const decision = await canRunWorkflow(
      def({ name: "my-ext:deploy", source: "db" }),
      owner,
    );
    expect(decision.allowed).toBe(false);
  });

  test("the extension check precedes the ownership check", async () => {
    // Disabled extension + a row the caller owns: the extension rule wins,
    // mirroring the cache's [...extension, ...yaml, ...db] precedence.
    await seedExtension("my-ext", false);
    await seedOwnedWorkflow("my-ext:deploy", "u-owner");
    const decision = await canRunWorkflow(def({ name: "my-ext:deploy", source: "db" }), owner);
    expect(decision).toEqual({
      allowed: false,
      reason: 'Workflow "my-ext:deploy" belongs to extension "my-ext", which is disabled',
    });
  });

  test("deleting the owner un-owns the workflow rather than orphaning the FK", async () => {
    const { eq } = await import("drizzle-orm");
    await seedOwnedWorkflow("mine", "u-owner");
    await getTestDb().delete(users).where(eq(users.id, "u-owner"));

    const rows = await getTestDb()
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "mine"));
    expect(rows[0]!.createdBy).toBeNull();

    // ON DELETE SET NULL ⇒ the row degrades to global, still runnable.
    const decision = await canRunWorkflow(def({ name: "mine", source: "db" }), stranger);
    expect(decision).toEqual({ allowed: true });
  });
});

describe("canManageWorkflow", () => {
  // The predicate `GET /api/workflows` serves as `canManage`. It must be
  // exactly the conjunction PUT/DELETE enforce, or the UI paints an Edit
  // button that only ever 403s (or 404s).
  test("allows the owner of a DB workflow", () => {
    expect(canManageWorkflow({ source: "db" }, "u-owner", owner)).toBe(true);
  });

  test("allows an admin over another user's DB workflow", () => {
    expect(canManageWorkflow({ source: "db" }, "u-owner", admin)).toBe(true);
  });

  test("denies a stranger", () => {
    expect(canManageWorkflow({ source: "db" }, "u-owner", stranger)).toBe(false);
  });

  test("allows anyone on an unowned legacy row", () => {
    // NULL created_by predates the column; those stay editable by anyone,
    // which is what makes the migration non-breaking.
    expect(canManageWorkflow({ source: "db" }, null, stranger)).toBe(true);
    expect(canManageWorkflow({ source: "db" }, undefined, stranger)).toBe(true);
  });

  test("denies YAML and extension-shipped workflows outright", () => {
    // Files on disk — PUT/DELETE resolve through getWorkflowByName and 404.
    // Even the admin cannot write them through the API.
    expect(canManageWorkflow({ source: "yaml" }, null, admin)).toBe(false);
    expect(canManageWorkflow({ source: "extension" }, null, admin)).toBe(false);
  });

  test("denies a definition with no source", () => {
    // Hand-built definitions have no row to update; fail closed.
    expect(canManageWorkflow({}, null, admin)).toBe(false);
  });
});
