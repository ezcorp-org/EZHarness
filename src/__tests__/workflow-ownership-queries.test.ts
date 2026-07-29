import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  WorkflowNameConflictError,
  claimWorkflow,
  createWorkflow,
  deleteWorkflow,
  getWorkflowByName,
  isWorkflowNameTaken,
  loadDbCachedWorkflows,
  loadDbWorkflows,
  updateWorkflow,
} = await import("../db/queries/workflows");
const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");

const steps = [{ name: "s1", agent: "writer", input: {} as Record<string, string> }];

const OWNER = "user-owner";
let projectId: string;

async function freshDb() {
  await setupTestDb();
  await createUser({ id: OWNER, email: "o@x", passwordHash: "h", name: "O" });
  projectId = (await createProject({ name: "p", path: "/tmp/p" })).id;
}

describe("ownership defaults keep pre-C6 behaviour", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("a workflow created with no ownership is system-owned with NULL owners", async () => {
    // What every pre-existing row migrates to, and the whole backward-
    // safety argument: `system` authorizes exactly who could run it before
    // the ladder existed.
    const row = await createWorkflow({ name: "legacy", description: "", steps } as never);
    expect(row.visibility).toBe("system");
    expect(row.projectId).toBeNull();
    expect(row.userId).toBeNull();
    expect(row.forkedFrom).toBeNull();
  });

  test("ownership is stamped when supplied", async () => {
    const row = await createWorkflow({ name: "owned", description: "", steps } as never, {
      visibility: "project",
      projectId,
      userId: OWNER,
      forkedFrom: "ez-factory:docs",
    });
    expect(row).toMatchObject({
      visibility: "project",
      projectId,
      userId: OWNER,
      forkedFrom: "ez-factory:docs",
    });
  });

  test("deleting the owning project cascades the workflow away", async () => {
    await createWorkflow({ name: "scoped", description: "", steps } as never, {
      visibility: "project",
      projectId,
      userId: OWNER,
    });
    const { deleteProject } = await import("../db/queries/projects");
    await deleteProject(projectId);
    expect(await getWorkflowByName("scoped")).toBeUndefined();
  });
});

describe("name collisions are 409-shaped, not 500-shaped", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("creating a duplicate name throws the conflict error, naming the collision", async () => {
    await createWorkflow({ name: "dup", description: "", steps } as never);
    const err = await createWorkflow({ name: "dup", description: "", steps } as never).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkflowNameConflictError);
    expect((err as InstanceType<typeof WorkflowNameConflictError>).workflowName).toBe("dup");
  });

  test("renaming onto a taken name throws rather than hitting the unique index", async () => {
    // Unreachable before the editor made renaming ordinary — the old code
    // copied `data.name` into the update set with no check and let the
    // index reject it, which surfaced as an unhandled 500.
    await createWorkflow({ name: "taken", description: "", steps } as never);
    const mine = await createWorkflow({ name: "mine", description: "", steps } as never);
    const err = await updateWorkflow(mine.id, { name: "taken" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowNameConflictError);
    // The rename did not partially apply.
    expect((await getWorkflowByName("mine"))!.id).toBe(mine.id);
  });

  test("a no-op rename to the workflow's OWN name is not a collision", async () => {
    const mine = await createWorkflow({ name: "mine", description: "", steps } as never);
    const updated = await updateWorkflow(mine.id, { name: "mine", description: "d" });
    expect(updated!.description).toBe("d");
  });

  test("a genuine rename to a free name succeeds", async () => {
    const mine = await createWorkflow({ name: "mine", description: "", steps } as never);
    const updated = await updateWorkflow(mine.id, { name: "renamed" });
    expect(updated!.name).toBe("renamed");
    expect(await getWorkflowByName("mine")).toBeUndefined();
  });

  test("isWorkflowNameTaken ignores the excepted row", async () => {
    const mine = await createWorkflow({ name: "mine", description: "", steps } as never);
    expect(await isWorkflowNameTaken("mine")).toBe(true);
    expect(await isWorkflowNameTaken("mine", mine.id)).toBe(false);
    expect(await isWorkflowNameTaken("absent")).toBe(false);
  });

  test("updateWorkflow on a missing id is undefined, not an error", async () => {
    expect(await updateWorkflow(crypto.randomUUID(), { description: "x" })).toBeUndefined();
  });
});

