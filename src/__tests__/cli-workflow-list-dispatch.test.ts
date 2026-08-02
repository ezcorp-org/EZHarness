/**
 * Covers the `workflow:list` and `workflow:run` CLI dispatch (the
 * `case "workflow:list"` / `case "workflow:run"` blocks in cli()) with mocked
 * DB/loader surfaces — the list empty/merge cases plus the hidden `pipeline`
 * alias, and the run success / missing-name / not-found paths. `loadAgents`
 * swallows a missing DB (its own try/catch), so `setupRunHarness` succeeds
 * against the mocked connection without a real agent-config DB, and a
 * transform-only workflow runs through the real executor with no agents.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let yamlWorkflows: Array<{ name: string; description?: string; steps: unknown[] }> = [];
let dbWorkflows: Array<{ name: string; description?: string; steps: unknown[] }> = [];

// Mock BEFORE importing ../cli.
mock.module("../db/connection", () => ({
  initDb: async () => {},
  getDb: () => ({}),
  closeDb: async () => {},
}));
mock.module("../runtime/workflow-loader", () => ({
  loadYamlWorkflows: async () => yamlWorkflows,
}));
mock.module("../db/queries/workflows", () => ({
  loadDbWorkflows: async () => dbWorkflows,
}));
// Persistence stubbed to SUCCEED. `getDb: () => ({})` above is not a DB
// double — every call on it throws — and that was invisible only while
// every persistence write was swallowed by contract. The executor now has
// a strict path (the run-position bookkeeping, whose loss would let a
// resume re-execute a completed batch), so an empty object models a
// totally dead DB and the run fails closed on it. This suite is about CLI
// dispatch and exit codes, not durability, so it gets a DB that works.
mock.module("../db/queries/workflow-runs", () => ({
  insertWorkflowRun: async () => {},
  upsertWorkflowStepRun: async () => {},
  finalizeWorkflowRunRow: async () => 1,
  markWorkflowRunInBatch: async () => {},
  advanceWorkflowRunCursor: async () => {},
  // The suspend write is on the executor's STRICT path — a swallowed
  // failure there yields `cursor-write-failed`, not `suspended`, so the
  // parked-run dispatch below would never be reached.
  suspendWorkflowRun: async () => 1,
}));
// An `approval` step parks the run: the executor writes the approval row,
// then throws `WorkflowSuspendedError`, which settles the run `suspended`.
// Stubbed rather than DB-backed because this suite is about what the CLI
// PRINTS for a parked run; the approval row's own coverage is
// src/__tests__/workflow-approval-*.test.ts.
mock.module("../db/queries/workflow-approvals", () => ({
  getWorkflowApproval: async () => undefined,
  hasPendingApproval: async () => false,
  parkWorkflowApproval: async () => "ap-cli-1",
}));

const { cli } = await import("../cli");

let logs: string[] = [];
let errs: string[] = [];
const origLog = console.log;
const origErr = console.error;
beforeEach(() => {
  logs = [];
  errs = [];
  yamlWorkflows = [];
  dbWorkflows = [];
  console.log = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
  console.error = (...a: unknown[]) => {
    errs.push(a.join(" "));
  };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});
afterAll(() => restoreModuleMocks());

/** Run cli(...), capturing a process.exit(code) as a thrown sentinel. */
async function captureExit(fn: () => Promise<unknown>): Promise<number> {
  const orig = process.exit;
  let code: number | undefined;
  process.exit = ((c?: number): never => {
    code = c ?? 0;
    throw new Error(`__exit__:${code}`);
  }) as typeof process.exit;
  try {
    await fn();
    throw new Error("expected process.exit to be called");
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__exit__:")) throw e;
  } finally {
    process.exit = orig;
  }
  return code!;
}

describe("cli workflow:list dispatch", () => {
  test("prints the empty message when no workflows exist", async () => {
    await cli(["workflow", "list"]);
    expect(logs.join("\n")).toContain("No workflows found.");
  });

  test("lists YAML and DB workflows together", async () => {
    yamlWorkflows = [{ name: "yaml-wf", description: "from yaml", steps: [1] }];
    dbWorkflows = [{ name: "db-wf", description: "from db", steps: [1, 2] }];
    await cli(["workflow", "list"]);
    const out = logs.join("\n");
    expect(out).toContain("yaml-wf");
    expect(out).toContain("db-wf");
    expect(out).not.toContain("No workflows found.");
  });

  test("the hidden `pipeline` alias dispatches to the same `workflow:list`", async () => {
    dbWorkflows = [{ name: "aliased", description: "via alias", steps: [1] }];
    await cli(["pipeline", "list"]);
    const out = logs.join("\n");
    expect(out).toContain("aliased");
  });
});

