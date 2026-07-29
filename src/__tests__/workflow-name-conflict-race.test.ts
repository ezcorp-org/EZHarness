/**
 * The TOCTOU half of the name-collision guard.
 *
 * `createWorkflow` / `updateWorkflow` pre-check the name, which answers
 * the ordinary case with a clear message — and is what every other test
 * exercises. But two concurrent creates can BOTH pass their pre-check and
 * let the unique index decide, and that path must produce the same
 * `WorkflowNameConflictError` (⇒ a 409) rather than an unhandled 500.
 *
 * The race is not reproducible by scheduling, so the driver is stubbed to
 * throw what Postgres throws. That is the honest way to test a window
 * that only opens under concurrency.
 */
import { test, expect, describe, beforeEach, mock } from "bun:test";

let insertBehaviour: () => void = () => {};
let updateBehaviour: () => void = () => {};

const existingRow = {
  id: "wf-1",
  name: "mine",
  description: "",
  inputSchema: null,
  defaultModel: null,
  steps: [],
  projectId: null,
  userId: null,
  visibility: "system",
  forkedFrom: null,
};

// A drizzle-shaped stub: the query builders the module actually uses.
//
// The two reads are told apart by their CALL SHAPE, which is what lets
// one stub serve both:
//   - `getWorkflow(id)` awaits `.where(...)` directly  ⇒ the row exists;
//   - `isWorkflowNameTaken()` chains `.limit(1)`       ⇒ the name is free.
// So the code always reaches the insert/update, which is where the race
// this file exists to cover actually lives.
mock.module("../db/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([existingRow]), { limit: async () => [] }),
      }),
    }),
    insert: () => ({
      values: async () => {
        insertBehaviour();
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          updateBehaviour();
        },
      }),
    }),
  }),
}));

const { createWorkflow, updateWorkflow, WorkflowNameConflictError } = await import(
  "../db/queries/workflows"
);

beforeEach(() => {
  insertBehaviour = () => {};
  updateBehaviour = () => {};
});

const definition = { name: "mine", description: "", steps: [] } as never;

describe("a unique-violation from the driver becomes a 409-shaped error", () => {
  test("a SQLSTATE 23505 on insert maps to WorkflowNameConflictError", async () => {
    insertBehaviour = () => {
      throw new Error('duplicate key value violates unique constraint (SQLSTATE 23505)');
    };
    const err = await createWorkflow(definition).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowNameConflictError);
    expect((err as InstanceType<typeof WorkflowNameConflictError>).workflowName).toBe("mine");
  });

  test("the index NAME is matched too, because the two drivers word it differently", async () => {
    // PGlite and bun-sql do not agree on the message text; matching either
    // the SQLSTATE or the index name is what makes this driver-agnostic.
    insertBehaviour = () => {
      throw new Error('duplicate key value violates unique constraint "workflow_definitions_name_unique"');
    };
    await expect(createWorkflow(definition)).rejects.toBeInstanceOf(WorkflowNameConflictError);
  });

  test("an unrelated driver error is re-thrown UNCHANGED, never mislabelled a conflict", async () => {
    // Swallowing this into a 409 would tell the user their name was taken
    // when the real fault was a dead connection.
    const boom = new Error("connection terminated unexpectedly");
    insertBehaviour = () => {
      throw boom;
    };
    const err = await createWorkflow(definition).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(WorkflowNameConflictError);
  });

  test("a non-Error rejection is still classified rather than crashing the mapper", async () => {
    insertBehaviour = () => {
      throw "SQLSTATE 23505";
    };
    await expect(createWorkflow(definition)).rejects.toBeInstanceOf(WorkflowNameConflictError);
  });
});

describe("the same mapping applies to a racing rename", () => {
  test("a 23505 on update maps to WorkflowNameConflictError", async () => {
    updateBehaviour = () => {
      throw new Error("SQLSTATE 23505");
    };
    const err = await updateWorkflow("wf-1", { name: "taken" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowNameConflictError);
  });

  test("an unrelated update error is re-thrown unchanged", async () => {
    const boom = new Error("disk full");
    updateBehaviour = () => {
      throw boom;
    };
    const err = await updateWorkflow("wf-1", { description: "d" }).catch((e: unknown) => e);
    expect(err).toBe(boom);
  });
});
