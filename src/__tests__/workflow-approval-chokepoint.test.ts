/**
 * Ported invariant 7 — one guard behind EVERY answer path.
 *
 * The extension this replaces had two answer paths and the second could
 * sidestep the consent rules. Nobody noticed, because each path read
 * correctly on its own; the bug lived in the fact that there were two.
 *
 * So this file does NOT check that the surfaces "look like" they call
 * the chokepoint. It asserts two things a fourth surface cannot satisfy
 * by accident:
 *
 *  1. **Call-count on a spy.** Driving a surface must actually INVOKE the
 *     guard. A surface that reimplements the rules — however correctly —
 *     fails, because the count does not move.
 *
 *  2. **Nobody else writes the answer.** The mutation
 *     (`recordWorkflowApprovalAnswer`) is reachable from exactly one
 *     module. A new surface that bypasses the chokepoint necessarily
 *     calls it, so it shows up here the moment it is written — before it
 *     ever has a test of its own.
 *
 * (2) is what makes this hold for surfaces that do not exist yet, which
 * is the whole point: an inspection-based test passes forever while
 * someone adds the path that breaks it.
 */
import { test, expect, describe, beforeAll, afterAll, mock, spyOn } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import type { WorkflowDefinition, WorkflowRun } from "../types";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

mock.module("../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const guardModule = await import("../runtime/workflow-approval-guard");
const { answerApproval } = await import("../runtime/workflow-answer-approval");
const { parkWorkflowApproval } = await import("../db/queries/workflow-approvals");
const { insertWorkflowRun } = await import("../db/queries/workflow-runs");

const DEF: WorkflowDefinition = {
  name: "gated",
  description: "",
  steps: [{ name: "gate", kind: "approval", prompt: "?", choices: ["approve", "reject"] }],
};

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name)
    VALUES ('u1', 'u1@example.test', 'x', 'U1')
  `);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

function stubRuntime() {
  return {
    workflowExecutor: {
      async runWorkflow(): Promise<WorkflowRun> {
        throw new Error("not exercised");
      },
      async resumeWorkflow(_w: WorkflowDefinition, row: { id: string }): Promise<WorkflowRun> {
        return {
          id: row.id,
          workflowName: DEF.name,
          status: "success",
          startedAt: Date.now(),
          steps: [],
        };
      },
    },
    getWorkflows: () => [DEF],
  };
}

async function seedApproval(): Promise<string> {
  const runId = crypto.randomUUID();
  await insertWorkflowRun({
    id: runId,
    workflowName: DEF.name,
    input: {},
    startedAt: new Date(),
  });
  await db.execute(sql`UPDATE workflow_runs SET status = 'suspended' WHERE id = ${runId}`);
  return parkWorkflowApproval({
    workflowRunId: runId,
    stepName: "gate",
    prompt: "?",
    choices: ["approve", "reject"],
    requireItemConsent: false,
    itemIds: [],
  });
}

describe("every answer path routes through the one guard", () => {
  test("answering INVOKES the guard — asserted by call count, not by inspection", async () => {
    const spy = spyOn(guardModule, "requireItemConsent");
    const before = spy.mock.calls.length;

    const approvalId = await seedApproval();
    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { userId: "u1" },
      { runtime: stubRuntime() },
    );

    expect(res.ok).toBe(true);
    // Exactly one guard invocation for one answer. A surface that
    // reimplemented the rules — however correctly — would leave this at
    // `before`, which is the failure this test exists to produce.
    expect(spy.mock.calls.length).toBe(before + 1);
    spy.mockRestore();
  });

  test("a REFUSED answer also went through the guard", async () => {
    // The guard must be on the path for rejections too — otherwise a
    // surface could "pre-validate" and only consult it on the happy
    // path, which is how a bypass hides.
    const spy = spyOn(guardModule, "requireItemConsent");
    const before = spy.mock.calls.length;

    const approvalId = await seedApproval();
    const res = await answerApproval(
      approvalId,
      { choice: "not-a-declared-choice" },
      { userId: "u1" },
      { runtime: stubRuntime() },
    );

    expect(res.ok).toBe(false);
    expect(spy.mock.calls.length).toBe(before + 1);
    spy.mockRestore();
  });
});

describe("nothing outside the chokepoint writes an answer", () => {
  // Anchored to THIS file, never to the process cwd. A cwd-relative
  // scan would silently walk the wrong tree (or find nothing and pass
  // vacuously) the moment the runner's working directory differs — and a
  // scan-based invariant that can pass by finding nothing is worse than
  // no invariant at all.
  const REPO_ROOT = join(import.meta.dir, "..", "..");

  /** Every `.ts`/`.svelte` under a root, excluding tests. */
  function sourceFiles(relRoot: string): string[] {
    const root = join(REPO_ROOT, relRoot);
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "__tests__" || entry === ".svelte-kit") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (
          (full.endsWith(".ts") || full.endsWith(".svelte")) &&
          !full.endsWith(".test.ts") &&
          !full.endsWith(".spec.ts")
        ) {
          out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }

  test("recordWorkflowApprovalAnswer is called from exactly one module", () => {
    // This is what makes the invariant hold for surfaces that DO NOT
    // EXIST YET. A new answer path must write the answer somehow; the
    // only sanctioned way is through `answerApproval`, so a bypass
    // surfaces here the moment it is written rather than whenever
    // someone remembers to add a spy test for it.
    const callers = [...sourceFiles("src"), ...sourceFiles("web/src")].filter((file) => {
      const body = readFileSync(file, "utf8");
      return (
        body.includes("recordWorkflowApprovalAnswer") &&
        // The definition site itself.
        !file.endsWith("db/queries/workflow-approvals.ts")
      );
    });

    expect(callers.map((f) => f.slice(REPO_ROOT.length + 1))).toEqual([
      "src/runtime/workflow-answer-approval.ts",
    ]);
  });

  test("the consent guard is imported by exactly one module", () => {
    // Same reasoning one level up: a surface that imports the guard
    // directly is re-deriving the sequence instead of calling the
    // chokepoint, and the two will drift.
    const importers = [...sourceFiles("src"), ...sourceFiles("web/src")].filter((file) => {
      const body = readFileSync(file, "utf8");
      return (
        body.includes("workflow-approval-guard") &&
        !file.endsWith("runtime/workflow-approval-guard.ts")
      );
    });

    expect(importers.map((f) => f.slice(REPO_ROOT.length + 1))).toEqual([
      "src/runtime/workflow-answer-approval.ts",
    ]);
  });
});
