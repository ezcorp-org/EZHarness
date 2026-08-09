/**
 * The Hub approvals tab — the second answer surface.
 *
 * The load-bearing test here is the CALL COUNT on the consent guard.
 * Ported invariant 7 says every answer surface routes through
 * `answerApproval`, and the reason that is asserted by spy rather than by
 * reading the code is that a surface which re-implemented the rules —
 * however correctly today — looks fine to a reviewer and drifts tomorrow.
 * The reference extension this replaces had exactly that bug.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock, spyOn } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
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
  rawQuery: async (s: string, params: (string | null)[] = []) => pglite.query(s, params),
}));

const guardModule = await import("../runtime/workflow-approval-guard");
const { createWorkflowApprovalsHubPageProvider, WORKFLOW_APPROVALS_ANSWER_ACTION } = await import(
  "../runtime/workflow-approvals-hub-page"
);
const { insertWorkflowRun } = await import("../db/queries/workflow-runs");
const { parkWorkflowApproval, getWorkflowApprovalById } = await import(
  "../db/queries/workflow-approvals"
);
const registry = await import("../runtime/workflow/runtime-registry");
const { registerWorkflowApprovalsHubPage, WORKFLOW_APPROVALS_HUB_PAGE_ID } = await import(
  "../runtime/workflow-approvals-hub-page"
);
const hubPages = await import("../runtime/hub-pages");

const DEF: WorkflowDefinition = {
  name: "gated",
  description: "",
  steps: [{ name: "gate", kind: "transform", output: { v: "1" } }],
};

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name)
    VALUES ('u1', 'u1@example.test', 'x', 'One'), ('u2', 'u2@example.test', 'x', 'Two')
  `);
});

afterAll(async () => {
  await pglite.close();
  registry._resetWorkflowRuntimeForTests();
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM workflow_approvals`);
  await db.execute(sql`DELETE FROM workflow_runs`);
  // A runtime that resumes to a plain success, so the answer path completes
  // and the assertions below are about THIS surface, not about the executor.
  registry.registerWorkflowRuntime({
    getWorkflows: () => [DEF],
    workflowExecutor: {
      runWorkflow: (async () => ({}) as WorkflowRun) as never,
      resumeWorkflow: (async (_w: unknown, row: { id: string }) =>
        ({
          id: row.id,
          workflowName: DEF.name,
          status: "success",
          startedAt: 0,
          steps: [],
        }) as unknown as WorkflowRun) as never,
    },
  });
});

async function seedApproval(
  opts: { userId?: string | null; requireItemConsent?: boolean; itemIds?: string[] } = {},
): Promise<string> {
  const runId = crypto.randomUUID();
  await insertWorkflowRun({
    id: runId,
    workflowName: DEF.name,
    input: {},
    startedAt: new Date(),
    userId: opts.userId === undefined ? "u1" : opts.userId,
  });
  await db.execute(sql`UPDATE workflow_runs SET status = 'suspended' WHERE id = ${runId}`);
  return parkWorkflowApproval({
    workflowRunId: runId,
    stepName: "gate",
    prompt: "Ship it?",
    choices: ["approve", "reject"],
    requireItemConsent: opts.requireItemConsent ?? false,
    itemIds: opts.itemIds ?? [],
  });
}

const provider = createWorkflowApprovalsHubPageProvider();
const answerAction = provider.actions![WORKFLOW_APPROVALS_ANSWER_ACTION]!;

describe("the Hub answer action routes through the ONE guard", () => {
  test("answering INVOKES the consent guard — asserted by call count", async () => {
    const spy = spyOn(guardModule, "requireItemConsent");
    const before = spy.mock.calls.length;
    const approvalId = await seedApproval();

    await answerAction({ userId: "u1" }, { approvalId, choice: "approve" });

    // Exactly one guard invocation for one answer. A surface that
    // reimplemented the rules — however correctly — would leave this at
    // `before`, which is the failure this test exists to produce.
    expect(spy.mock.calls.length).toBe(before + 1);
    spy.mockRestore();
  });

  test("the answer is RECORDED on the row, not merely returned", async () => {
    const approvalId = await seedApproval();
    await answerAction({ userId: "u1" }, { approvalId, choice: "approve" });

    const row = await getWorkflowApprovalById(approvalId);
    expect(row?.status).toBe("answered");
    expect(row?.answerChoice).toBe("approve");
    expect(row?.answeredBy).toBe("u1");
  });

  test("a stranger's approval is refused, and the row is untouched", async () => {
    const approvalId = await seedApproval({ userId: "u1" });

    await expect(
      answerAction({ userId: "u2" }, { approvalId, choice: "approve" }),
    ).rejects.toMatchObject({ status: 403 });

    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
  });

  test("answering twice is a clean refusal, not a second answer", async () => {
    const approvalId = await seedApproval();
    await answerAction({ userId: "u1" }, { approvalId, choice: "approve" });

    // The CAS behind the chokepoint makes the loser a clean 409 rather
    // than an overwrite of the decision that landed first.
    await expect(
      answerAction({ userId: "u1" }, { approvalId, choice: "reject" }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await getWorkflowApprovalById(approvalId))?.answerChoice).toBe("approve");
  });

  test("a missing approvalId or choice is rejected before anything is touched", async () => {
    const spy = spyOn(guardModule, "requireItemConsent");
    const before = spy.mock.calls.length;

    await expect(answerAction({ userId: "u1" }, {})).rejects.toMatchObject({ status: 400 });
    await expect(answerAction({ userId: "u1" }, { approvalId: "x" })).rejects.toMatchObject({
      status: 400,
    });

    expect(spy.mock.calls.length).toBe(before);
    spy.mockRestore();
  });

  test("an unknown approval is 404, mapped from the chokepoint's own code", async () => {
    await expect(
      answerAction({ userId: "u1" }, { approvalId: crypto.randomUUID(), choice: "approve" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("crafted itemIds are NOT forwarded — this surface ticks nothing", async () => {
    // The tab renders no checkboxes, so any list arriving here was not
    // chosen by the human. Forwarding it would assert consent nobody gave;
    // dropping it means the guard sees an empty selection and refuses,
    // which is the fail-closed outcome.
    const approvalId = await seedApproval({ requireItemConsent: true, itemIds: ["a", "b"] });

    await expect(
      answerAction({ userId: "u1" }, { approvalId, choice: "approve", itemIds: ["a", "b"] }),
    ).rejects.toMatchObject({ status: 400 });

    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
  });
});

describe("the Hub approvals tab renders", () => {
  test("an empty tab says so", async () => {
    const tree = await provider.render({ userId: "u1" });
    expect(tree.nodes[0]).toMatchObject({ type: "status", state: "idle" });
  });

  test("a pending approval renders its prompt and one button per choice", async () => {
    await seedApproval();
    const tree = await provider.render({ userId: "u1" });

    const buttons = tree.nodes.filter((n) => n.type === "button");
    expect(buttons.map((b) => (b as { label: string }).label)).toEqual(["approve", "reject"]);
    expect(JSON.stringify(tree.nodes)).toContain("Ship it?");
  });

  test("it shows only the caller's own approvals", async () => {
    await seedApproval({ userId: "u2" });
    const tree = await provider.render({ userId: "u1" });
    // The leak that matters is the PROMPT, which names what is about to be
    // done and to what.
    expect(JSON.stringify(tree.nodes)).not.toContain("Ship it?");
  });

  test("an ITEM-CONSENT approval renders NO answer button, only a pointer", async () => {
    // Offering a button here would send no items (refused, and the user
    // cannot act on the error) or all of them (consent laundering). The
    // honest surface is the one that says where the decision can be made.
    await seedApproval({ requireItemConsent: true, itemIds: ["a.ts"] });
    const tree = await provider.render({ userId: "u1" });

    expect(tree.nodes.filter((n) => n.type === "button")).toHaveLength(0);
    expect(JSON.stringify(tree.nodes)).toContain("/workflows/approvals");
  });
});

describe("registration", () => {
  test("registerWorkflowApprovalsHubPage actually registers an answerable provider", async () => {
    // Not just "the function exists": the boot wiring in context.ts calls
    // this, and a provider that registered under the wrong id — or with no
    // answer action — would leave the Hub tab present and dead.
    hubPages._resetHubPageProvidersForTests();
    registerWorkflowApprovalsHubPage();

    const registered = hubPages.getHubPageProvider(WORKFLOW_APPROVALS_HUB_PAGE_ID);
    expect(registered).toBeDefined();
    expect(typeof registered!.actions?.[WORKFLOW_APPROVALS_ANSWER_ACTION]).toBe("function");
    // And it renders — a provider whose render throws is a broken tab.
    await expect(registered!.render({ userId: "u1" })).resolves.toMatchObject({
      title: "Approvals",
    });
  });
});
