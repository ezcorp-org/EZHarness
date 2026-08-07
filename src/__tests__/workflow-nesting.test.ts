/**
 * `kind: "workflow"` — composition, and the two properties that make it
 * more than a function call.
 *
 * A nested run is a FIRST-CLASS run: its own `workflow_runs` row, its own
 * cursor, its own `parent_run_id`. That independence is what lets a nested
 * graph containing an `approval` park on its own while the parent parks
 * alongside it — and it is why the re-entrant lookup exists, because a
 * parent that resumed and dispatched a SECOND child would duplicate every
 * side effect the first one applied.
 *
 * Runs against a real PGlite driven by the real `migrate()`, so the
 * schema.ts ⇄ migrate.ts lockstep for `parent_run_id` (column, index and
 * the self-FK's delete action) is verified rather than assumed.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgentsStatic } from "../runtime/loader";
import type {
  AgentEvents,
  WorkflowDefinition,
  WorkflowStep,
} from "../types";
import type { ToolCallResult } from "../extensions/types";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

mock.module("../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
  rawQuery: async (s: string, params: (string | null)[] = []) => pglite.query(s, params),
}));

const { WorkflowExecutor, nestedRunKey, resumeArgsFromRow } = await import(
  "../runtime/workflow-executor"
);
const { getWorkflowRunRow, workflowRunNestingDepth } = await import(
  "../db/queries/workflow-runs"
);
const { getWorkflowApproval, recordWorkflowApprovalAnswer } = await import(
  "../db/queries/workflow-approvals"
);
const { validateWorkflow } = await import("../runtime/workflow-validator");
const { MAX_WORKFLOW_NESTING_DEPTH } = await import("../runtime/workflow-closure");

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

// Row shapes for the raw reads. Kept off any line that STARTS with a
// backtick — see the note in workflow-run-persistence.test.ts about
// gate-integrity's per-line quote state swallowing a trailing `as {`.
type Rows<T> = { rows: T[] };
type ColumnRow = { column_name: string; is_nullable: string };
type IndexRow = { indexname: string };
type FkRow = { conname: string; confdeltype: string };
type ChildRow = { id: string; parent_run_id: string | null; idempotency_key: string | null };
type CountRow = { n: number };

function def(name: string, steps: WorkflowStep[]): WorkflowDefinition {
  return { name, description: name, steps };
}

/** Executor over a fixed set of nestable definitions. */
function makeExecutor(
  defs: WorkflowDefinition[],
  opts: { tool?: () => ToolCallResult } = {},
) {
  const bus = new EventBus<AgentEvents>();
  const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
  return new WorkflowExecutor(agentExec, bus, {
    persist: true,
    workflowResolver: (name) => defs.find((d) => d.name === name),
    ...(opts.tool
      ? {
          toolRunnerFactory: () => ({
            setCurrentUserId() {},
            async executeToolCall() {
              return opts.tool!();
            },
          }),
        }
      : {}),
  });
}

async function childrenOf(parentRunId: string): Promise<ChildRow[]> {
  const rows = (await db.execute(sql`
    SELECT id, parent_run_id, idempotency_key FROM workflow_runs
     WHERE parent_run_id = ${parentRunId}
     ORDER BY idempotency_key
  `)) as Rows<ChildRow>;
  return rows.rows;
}

