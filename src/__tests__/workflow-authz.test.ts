/**
 * Unit tests for the shared workflow run/manage authorization entry points.
 *
 * These used to drive a SECOND authorization model — a `created_by` column
 * whose NULL meant "unowned, anyone may act". That column is gone, and the
 * entry points here are now adapters over the one ladder in
 * `workflow-scope.ts` (`user_id` + `visibility`), where a NULL owner on a
 * `private` row means the opposite: admin-only. The rewritten assertions
 * below are the ladder's answers, not the old rule's.
 *
 * The ladder's own matrix is exhaustively covered in `workflow-scope.test.ts`;
 * what is specific to THIS module, and is what these pin, is:
 *   - the extension-liveness re-check, which the ladder has no notion of;
 *   - that it runs FIRST, so a dead extension beats even an admin;
 *   - that both entry points reach the ladder rather than re-deciding.
 *
 * Driven against a real migrated PGlite so the liveness re-check reads the
 * actual `extensions` table — a mocked query layer would pass even if the
 * migration never landed.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { extensions, users } = await import("../db/schema");
const { canRunWorkflow, canManageWorkflow } = await import("../runtime/workflow-authz");

import type { WorkflowVisibility } from "../types";
import type { CachedWorkflow } from "../runtime/workflow-scope";
import type { WorkflowPrincipal } from "../runtime/workflow-authz";

const steps = [{ name: "s1", agent: "writer", input: {} as Record<string, string> }];

const owner: WorkflowPrincipal = { id: "u-owner", role: "member" };
const stranger: WorkflowPrincipal = { id: "u-stranger", role: "member" };
const admin: WorkflowPrincipal = { id: "u-admin", role: "admin" };

/**
 * A cache entry. Defaults to the `system` shape every pre-C6 row migrates
 * to — open to read and run, admin-only to edit.
 */
function entry(over: Partial<CachedWorkflow> & { name?: string } = {}): CachedWorkflow {
  const { name = "w", ...rest } = over;
  return {
    definition: { name, description: "", steps: steps as never },
    source: "db",
    id: "wf-1",
    projectId: null,
    userId: null,
    visibility: "system" as WorkflowVisibility,
    forkedFrom: null,
    ...rest,
  };
}

/** An entry `u-owner` owns privately — readable and runnable by them and
 *  by an admin, by nobody else. */
