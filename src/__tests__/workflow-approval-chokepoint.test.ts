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
const { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import(
  "../runtime/workflow/runtime-registry"
);

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

async function seedApproval(rbacScope?: string): Promise<string> {
  const runId = crypto.randomUUID();
  await insertWorkflowRun({
    id: runId,
    workflowName: DEF.name,
    input: {},
    startedAt: new Date(),
    // Owned by the user every case answers as: with no `rbacScope`
    // declared, the run's OWNER is who may answer. A fixture that left
    // this null was exercising the unowned path, which is now refused.
    userId: "u1",
  });
  await db.execute(sql`UPDATE workflow_runs SET status = 'suspended' WHERE id = ${runId}`);
  return parkWorkflowApproval({
    workflowRunId: runId,
    stepName: "gate",
    prompt: "?",
    choices: ["approve", "reject"],
    requireItemConsent: false,
    itemIds: [],
    ...(rbacScope !== undefined ? { rbacScope } : {}),
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
      { kind: "user", userId: "u1", isAdmin: false },
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
      { kind: "user", userId: "u1", isAdmin: false },
      { runtime: stubRuntime() },
    );

    expect(res.ok).toBe(false);
    expect(spy.mock.calls.length).toBe(before + 1);
    spy.mockRestore();
  });

  test("the REST route itself invokes the guard — the surface, not just the helper", async () => {
    // Both tests above call `answerApproval` directly, which proves the
    // CHOKEPOINT consults the guard but says nothing about whether the
    // route reaches the chokepoint. A route that inlined the consent
    // rules would pass them. So this drives the real handler.
    const { POST } = await import(
      "../../web/src/routes/api/workflows/approvals/[id]/+server"
    );
    // The route resolves its executor through the live registry rather
    // than an injected dep — that indirection is the only legal route
    // from `src/` to the web layer's executor, so the test registers a
    // stub through the same seam.
    registerWorkflowRuntime(stubRuntime());
    const spy = spyOn(guardModule, "requireItemConsent");
    const before = spy.mock.calls.length;

    const approvalId = await seedApproval();
    const res = (await POST({
      request: new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ choice: "approve" }),
      }),
      params: { id: approvalId },
      // `authMethod: "session"` is what `hooks.server.ts` stamps on a
      // verified session cookie, and the answer route is session-ONLY
      // (`requireSessionAuth`) — answering is the consent boundary, so an
      // API-key principal is refused before the chokepoint. These tests are
      // about what happens AFTER auth, so they must describe a real human.
      locals: { user: { id: "u1", role: "member" }, authMethod: "session" },
      // Cast through `unknown`: a full SvelteKit RequestEvent carries a
      // dozen fields the handler never reads, and stubbing them would
      // add noise without adding coverage.
    } as unknown as Parameters<typeof POST>[0])) as Response;

    expect(res.status).toBe(200);
    expect(spy.mock.calls.length).toBe(before + 1);
    spy.mockRestore();
    _resetWorkflowRuntimeForTests();
  });

  test("the REST route's rbacScope check reaches the REAL resolver, and denies by default", async () => {
    // The two cases above drive approvals that declare NO `rbacScope`, so
    // the route's `checkScope` callback is never called and its wiring is
    // unasserted end-to-end. A declared scope is the documented way to say
    // "answering this needs a permission", and it deliberately does NOT
    // also require ownership — so if the route resolved it wrongly (looser
    // coordinates, a swallowed failure read as a grant, the wrong
    // principal) a reviewer could be let through a gate they do not hold,
    // on a run they do not own. Nothing else exercises that callback
    // against real grant rows.
    const { POST } = await import(
      "../../web/src/routes/api/workflows/approvals/[id]/+server"
    );
    registerWorkflowRuntime(stubRuntime());
    const answerAs = async (id: string, role: "member" | "admin") =>
      (await POST({
        request: new Request("http://x", {
          method: "POST",
          body: JSON.stringify({ choice: "approve" }),
        }),
        params: { id },
        locals: { user: { id: "u1", role }, authMethod: "session" },
      } as unknown as Parameters<typeof POST>[0])) as Response;

    // A member holding NO grant at (NULL project, NULL extension) is
    // refused — deny-by-default, even though `u1` OWNS this run. A
    // declared scope REPLACES ownership as the rule; reading it as
    // "owner OR scope" would make every declared scope decorative.
    const denied = await answerAs(await seedApproval("workflows:approve"), "member");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'You need the "workflows:approve" permission to answer this approval',
    });

    // An admin resolves every scope (the resolver's admin sentinel), so
    // the same request lands. Two DIFFERENT outcomes from one seeded
    // shape: a route that hard-coded `false` would pass the case above.
    const allowed = await answerAs(await seedApproval("workflows:approve"), "admin");
    expect(allowed.status).toBe(200);
    _resetWorkflowRuntimeForTests();
  });

  test("the REST route maps refusals through the shared status table", async () => {
    // The case above drives only the SUCCESS path. The refusal path is
    // where this route used to keep its own hand-written code→status
    // object — one of four copies — so it needs a surface-level assertion
    // of its own, not just the table's unit test.
    //
    // Two DIFFERENT statuses, because a route that had quietly collapsed
    // to a single constant (or to the `?? 400` default) would satisfy one.
    const { POST } = await import(
      "../../web/src/routes/api/workflows/approvals/[id]/+server"
    );
    const answer = async (id: string) =>
      (await POST({
        request: new Request("http://x", {
          method: "POST",
          body: JSON.stringify({ choice: "approve" }),
        }),
        params: { id },
        locals: { user: { id: "u1", role: "member" }, authMethod: "session" },
      } as unknown as Parameters<typeof POST>[0])) as Response;

    // `not-found` → 404. No runtime is registered here on purpose: both
    // refusals are returned before the chokepoint reaches for one.
    expect((await answer(crypto.randomUUID())).status).toBe(404);

    // `not-pending` → 409, the "someone got there first" refusal. Reported
    // distinctly from 404 precisely so the caller is not told the approval
    // never existed.
    const approvalId = await seedApproval();
    await db.execute(
      sql`UPDATE workflow_approvals SET status = 'answered' WHERE id = ${approvalId}`,
    );
    expect((await answer(approvalId)).status).toBe(409);
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

  test("the scan is non-vacuous — it walks a real tree", () => {
    // A count floor, independent of the `import.meta.dir` anchoring. A
    // scan that walked an empty directory would report success forever,
    // and every assertion below is a NEGATIVE ("nobody else does X"),
    // which is exactly the shape that passes when you find nothing.
    // Borrowed from the C6 route-ladder scan, which reviewed clean.
    const files = [...sourceFiles("src"), ...sourceFiles("web/src")];
    expect(files.length).toBeGreaterThanOrEqual(100);
    // And the file we expect to find is actually in the set, so a
    // filter bug cannot quietly empty it either.
    expect(files.map((f) => f.slice(REPO_ROOT.length + 1))).toContain(
      "src/runtime/workflow-answer-approval.ts",
    );
  });

  test("every MUTATING answer surface reaches the chokepoint — a POSITIVE assertion", () => {
    // The negatives above catch a surface that reimplements the rules.
    // They do NOT catch one that reaches the boundary by no path at all
    // — a route that answers nothing, or answers through some future
    // helper. So: every handler under the approvals route that can WRITE
    // must name `answerApproval`. Borrowed from the C6 ladder scan, which
    // pairs its bans with a required call for the same reason.
    //
    // Scoped to mutating handlers because the inbox (`GET .../approvals`)
    // lives here too and legitimately answers nothing — it lists
    // questions. Keying on the exported verb rather than on a filename
    // keeps the guard strong where it matters: a new POST/PUT/PATCH/DELETE
    // under this directory still has to go through the chokepoint, and
    // adding one is exactly the change this test exists to catch.
    const routeDir = join(REPO_ROOT, "web/src/routes/api/workflows/approvals");
    const handlers = sourceFiles("web/src/routes/api/workflows/approvals");
    expect(handlers.length).toBeGreaterThanOrEqual(1);
    expect(routeDir.endsWith("approvals")).toBe(true);

    const MUTATING = /export const (POST|PUT|PATCH|DELETE)\b/;
    const mutating = handlers.filter((f) => MUTATING.test(readFileSync(f, "utf8")));
    // The answer route itself must always be in this set — otherwise a
    // regex that matched nothing would make this whole test vacuous, the
    // failure mode every negative assertion here already guards against.
    expect(mutating.map((f) => f.slice(REPO_ROOT.length + 1))).toContain(
      "web/src/routes/api/workflows/approvals/[id]/+server.ts",
    );

    for (const file of mutating) {
      const body = readFileSync(file, "utf8");
      expect({
        file: file.slice(REPO_ROOT.length + 1),
        callsChokepoint: body.includes("answerApproval"),
      }).toEqual({ file: file.slice(REPO_ROOT.length + 1), callsChokepoint: true });
    }
  });

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

  test("only the queries module WRITES the workflow_approvals table", () => {
    // The two scans above match IDENTIFIERS, so a surface that inlined
    // the consent rules and wrote with raw drizzle against
    // `workflowApprovals` would pass both. Today only the queries module
    // and the schema touch that table, and this pins it — without it the
    // structural property rests on a coincidence nobody is checking.
    const touchers = [...sourceFiles("src"), ...sourceFiles("web/src")].filter((file) => {
      const body = readFileSync(file, "utf8");
      // Match write SYNTAX, not the bare identifier: a surface that
      // reads the table for display is fine, one that inserts or
      // updates it is reimplementing the answer path. `.insert(x)` /
      // `.update(x)` catches the drizzle builder regardless of how the
      // table reference is spelled or aliased on the way in.
      return (
        /\.(?:insert|update)\(\s*workflowApprovals/.test(body) &&
        !file.endsWith("db/queries/workflow-approvals.ts") &&
        !file.endsWith("db/schema.ts")
      );
    });

    expect(touchers.map((f) => f.slice(REPO_ROOT.length + 1))).toEqual([]);
  });
});