describe("claiming a system workflow", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("claim sets an explicit owner and project — never a guess", async () => {
    // The deliberate remedy for the one real regression this phase ships.
    // Ownership is STATED by an admin, not inferred from run history.
    const row = await createWorkflow({ name: "legacy", description: "", steps } as never);
    const claimed = await claimWorkflow(row.id, OWNER, projectId);
    expect(claimed).toMatchObject({ visibility: "project", userId: OWNER, projectId });
  });

  test("claim is reversible — claiming again re-points the owner", async () => {
    await createUser({ id: "user-2", email: "b@x", passwordHash: "h", name: "B" });
    const row = await createWorkflow({ name: "legacy", description: "", steps } as never);
    await claimWorkflow(row.id, OWNER, projectId);
    const reclaimed = await claimWorkflow(row.id, "user-2", null);
    expect(reclaimed).toMatchObject({ userId: "user-2", projectId: null });
  });

  test("claiming a missing workflow is undefined", async () => {
    expect(await claimWorkflow(crypto.randomUUID(), OWNER, null)).toBeUndefined();
  });

  test("deleting the owner un-attributes rather than deleting the workflow", async () => {
    // Same IDOR-guard rationale as `workflow_runs.user_id`: an orphaned
    // private workflow becomes admin-only, it never disappears.
    const row = await createWorkflow({ name: "owned", description: "", steps } as never, {
      visibility: "private",
      userId: OWNER,
    });
    // No `deleteUser` query exists, so the FK is exercised directly —
    // the point is the column's ON DELETE SET NULL, not a query helper.
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("../db/connection");
    const { users } = await import("../db/schema");
    await getDb().delete(users).where(eq(users.id, OWNER));
    const after = await getWorkflowByName("owned");
    expect(after).toBeDefined();
    expect(after!.userId).toBeNull();
    expect(await deleteWorkflow(row.id)).toBe(true);
  });
});

describe("the cache projection carries provenance", () => {
  beforeEach(async () => await freshDb());
  afterAll(async () => await closeTestDb());

  test("loadDbCachedWorkflows keeps the id and owner columns the old loader dropped", async () => {
    // The blocking finding this phase exists to fix: the old projection
    // dropped `id`, so a route holding a workflow had nothing to
    // authorize against.
    const row = await createWorkflow({ name: "owned", description: "d", steps } as never, {
      visibility: "project",
      projectId,
      userId: OWNER,
      forkedFrom: "ez-factory:docs",
    });
    const [entry] = await loadDbCachedWorkflows();
    expect(entry).toMatchObject({
      source: "db",
      id: row.id,
      projectId,
      userId: OWNER,
      visibility: "project",
      forkedFrom: "ez-factory:docs",
    });
    expect(entry!.definition).toMatchObject({ name: "owned", description: "d" });
  });

  test("loadDbWorkflows still returns bare definitions for the CLI", async () => {
    // The CLI has no auth context at all and resolves YAML + DB directly,
    // bypassing the routes. Deliberately unchanged.
    await createWorkflow({ name: "cli", description: "d", steps } as never);
    const [def] = await loadDbWorkflows();
    expect(Object.keys(def!).sort()).toEqual([
      "defaultModel",
      "description",
      "inputSchema",
      "name",
      "steps",
    ]);
  });

  test("the two loaders agree on the definition, so there is one projection", async () => {
    await createWorkflow({ name: "same", description: "d", steps } as never);
    const [cached] = await loadDbCachedWorkflows();
    const [bare] = await loadDbWorkflows();
    expect(cached!.definition).toEqual(bare!);
  });
});