describe("migrate() — workflow_runs.parent_run_id", () => {
  test("the column is nullable, indexed, and its self-FK is ON DELETE SET NULL", async () => {
    const cols = (await db.execute(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'workflow_runs' AND column_name = 'parent_run_id'
    `)) as Rows<ColumnRow>;
    // Nullable: every top-level run and every historical row has no parent,
    // and inventing one would be a lie in a trace.
    expect(cols.rows[0]?.is_nullable).toBe("YES");

    const indexes = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'workflow_runs'
    `)) as Rows<IndexRow>;
    expect(indexes.rows.map((r) => r.indexname)).toContain("idx_workflow_runs_parent");

    const fks = (await db.execute(sql`
      SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'workflow_runs'::regclass AND contype = 'f'
    `)) as Rows<FkRow>;
    const self = fks.rows.find((r) => r.conname === "workflow_runs_parent_run_id_fkey");
    // 'n' = SET NULL. CASCADE would erase what a nested attempt cost the
    // moment its parent was reaped — the child's history is independently
    // valuable, which is the entire reason for this delete action.
    expect(self?.confdeltype).toBe("n");
  });

  test("deleting a parent NULLs the pointer instead of deleting the child", async () => {
    const defs = [def("kid", [{ name: "t", kind: "transform", output: { v: "K" } }])];
    const wfx = makeExecutor([
      ...defs,
      def("mum", [{ name: "nest", kind: "workflow", workflow: "kid" }]),
    ]);
    const parent = await wfx.runWorkflow(
      def("mum", [{ name: "nest", kind: "workflow", workflow: "kid" }]),
      {},
    );
    const [child] = await childrenOf(parent.id);
    expect(child).toBeDefined();

    await db.execute(sql`DELETE FROM workflow_runs WHERE id = ${parent.id}`);

    const after = await getWorkflowRunRow(child!.id);
    expect(after).toBeDefined();
    expect(after?.parentRunId).toBeNull();
  });
});

describe("a nested run is a first-class run", () => {
  test("the child's result becomes the step's result, linked by parent_run_id", async () => {
    const kid = def("kid-result", [
      { name: "make", kind: "transform", output: { v: "$input.seed" } },
    ]);
    const mum = def("mum-result", [
      { name: "nest", kind: "workflow", workflow: "kid-result", input: { seed: "$input.seed" } },
      {
        name: "read",
        kind: "transform",
        output: { got: "$steps.nest.output.v" },
        dependsOn: ["nest"],
      },
    ]);
    const wfx = makeExecutor([kid, mum]);

    const run = await wfx.runWorkflow(mum, { seed: "S" });

    expect(run.status).toBe("success");
    // The nested graph's final output is addressable through the UNCHANGED
    // ref grammar — that is what makes composition usable at all.
    expect(run.result?.output).toMatchObject({ got: "S" });

    const children = await childrenOf(run.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.idempotency_key).toBe(nestedRunKey(run.id, "nest", 1));
  });

  test("a failing child fails the parent, exactly like a failed agent step", async () => {
    const kid = def("kid-fail", [
      { name: "g", kind: "gate", condition: { ref: "$input.ok", op: "truthy" } },
    ]);
    const mum = def("mum-fail", [{ name: "nest", kind: "workflow", workflow: "kid-fail" }]);
    const wfx = makeExecutor([kid, mum]);

    const run = await wfx.runWorkflow(mum, {});

    expect(run.status).toBe("error");
    expect(String(run.result?.error)).toContain('nested workflow "kid-fail" ended error');
    // The child still has its own row and its own verdict — a failed nested
    // attempt is exactly the history worth keeping.
    const children = await childrenOf(run.id);
    expect(children).toHaveLength(1);
    const childRow = await getWorkflowRunRow(children[0]!.id);
    expect(childRow?.status).toBe("error");
  });

  test("an unresolvable target fails loudly and does not confirm the name", async () => {
    const mum = def("mum-ghost", [{ name: "nest", kind: "workflow", workflow: "ghost" }]);
    const wfx = makeExecutor([mum]);

    const run = await wfx.runWorkflow(mum, {});

    expect(run.status).toBe("error");
    // One message for "no such workflow" and for "not yours": distinguishing
    // them turns a nested step into an existence oracle for private names.
    expect(String(run.result?.error)).toContain('could not resolve workflow "ghost"');
  });

  test("a harness with no resolver refuses rather than silently succeeding", async () => {
    const bus = new EventBus<AgentEvents>();
    const wfx = new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus);
    const run = await wfx.runWorkflow(
      def("mum-none", [{ name: "nest", kind: "workflow", workflow: "kid" }]),
      {},
    );
    expect(run.status).toBe("error");
  });
});

