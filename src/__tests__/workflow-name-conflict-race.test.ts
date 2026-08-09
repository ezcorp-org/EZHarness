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
 * throw what the driver throws. That is the honest way to test a window
 * that only opens under concurrency — but ONLY if the thrown value has the
 * real shape. This file previously hand-built errors whose MESSAGE text
 * contained the tokens the matcher looked for, so it proved a fact about
 * the fixture: every test passed while the classifier was inert against
 * anything a real driver produces. The fixtures below are the wrapped
 * shape drizzle actually raises, and
 * {@link pgliteUniqueViolation}'s own test asserts the message carries
 * none of those tokens, so message-matching can never be reintroduced and
 * still pass here.
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
        where: () => Object.assign(Promise.resolve([existingRow]), { limit: async () => [] }),
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

/**
 * What a unique violation looks like by the time drizzle re-throws it
 * under PGlite: a `DrizzleQueryError` whose message is the QUERY, with the
 * driver's own error — the only copy of the SQLSTATE — on `.cause`.
 *
 * The constraint name is nowhere in the wrapper either, and it would be
 * the wrong token even if it were: `migrate.ts` renames
 * `pipeline_definitions → workflow_definitions`, and Postgres does not
 * rename constraints with the table, so a lineage database still carries
 * `pipeline_definitions_name_key`.
 */
function pgliteUniqueViolation(): Error {
  return Object.assign(
    new Error(
      'Failed query: insert into "workflow_definitions" ("id", "name", "description", "steps") values ($1, $2, $3, $4)\nparams: wf-2,mine,,[]',
    ),
    {
      cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
      }),
    },
  );
}

/**
 * The same violation from Bun.sql (external Postgres), where `.cause.code`
 * is the transport code and the SQLSTATE lives on `.cause.errno`.
 *
 * Missing this second shape is what made every duplicate create propagate
 * on external-Postgres deploys the last time this was got wrong — see
 * `isUniqueViolation`'s own comment.
 */
function bunSqlUniqueViolation(): Error {
  return Object.assign(
    new Error('Failed query: insert into "workflow_definitions" ("id", "name") values ($1, $2)'),
    {
      cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "23505",
      }),
    },
  );
}

beforeEach(() => {
  insertBehaviour = () => {};
  updateBehaviour = () => {};
});

const definition = { name: "mine", description: "", steps: [] } as never;

describe("a unique-violation from the driver becomes a 409-shaped error", () => {
  test("the fixture carries the SQLSTATE only on .cause, so no message match could see it", () => {
    // The guard on this whole file: if either assertion here ever fails,
    // the fixture has drifted back into proving a fact about itself.
    const err = pgliteUniqueViolation();
    expect(err.message).not.toContain("23505");
    expect(err.message).not.toContain("workflow_definitions_name");
    expect((err.cause as { code: string }).code).toBe("23505");
  });

  test("the PGlite shape (SQLSTATE on .cause.code) maps to WorkflowNameConflictError", async () => {
    insertBehaviour = () => {
      throw pgliteUniqueViolation();
    };
    const err = await createWorkflow(definition).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowNameConflictError);
    expect((err as InstanceType<typeof WorkflowNameConflictError>).workflowName).toBe("mine");
  });

  test("the bun-sql shape (SQLSTATE on .cause.errno) maps to it too", async () => {
    // The two drivers disagree about where the code lives, and an external
    // -Postgres deploy is the one that 500s if only PGlite's shape is read.
    insertBehaviour = () => {
      throw bunSqlUniqueViolation();
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

  test("a foreign-key violation is not a name conflict", async () => {
    // 23503, one digit away. Classifying by code means classifying
    // exactly, not by family.
    const fk = Object.assign(new Error("Failed query: insert into …"), {
      cause: Object.assign(new Error("violates foreign key constraint"), { code: "23503" }),
    });
    insertBehaviour = () => {
      throw fk;
    };
    await expect(createWorkflow(definition)).rejects.toBe(fk);
  });

  test("a non-Error rejection is re-thrown rather than guessed at", async () => {
    // No driver throws a bare string, and a mapper that read one for
    // tokens would be back to classifying prose.
    insertBehaviour = () => {
      throw "SQLSTATE 23505";
    };
    await expect(createWorkflow(definition)).rejects.toBe("SQLSTATE 23505");
  });
});

describe("the same mapping applies to a racing rename", () => {
  test("a unique violation on update maps to WorkflowNameConflictError", async () => {
    updateBehaviour = () => {
      throw pgliteUniqueViolation();
    };
    const err = await updateWorkflow("wf-1", { name: "taken" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowNameConflictError);
    expect((err as InstanceType<typeof WorkflowNameConflictError>).workflowName).toBe("taken");
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