function privateEntry(name = "mine"): CachedWorkflow {
  return entry({ name, visibility: "private", userId: "u-owner" });
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

describe("canRunWorkflow", () => {
  beforeEach(async () => {
    await setupTestDb();
    await seedUser("u-owner", "member");
    await seedUser("u-stranger", "member");
    await seedUser("u-admin", "admin");
  });
  afterAll(async () => await closeTestDb());

  // ── The ladder's `run` rung ─────────────────────────────────────

  test("allows any caller to run a system workflow", async () => {
    // Every row that existed before the ladder is `system`, which is what
    // makes adding it non-breaking for RUN.
    expect(await canRunWorkflow(entry({ name: "demo" }), stranger)).toEqual({ allowed: true });
  });

  test("allows a YAML asset, which ships with the install", async () => {
    const yaml = entry({ name: "demo", source: "yaml", id: null });
    expect(await canRunWorkflow(yaml, stranger)).toEqual({ allowed: true });
  });

  test("allows the owner to run their own private workflow", async () => {
    expect(await canRunWorkflow(privateEntry(), owner)).toEqual({ allowed: true });
  });

  test("allows an admin to run someone else's private workflow", async () => {
    expect(await canRunWorkflow(privateEntry(), admin)).toEqual({ allowed: true });
  });

  test("denies another member, naming the workflow", async () => {
    expect(await canRunWorkflow(privateEntry(), stranger)).toEqual({
      allowed: false,
      reason: 'Workflow "mine" is not available to this user',
    });
  });

  test("an ORPHANED private row is admin-only, not public", async () => {
    // The load-bearing difference from the rule this module used to hold.
    // `user_id` is `ON DELETE SET NULL`, so deleting the owner leaves a
    // private row with a NULL owner. The old `created_by` rule read NULL as
    // "unowned — anyone may act", which would hand a departed employee's
    // private workflow to every authenticated caller. The ladder reads the
    // same NULL as "no owner left to match", so only an admin gets in.
    const orphaned = entry({ name: "orphan", visibility: "private", userId: null });
    expect(await canRunWorkflow(orphaned, stranger)).toEqual({
      allowed: false,
      reason: 'Workflow "orphan" is not available to this user',
    });
    expect(await canRunWorkflow(orphaned, admin)).toEqual({ allowed: true });
  });

  test("a project workflow is runnable by any member", async () => {
    const scoped = entry({ name: "team-flow", visibility: "project", userId: "u-owner" });
    expect(await canRunWorkflow(scoped, stranger)).toEqual({ allowed: true });
  });

  // ── Rule 1: extension liveness ──────────────────────────────────

  test("allows an extension workflow while its extension is installed and enabled", async () => {
    await seedExtension("my-ext", true);
    const ext = entry({ name: "my-ext:deploy", source: "extension", id: null });
    expect(await canRunWorkflow(ext, stranger)).toEqual({ allowed: true });
  });

  test("denies an extension workflow when the extension is disabled", async () => {
    await seedExtension("my-ext", false);
    const ext = entry({ name: "my-ext:deploy", source: "extension", id: null });
    expect(await canRunWorkflow(ext, stranger)).toEqual({
      allowed: false,
      reason: 'Workflow "my-ext:deploy" belongs to extension "my-ext", which is disabled',
    });
  });

  test("denies an extension workflow when the extension is not installed", async () => {
    const ext = entry({ name: "gone:deploy", source: "extension", id: null });
    expect(await canRunWorkflow(ext, stranger)).toEqual({
      allowed: false,
      reason: 'Workflow "gone:deploy" belongs to extension "gone", which is not installed',
    });
  });

  test("the extension check runs off the NAME, so a squatting DB row is held to it", async () => {
    // A `chat`-scoped user creates `my-ext:deploy` in workflow_definitions.
    // The merged cache puts real extension assets first, but once that
    // extension is uninstalled the squatter surfaces — and must not run.
    const squatter = entry({ name: "my-ext:deploy", visibility: "private", userId: "u-owner" });
    expect((await canRunWorkflow(squatter, owner)).allowed).toBe(false);
  });

  test("the extension check precedes the ladder", async () => {
    // Disabled extension + an ADMIN, who the ladder waves through on any
    // row. The liveness rule wins, mirroring the cache's
    // [...extension, ...yaml, ...db] precedence: a dead extension's
    // workflow is unrunnable by anyone.
    await seedExtension("my-ext", false);
    expect(await canRunWorkflow(entry({ name: "my-ext:deploy" }), admin)).toEqual({
      allowed: false,
      reason: 'Workflow "my-ext:deploy" belongs to extension "my-ext", which is disabled',
    });
  });

  test("a leading separator names no extension and is not liveness-checked", async () => {
    // `:odd` has an EMPTY prefix, which names no extension —
    // `namespacedWorkflowName` can never produce one.
    expect(await canRunWorkflow(entry({ name: ":odd" }), stranger)).toEqual({ allowed: true });
  });
});

describe("canManageWorkflow", () => {
  // The predicate `GET /api/workflows` serves as `canEdit`. It must be
  // exactly what PUT/DELETE enforce, or the UI paints an Edit button that
  // only ever 403s (or 404s).

  test("allows the owner of a private DB workflow", () => {
    expect(canManageWorkflow(privateEntry(), owner)).toBe(true);
  });

  test("allows an admin over another user's DB workflow", () => {
    expect(canManageWorkflow(privateEntry(), admin)).toBe(true);
  });

  test("denies a stranger", () => {
    expect(canManageWorkflow(privateEntry(), stranger)).toBe(false);
  });

  test("a system workflow is admin-only to EDIT, though anyone may run it", () => {
    // The one deliberate tightening the ladder ships: every pre-existing
    // row is `system`, so a non-admin loses edit access to rows they
    // created. The audited admin claim action is the remedy.
    const system = entry({ name: "legacy" });
    expect(canManageWorkflow(system, stranger)).toBe(false);
    expect(canManageWorkflow(system, admin)).toBe(true);
  });

  test("an ORPHANED private row is admin-only here too", () => {
    // Same NULL-owner inversion as the run path, asserted separately
    // because this is the flag the UI paints a Delete button from.
    const orphaned = entry({ name: "orphan", visibility: "private", userId: null });
    expect(canManageWorkflow(orphaned, stranger)).toBe(false);
    expect(canManageWorkflow(orphaned, admin)).toBe(true);
  });

  test("denies YAML and extension-shipped workflows outright", () => {
    // Files on disk — PUT/DELETE resolve through getWorkflowByName and 404.
    // Even the admin cannot write them through the API.
    expect(canManageWorkflow(entry({ source: "yaml", id: null }), admin)).toBe(false);
    expect(canManageWorkflow(entry({ source: "extension", id: null }), admin)).toBe(false);
  });

  test("the creator of a project workflow may edit it; another member may not", () => {
    // Editing is the narrower right: a member can RUN a project workflow
    // without being able to rewrite what it does for everyone else.
    const scoped = entry({ name: "team-flow", visibility: "project", userId: "u-owner" });
    expect(canManageWorkflow(scoped, owner)).toBe(true);
    expect(canManageWorkflow(scoped, stranger)).toBe(false);
  });
});