describe("the nesting depth cap", () => {
  test("a chain one level past the cap is refused at RUN time", async () => {
    // d0 → d1 → d2 → d3 is legal (three levels below the root); d3's own
    // nested step would be depth 4.
    const defs = [
      def("d0", [{ name: "n", kind: "workflow", workflow: "d1" }]),
      def("d1", [{ name: "n", kind: "workflow", workflow: "d2" }]),
      def("d2", [{ name: "n", kind: "workflow", workflow: "d3" }]),
      def("d3", [{ name: "n", kind: "workflow", workflow: "d4" }]),
      def("d4", [{ name: "t", kind: "transform", output: { v: "deep" } }]),
    ];
    const wfx = makeExecutor(defs);

    const run = await wfx.runWorkflow(defs[0]!, {});

    expect(run.status).toBe("error");
    expect(String(run.result?.error)).toContain(
      `nesting depth 4, over the maximum of ${MAX_WORKFLOW_NESTING_DEPTH}`,
    );
  });

  test("a chain exactly at the cap runs", async () => {
    const defs = [
      def("e0", [{ name: "n", kind: "workflow", workflow: "e1" }]),
      def("e1", [{ name: "n", kind: "workflow", workflow: "e2" }]),
      def("e2", [{ name: "n", kind: "workflow", workflow: "e3" }]),
      def("e3", [{ name: "t", kind: "transform", output: { v: "deep" } }]),
    ];
    const wfx = makeExecutor(defs);

    const run = await wfx.runWorkflow(defs[0]!, {});

    expect(run.status).toBe("success");
    expect(run.result?.output).toMatchObject({ v: "deep" });
  });

  test("depth is DERIVED from the parent chain, so parking cannot reset it", async () => {
    const defs = [
      def("f0", [{ name: "n", kind: "workflow", workflow: "f1" }]),
      def("f1", [{ name: "n", kind: "workflow", workflow: "f2" }]),
      def("f2", [{ name: "t", kind: "transform", output: { v: "ok" } }]),
    ];
    const wfx = makeExecutor(defs);
    const run = await wfx.runWorkflow(defs[0]!, {});
    const [child] = await childrenOf(run.id);
    const [grandchild] = await childrenOf(child!.id);

    // The number a RESUMED run would recompute for itself. Defaulting it to
    // zero instead is what would make the cap evadable: park a nested run,
    // resume it, and its own nested step would count from the top again.
    expect(await workflowRunNestingDepth(run.id, MAX_WORKFLOW_NESTING_DEPTH)).toBe(1);
    expect(await workflowRunNestingDepth(child!.id, MAX_WORKFLOW_NESTING_DEPTH)).toBe(2);
    expect(await workflowRunNestingDepth(grandchild!.id, MAX_WORKFLOW_NESTING_DEPTH)).toBe(3);
    // A top-level run has no parent and costs no query.
    expect(await workflowRunNestingDepth(null, MAX_WORKFLOW_NESTING_DEPTH)).toBe(0);
  });

  test("the ancestor walk terminates on a corrupted chain", async () => {
    // `parent_run_id` is plain text with a self-FK; a hand-written cycle is
    // reachable in a way the executor cannot produce. The walk must stop
    // rather than spin, which is what the `max` bound is for.
    await db.execute(sql`
      INSERT INTO workflow_runs (id, workflow_name, status, started_at)
      VALUES ('cyc-a', 'w', 'success', NOW()), ('cyc-b', 'w', 'success', NOW())
    `);
    await db.execute(sql`UPDATE workflow_runs SET parent_run_id = 'cyc-b' WHERE id = 'cyc-a'`);
    await db.execute(sql`UPDATE workflow_runs SET parent_run_id = 'cyc-a' WHERE id = 'cyc-b'`);

    const depth = await workflowRunNestingDepth("cyc-a", MAX_WORKFLOW_NESTING_DEPTH);
    expect(depth).toBe(MAX_WORKFLOW_NESTING_DEPTH + 1);
  });
});

