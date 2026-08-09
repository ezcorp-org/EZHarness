/**
 * e2e (real tier): the approvals inbox is scoped, and answering is scoped
 * the same way — C3 R2-c.
 *
 * R2-c widens two predicates that decide who can see and who can clear a
 * parked consent gate:
 *
 *   - `listPendingWorkflowApprovalsForUser` gains a disjunct so a
 *     service-account run's approval reaches the human who consented to
 *     its delegation, and
 *   - the answer route now RESOLVES which `ApprovalActor` to mint instead
 *     of always minting `kind: "user"`.
 *
 * Widening a scoping predicate is exactly the change that leaks by
 * accident: an `OR` over a `LEFT JOIN` is one mistake away from matching
 * every row whose delegation is NULL — which is every row in the system
 * today. So this locks the half that a leak would break, over real HTTP,
 * with two real sessions and a really-parked approval.
 *
 * ## What this proves, and what it deliberately does not
 *
 * It drives the NEW resolver in production, both ways: the member holds no
 * delegated capacity, is therefore minted a plain `user` actor, and is
 * refused; the admin is minted their own and gets through. Neither
 * outcome is available to a change that widened the query wrongly.
 *
 * It does NOT assert the positive delegated case, and that is a statement
 * about the tree rather than a gap in the test: nothing writes
 * `workflow_runs.delegation_id` until C3 phase 6 lands the `runFor`
 * handler, so a delegated run cannot be created over HTTP yet. That half
 * is proved against real rows in
 * `src/__tests__/workflow-approvals-delegated-inbox.test.ts` and
 * `src/__tests__/workflow-answer-approval.test.ts`.
 *
 * Real tier because the whole claim is about server-side scoping: the mock
 * tier stubs `GET /api/workflows/approvals` outright, so it could only
 * assert the fixture.
 */
import { test, expect } from "../fixtures/hydration.js";

const APPROVAL_STEP = {
  name: "gate",
  kind: "approval",
  prompt: "Ship the release?",
  choices: ["approve", "reject"],
};

test.describe("the approvals inbox and the answer route are scoped to the same people", () => {
  test("a member neither sees nor can answer another user's parked approval; the owner can", async ({
    request,
    playwright,
    baseURL,
  }) => {
    // ── A really parked approval, owned by the bootstrapped admin ──
    const workflowName = `e2e-approvals-scope-${Date.now()}`;
    const created = await request.post("/api/workflows", {
      data: {
        name: workflowName,
        description: "approvals inbox scoping e2e",
        steps: [APPROVAL_STEP],
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    const run = await request.post(`/api/workflows/${workflowName}/run`, { data: {} });
    expect(run.status(), await run.text()).toBe(200);

    const ownerInbox = await request.get("/api/workflows/approvals");
    expect(ownerInbox.status(), await ownerInbox.text()).toBe(200);
    const owned = (await ownerInbox.json()) as {
      approvals: Array<{ id: string; workflowName: string }>;
    };
    const parked = owned.approvals.find((a) => a.workflowName === workflowName);
    // Without this the "member cannot see it" assertion below would be
    // unfalsifiable — an inbox that is empty for everybody passes it.
    expect(parked, "the run must actually have parked on its approval").toBeTruthy();

    // ── A second, real, NON-ADMIN human ──
    const email = `e2e-approvals-member-${Date.now()}@example.com`;
    const invited = await request.post("/api/auth/invite", {
      data: { email, role: "member" },
    });
    expect(invited.status(), await invited.text()).toBe(201);
    const { invite } = (await invited.json()) as { invite: { token: string } };

    // Its own context, so the admin's storage-state cookie is provably
    // absent: the ONLY authority here is the member's own session.
    const member = await playwright.request.newContext({ baseURL });
    const accepted = await member.post(`/api/auth/invite/${invite.token}`, {
      data: { name: "E2E Member", email, password: "E2e-Consent-Pw-9x!" },
    });
    expect(accepted.status(), await accepted.text()).toBe(201);

    const whoami = await member.get("/api/auth/me");
    expect(whoami.status(), await whoami.text()).toBe(200);
    const me = (await whoami.json()) as { user: { id: string; role: string } };
    // A member, not an admin — an admin sees every approval by design, so
    // the whole test would be vacuous if the invite had minted one.
    expect(me.user.role).toBe("member");

    // ── The scoping, both surfaces ──
    const memberInbox = await member.get("/api/workflows/approvals");
    // 200, not 403: the absence below is a SCOPING decision, not an error
    // that happens to hide the row.
    expect(memberInbox.status(), await memberInbox.text()).toBe(200);
    const theirs = (await memberInbox.json()) as { approvals: Array<{ id: string }> };
    expect(theirs.approvals.map((a) => a.id)).not.toContain(parked!.id);

    // …and the row they cannot see, they cannot clear. This is the new
    // resolver running for real: the member holds no delegated capacity
    // over this run, so a `user` actor is minted for them and the
    // chokepoint refuses it.
    const memberAnswer = await member.post(`/api/workflows/approvals/${parked!.id}`, {
      data: { choice: "approve" },
    });
    expect(memberAnswer.status(), await memberAnswer.text()).toBe(403);

    // ── The control: the owner still answers their own gate ──
    // Without this half, a change that refused EVERYONE would pass every
    // assertion above.
    const ownerAnswer = await request.post(`/api/workflows/approvals/${parked!.id}`, {
      data: { choice: "approve" },
    });
    expect(ownerAnswer.status(), await ownerAnswer.text()).toBe(200);

    // The decision is spent: it leaves the owner's inbox too.
    const after = await request.get("/api/workflows/approvals");
    const remaining = (await after.json()) as { approvals: Array<{ id: string }> };
    expect(remaining.approvals.map((a) => a.id)).not.toContain(parked!.id);

    await member.dispose();
  });
});
