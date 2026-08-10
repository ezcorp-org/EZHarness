/**
 * Server-handler unit tests for GET /api/workflows/approvals — the inbox.
 *
 * The scoping itself is SQL and is tested against a real DB in
 * `src/__tests__/workflow-run-control.test.ts`. What is verifiable only
 * here is that the handler hands the query the right coordinates: this
 * caller's id, and an admin flag derived from the role rather than
 * assumed. A route that passed `true` would show every user every other
 * user's parked decisions while every DB-level test stayed green.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectThrownResponse } from "./helpers/server-route-test-utils";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const q = vi.hoisted(() => ({ listPendingWorkflowApprovalsForUser: vi.fn() }));
vi.mock("$server/db/queries/workflow-approvals", () => ({
  listPendingWorkflowApprovalsForUser: q.listPendingWorkflowApprovalsForUser,
}));

const { GET } = await import("../routes/api/workflows/approvals/+server");

beforeEach(() => {
  q.listPendingWorkflowApprovalsForUser.mockReset().mockResolvedValue([]);
});

const member = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };
const admin = { user: { id: "a1", email: "a@x", name: "a", role: "admin" } };

function makeEvent(locals: Record<string, unknown> = {}) {
  return makeRequestEvent("http://localhost/api/workflows/approvals", {
    locals,
    params: {},
  });
}

describe("GET /api/workflows/approvals", () => {
  test("403 when the API key lacks 'read', and nothing is queried", async () => {
    const res = await GET(makeEvent({ ...member, apiKeyScopes: ["chat"] }));
    expect(res.status).toBe(403);
    expect(q.listPendingWorkflowApprovalsForUser).not.toHaveBeenCalled();
  });

  test("401 when unauthenticated, and nothing is queried", async () => {
    await expectThrownResponse(() => GET(makeEvent()), 401);
    expect(q.listPendingWorkflowApprovalsForUser).not.toHaveBeenCalled();
  });

  test("a member is queried as NON-admin", async () => {
    await GET(makeEvent(member));
    expect(q.listPendingWorkflowApprovalsForUser).toHaveBeenCalledWith("u1", false);
  });

  test("an admin is queried as admin", async () => {
    await GET(makeEvent(admin));
    expect(q.listPendingWorkflowApprovalsForUser).toHaveBeenCalledWith("a1", true);
  });

  test("projects the fields the inbox renders, and nothing the answer path owns", async () => {
    const createdAt = new Date("2026-07-30T09:00:00.000Z");
    q.listPendingWorkflowApprovalsForUser.mockResolvedValue([
      {
        workflowRunId: "run-1",
        workflowName: "ship-it",
        approval: {
          id: "ap-1",
          workflowRunId: "run-1",
          stepName: "gate",
          prompt: "Ship it?",
          choices: ["approve", "reject"],
          requireItemConsent: true,
          itemIds: ["a", "b"],
          formSchema: null,
          expiresAt: null,
          createdAt,
          // Answer-side columns: present on the row, deliberately NOT
          // projected — the inbox lists questions, it does not report who
          // answered what.
          answeredBy: "someone",
          answerChoice: "approve",
          consentAllUsed: true,
        },
      },
    ]);

    const res = await GET(makeEvent(member));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: Array<Record<string, unknown>> };

    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]).toMatchObject({
      id: "ap-1",
      workflowRunId: "run-1",
      workflowName: "ship-it",
      stepName: "gate",
      prompt: "Ship it?",
      choices: ["approve", "reject"],
      requireItemConsent: true,
      itemIds: ["a", "b"],
    });
    expect(body.approvals[0]).not.toHaveProperty("answeredBy");
    expect(body.approvals[0]).not.toHaveProperty("answerChoice");
    expect(body.approvals[0]).not.toHaveProperty("consentAllUsed");
  });

  test("an empty inbox is an empty list, not an error", async () => {
    const res = await GET(makeEvent(member));
    expect(res.status).toBe(200);
    expect((await res.json()) as { approvals: unknown[] }).toEqual({ approvals: [] });
  });
});