describe("`loop` on a `workflow` step", () => {
  test("each iteration is a SEPARATE child run with its own parent_run_id", async () => {
    const kid = def("kid-loop", [
      { name: "t", kind: "transform", output: { i: "$input.i" } },
    ]);
    const mum = def("mum-loop", [
      {
        name: "attempt",
        kind: "workflow",
        workflow: "kid-loop",
        input: { i: "$loop.iteration" },
        loop: { maxIterations: 3 },
      },
    ]);
    const wfx = makeExecutor([kid, mum]);

    const run = await wfx.runWorkflow(mum, {});

    expect(run.status).toBe("success");
    const children = await childrenOf(run.id);
    // Three rows, not one run re-entered — that is what makes the trace
    // read "3 attempts, here is each".
    expect(children).toHaveLength(3);
    expect(children.map((c) => c.idempotency_key)).toEqual([
      nestedRunKey(run.id, "attempt", 1),
      nestedRunKey(run.id, "attempt", 2),
      nestedRunKey(run.id, "attempt", 3),
    ]);
  });

  test("`until` sees the child's result, and `$loop.last` composes with it", async () => {
    const kid = def("kid-until", [
      { name: "t", kind: "transform", output: { n: "$input.n" } },
    ]);
    const mum = def("mum-until", [
      {
        name: "attempt",
        kind: "workflow",
        workflow: "kid-until",
        input: { n: "$loop.iteration" },
        loop: {
          maxIterations: 5,
          until: { ref: "$result.output.n", op: "eq", value: 2 },
        },
      },
    ]);
    const wfx = makeExecutor([kid, mum]);

    const run = await wfx.runWorkflow(mum, {});

    expect(run.status).toBe("success");
    // Stopped at 2, so exactly two children — not the full budget.
    expect(await childrenOf(run.id)).toHaveLength(2);
  });

  test("`loop` on a `workflow` step validates; the tool and gate bans are unmoved", () => {
    expect(
      validateWorkflow(
        def("v", [
          {
            name: "n",
            kind: "workflow",
            workflow: "other",
            loop: { maxIterations: 2 },
          },
        ]),
      ),
    ).toEqual([]);
    expect(
      validateWorkflow(
        def("v", [{ name: "t", kind: "tool", tool: "x__y", loop: { maxIterations: 2 } }]),
      ),
    ).toContain('Step "t" (kind "tool") cannot have a "loop"');
  });
});

describe("a nested run parks independently, and the parent parks with it", () => {
  test("a child that suspends parks the parent, and resume finds it rather than re-running", async () => {
    const kid = def("kid-park", [
      { name: "ask", kind: "approval", prompt: "Ship it?", choices: ["yes"] },
      {
        name: "after",
        kind: "transform",
        output: { choice: "$steps.ask.output.choice" },
        dependsOn: ["ask"],
      },
    ]);
    const mum = def("mum-park", [
      { name: "nest", kind: "workflow", workflow: "kid-park" },
      {
        name: "read",
        kind: "transform",
        output: { got: "$steps.nest.output.choice" },
        dependsOn: ["nest"],
      },
    ]);
    const wfx = makeExecutor([kid, mum]);

    const parked = await wfx.runWorkflow(mum, {});

    // Parked, not failed: nothing went wrong, a human was asked.
    expect(parked.status).toBe("suspended");
    const parentRow = await getWorkflowRunRow(parked.id);
    expect(parentRow?.status).toBe("suspended");
    expect(parentRow?.suspendedReason).toBe("nested-suspended");

    const [child] = await childrenOf(parked.id);
    const childRow = await getWorkflowRunRow(child!.id);
    expect(childRow?.status).toBe("suspended");
    expect(childRow?.suspendedReason).toBe("approval");

    // ── Answer the child and resume it on its own ──
    const approval = await getWorkflowApproval(child!.id, "ask");
    expect(await recordWorkflowApprovalAnswer(approval!.id, { choice: "yes" })).toBe(1);
    const resumedChild = await wfx.resumeWorkflow(kid, resumeArgsFromRow(childRow!));
    expect(resumedChild.status).toBe("success");

    // ── Now the parent ──
    const resumedParent = await wfx.resumeWorkflow(mum, resumeArgsFromRow(parentRow!));

    expect(resumedParent.status).toBe("success");
    expect(resumedParent.result?.output).toMatchObject({ got: "yes" });
    // THE property: still ONE child. A parent that re-dispatched would have
    // duplicated every side effect the first child applied — the failure the
    // durable cursor exists to prevent, reintroduced one level down.
    expect(await childrenOf(parked.id)).toHaveLength(1);
  });
});