describe("cli help usage", () => {
  test("prints the usage text including the workflow commands", async () => {
    await cli(["help"]);
    const out = logs.join("\n");
    expect(out).toContain("Usage:");
    expect(out).toContain("ezcorp workflow list");
    expect(out).toContain("ezcorp workflow run");
  });
});

describe("cli workflow:run dispatch", () => {
  test("runs a successful workflow, prints its result JSON, and exits 0", async () => {
    dbWorkflows = [
      {
        name: "det",
        description: "deterministic",
        steps: [{ name: "shape", kind: "transform", output: { greeting: "hello" } } as unknown],
      },
    ];
    const code = await captureExit(() => cli(["workflow", "run", "det"]));
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("greeting");
    expect(out).toContain("hello");
  });

  test("exits 1 (loud failure) when the run finishes with an error status", async () => {
    // A transform with an unresolvable strict `$steps` ref fails the run, so
    // it settles `status: "error"` → the CLI must exit non-zero.
    dbWorkflows = [
      {
        name: "boom",
        description: "fails",
        steps: [{ name: "bad", kind: "transform", output: { x: "$steps.nope.output" } } as unknown],
      },
    ];
    const code = await captureExit(() => cli(["workflow", "run", "boom"]));
    expect(code).toBe(1);
  });

  test("errors and exits when no workflow name is given", async () => {
    const code = await captureExit(() => cli(["workflow", "run"]));
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("workflow name required");
  });

  test("errors and exits when the named workflow is not found", async () => {
    yamlWorkflows = [];
    dbWorkflows = [];
    const code = await captureExit(() => cli(["workflow", "run", "ghost"]));
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain('workflow "ghost" not found');
  });

  // ── A SUSPENDED run is alive, and the CLI has to say so ──────────────
  //
  // Every other non-success status is a dead run, and the exit code alone
  // tells the operator that. `suspended` is the one status where exit 1 is
  // MISLEADING: the run is parked on an approval and is waiting for a human,
  // and `run.result` (`{"code":"suspended", ...}`) does not say that it can
  // be answered or how. Without the notice an operator reads exit 1 as a
  // failure, walks away, and the run waits forever.
  describe("a run that parks on an approval", () => {
    const parking = [
      {
        name: "gated",
        description: "parks on a human",
        steps: [
          {
            name: "gate",
            kind: "approval",
            prompt: "Ship it?",
            choices: ["approve", "reject"],
          } as unknown,
        ],
      },
    ];

    test("still exits 1 — loud-failure semantics are unchanged", async () => {
      dbWorkflows = parking;
      const code = await captureExit(() => cli(["workflow", "run", "gated"]));
      expect(code).toBe(1);
    });

    test("says the run is SUSPENDED, not failed", async () => {
      dbWorkflows = parking;
      await captureExit(() => cli(["workflow", "run", "gated"]));
      const out = logs.join("\n");
      expect(out).toContain("is SUSPENDED, not failed — it is waiting to be continued.");
    });

    test("names all three ways out, each with the run's own id", async () => {
      dbWorkflows = parking;
      await captureExit(() => cli(["workflow", "run", "gated"]));
      const out = logs.join("\n");
      // The run id is the whole point of printing these: an operator with a
      // parked run and no id has nothing to call.
      const idMatch = out.match(/Run ([0-9a-f-]{8,}) is SUSPENDED/);
      expect(idMatch).not.toBeNull();
      const id = idMatch![1]!;
      expect(out).toContain("Answer an approval:  POST /api/workflows/approvals/<approvalId>");
      expect(out).toContain(`Or continue it:      POST /api/workflows/runs/${id}/resume`);
      expect(out).toContain(`Or abandon it:       POST /api/workflows/runs/${id}/cancel`);
    });

    test("a run that is NOT suspended gets no parked-run notice", async () => {
      // The guard, not the body: an ordinary failure must not tell the
      // operator there is something to answer.
      dbWorkflows = [
        {
          name: "boom2",
          description: "fails",
          steps: [{ name: "bad", kind: "transform", output: { x: "$steps.nope.output" } } as unknown],
        },
      ];
      const code = await captureExit(() => cli(["workflow", "run", "boom2"]));
      expect(code).toBe(1);
      const out = logs.join("\n");
      expect(out).not.toContain("is SUSPENDED");
      expect(out).not.toContain("Answer an approval");
    });
  });
});