describe("a nested run uses the SAME executor instance", () => {
  test("a tool step three levels deep hits this executor's tool runner", async () => {
    // The dry-run guarantee in one assertion: a nested run inherits the
    // injected `toolRunnerFactory` because it is executed by `this`, not by
    // a freshly constructed executor. Swap the real factory for one that
    // refuses (exactly what `dryRunToolRunnerFactory` does) and the refusal
    // must reach a tool step at depth 3.
    const defs = [
      def("g0", [{ name: "n", kind: "workflow", workflow: "g1" }]),
      def("g1", [{ name: "n", kind: "workflow", workflow: "g2" }]),
      def("g2", [{ name: "n", kind: "workflow", workflow: "g3" }]),
      def("g3", [{ name: "t", kind: "tool", tool: "ext__do" }]),
    ];
    const bus = new EventBus<AgentEvents>();
    let built = 0;
    const wfx = new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, {
      persist: true,
      workflowResolver: (name) => defs.find((d) => d.name === name),
      toolRunnerFactory: () => {
        built++;
        throw new Error("dry-run: tool dispatch refused");
      },
    });

    const run = await wfx.runWorkflow(defs[0]!, {});

    expect(run.status).toBe("error");
    expect(String(run.result?.error)).toContain("tool dispatch refused");
    // Built by the depth-3 child, from the factory injected at the ROOT.
    expect(built).toBe(1);
  });

  test("a nested tool step really does dispatch through the injected runner", () => {
    // The negative control for the test above: with a WORKING factory the
    // same shape succeeds, so the failure there is the factory refusing and
    // not nesting being broken.
    const defs = [
      def("h0", [{ name: "n", kind: "workflow", workflow: "h1" }]),
      def("h1", [{ name: "t", kind: "tool", tool: "ext__do" }]),
    ];
    const wfx = makeExecutor(defs, {
      tool: () => ({ content: [{ type: "text", text: '{"ok":true}' }], isError: false }),
    });

    return wfx.runWorkflow(defs[0]!, {}).then((run) => {
      expect(run.status).toBe("success");
      expect(run.result?.output).toEqual({ ok: true });
    });
  });
});

describe("validateWorkflow — nesting", () => {
  test("a `workflow` step requires a target and rejects agent/tool alongside it", () => {
    const errors = validateWorkflow(
      def("v", [{ name: "n", kind: "workflow", agent: "a" }]),
    );
    expect(errors).toContain('Step "n" (kind "workflow") requires a "workflow"');
    expect(errors).toContain(
      'Step "n" (kind "workflow") cannot also specify an "agent" or "tool"',
    );
  });

  test("the nested target is a LITERAL name — a ref is a definition-time error", () => {
    // The decision this pins: the ref language COULD resolve
    // `$input.child` (this step already uses `resolveMapping` for its
    // `input`), and refusing is deliberate. A run-time target would make
    // the cycle check and the depth cap below uncomputable — a cycle would
    // be caught only by hitting the cap, after real nested runs had applied
    // side effects — and it would make C3's consent hash meaningless, since
    // the closure it hashes is the set of graphs the run can reach.
    for (const target of [
      "$input.childWorkflow",
      "$steps.pick.output.name",
      "{{ $input.child }}",
      "$prev.output.name",
    ]) {
      const errors = validateWorkflow(
        def("v", [{ name: "n", kind: "workflow", workflow: target }]),
      );
      expect(
        errors.some((e) => e.includes("must be a literal workflow name")),
        `expected "${target}" to be rejected`,
      ).toBe(true);
    }
  });

  test("a namespaced extension target is still accepted", () => {
    // The rule must not overshoot: `<ext>:<name>` is the legitimate shape
    // for nesting an extension-shipped workflow, and rejecting it would
    // make composition useless across the one boundary it matters most.
    expect(
      validateWorkflow(
        def("v", [{ name: "n", kind: "workflow", workflow: "ez-factory:draft-and-verify" }]),
      ),
    ).toEqual([]);
  });

  test("isResolvableWorkflowName accepts a lookup name and rejects a forgeable one", async () => {
    const { isResolvableWorkflowName, isValidWorkflowName } = await import(
      "../runtime/workflow-name"
    );
    expect(isResolvableWorkflowName("draft-and-verify")).toBe(true);
    expect(isResolvableWorkflowName("ez-factory:draft-and-verify")).toBe(true);
    // Two separators would resolve against a re-split that means something
    // else, so it is rejected rather than silently accepted.
    expect(isResolvableWorkflowName("a:b:c")).toBe(false);
    expect(isResolvableWorkflowName(":leading")).toBe(false);
    expect(isResolvableWorkflowName("trailing:")).toBe(false);
    expect(isResolvableWorkflowName("$input.x")).toBe(false);
    expect(isResolvableWorkflowName("has space")).toBe(false);
    expect(isResolvableWorkflowName("../escape")).toBe(false);
    expect(isResolvableWorkflowName(undefined)).toBe(false);
    // The DECLARE-side predicate stays strictly narrower: an extension may
    // not declare a name carrying the separator, or it could forge another
    // extension's namespace. The two are not interchangeable.
    expect(isValidWorkflowName("ez-factory:draft-and-verify")).toBe(false);
  });

  test("what the loader BUILDS is what a nested target may name", async () => {
    // The producer/consumer round trip, and the reason C7 can nest an
    // extension workflow at all. `namespacedWorkflowName` writes the name
    // into the cache; `isResolvableWorkflowName` decides whether a
    // `kind: "workflow"` step may name it. If those two ever disagreed,
    // every extension-shipped workflow would be nestable in principle and
    // rejected at definition time in practice — and neither function's own
    // tests would notice, because each is correct in isolation.
    const { namespacedWorkflowName, isResolvableWorkflowName, isValidWorkflowName } =
      await import("../runtime/workflow-name");

    for (const declared of ["draft-and-verify", "a", "x.y_z-1"]) {
      // Precondition: the loader only ever namespaces a name it accepted.
      expect(isValidWorkflowName(declared)).toBe(true);
      const full = namespacedWorkflowName("ez-factory", declared);
      expect(full).toBe(`ez-factory:${declared}`);
      expect(isResolvableWorkflowName(full)).toBe(true);
      // And the validator agrees, which is the property that actually ships.
      expect(
        validateWorkflow(def("v", [{ name: "n", kind: "workflow", workflow: full }])),
      ).toEqual([]);
    }
  });

  test("a workflow nesting itself is a definition-time cycle, named", () => {
    const self = def("selfie", [{ name: "n", kind: "workflow", workflow: "selfie" }]);
    // No resolver: self-reference is the one cycle that is ALWAYS statically
    // knowable, because the walk seeds its path with the root's own name.
    expect(validateWorkflow(self)).toContain("Nested workflow cycle: selfie -> selfie");
  });

  test("a mutual cycle is caught at definition time when a resolver can see it", () => {
    const a = def("cyc-a", [{ name: "n", kind: "workflow", workflow: "cyc-b" }]);
    const b = def("cyc-b", [{ name: "n", kind: "workflow", workflow: "cyc-a" }]);
    const errors = validateWorkflow(a, {
      resolve: (name) => [a, b].find((d) => d.name === name),
    });
    // Named, so the author sees the loop rather than a depth number after
    // three real child runs have already had their effects.
    expect(errors).toContain("Nested workflow cycle: cyc-a -> cyc-b -> cyc-a");
  });

  test("an over-deep chain is a definition-time error when it is statically visible", () => {
    const defs = [
      def("k0", [{ name: "n", kind: "workflow", workflow: "k1" }]),
      def("k1", [{ name: "n", kind: "workflow", workflow: "k2" }]),
      def("k2", [{ name: "n", kind: "workflow", workflow: "k3" }]),
      def("k3", [{ name: "n", kind: "workflow", workflow: "k4" }]),
      def("k4", [{ name: "t", kind: "transform", output: { v: "x" } }]),
    ];
    const errors = validateWorkflow(defs[0]!, {
      resolve: (name) => defs.find((d) => d.name === name),
    });
    expect(errors).toContain(
      `Nested workflow "k4" is more than ${MAX_WORKFLOW_NESTING_DEPTH} levels below "k0"`,
    );
  });

  test("with no injected resolver it reads the LIVE merged cache", async () => {
    // The default is what gives the API create/update routes, the fork route
    // and the dry-run route cycle detection with no call-site change. If it
    // silently fell back to "this definition only", a mutual cycle created
    // through the API would pass validation and only surface at run time,
    // after real child runs had already had their effects.
    const { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import(
      "../runtime/workflow/runtime-registry"
    );
    const a = def("live-a", [{ name: "n", kind: "workflow", workflow: "live-b" }]);
    const b = def("live-b", [{ name: "n", kind: "workflow", workflow: "live-a" }]);
    registerWorkflowRuntime({
      workflowExecutor: {} as never,
      getWorkflows: () => [a, b],
    });
    try {
      expect(validateWorkflow(a)).toContain("Nested workflow cycle: live-a -> live-b -> live-a");
    } finally {
      _resetWorkflowRuntimeForTests();
    }
    // And with nothing registered the same definition falls back to
    // self-only resolution, which cannot see the second hop.
    expect(validateWorkflow(a)).toEqual([]);
  });

  test("a forward reference to a workflow that does not exist yet is NOT an error", () => {
    // Rejecting it would make "create the parent, then the child"
    // impossible; the run-time lookup reports it when it actually matters.
    const errors = validateWorkflow(
      def("v", [{ name: "n", kind: "workflow", workflow: "not-yet" }]),
      { resolve: () => undefined },
    );
    expect(errors).toEqual([]);
  });
});

describe("nestedRunKey", () => {
  test("is derived from parent, step and iteration — the re-entrancy contract", async () => {
    expect(nestedRunKey("run-1", "attempt", 2)).toBe("nested:run-1:attempt#2");
    // Distinct per iteration and per parent, which is what the partial
    // unique index on (workflow_name, idempotency_key) then enforces.
    expect(nestedRunKey("run-1", "attempt", 1)).not.toBe(nestedRunKey("run-1", "attempt", 2));
    expect(nestedRunKey("run-2", "attempt", 1)).not.toBe(nestedRunKey("run-1", "attempt", 1));

    const dupes = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM (
        SELECT workflow_name, idempotency_key FROM workflow_runs
         WHERE idempotency_key IS NOT NULL
         GROUP BY 1, 2 HAVING COUNT(*) > 1
      ) d
    `)) as Rows<CountRow>;
    expect(dupes.rows[0]?.n).toBe(0);
  });
});
