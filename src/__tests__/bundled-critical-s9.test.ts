// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { LifecycleError, actor, human, harness, releaseFixture, approved } from "./helpers/durable-lifecycle-fixture";

test("the builder cannot self-approve and stale approval cannot replace a generation", async () => {
    const setup = await releaseFixture();
    const pending = await setup.lifecycle.requestApproval(actor, { installationId: setup.installation.id, releaseId: setup.releaseId, grants: [], expectedActiveReleaseId: null });
    await expect(setup.lifecycle.approve(actor, setup.installation.id, pending.id, true)).rejects.toMatchObject({ code: "human_approval_required" });
    await expect(setup.lifecycle.activate(actor, { installationId: setup.installation.id, approvalId: pending.id, idempotencyKey: "self" })).rejects.toMatchObject({ code: "stale_approval" });
    const first = await approved(setup);
    await setup.lifecycle.approve(human, setup.installation.id, pending.id, true);
    expect((await setup.lifecycle.activate(actor, first)).state).toBe("active");
    expect((await setup.lifecycle.activate(actor, first)).state).toBe("active");
    expect(setup.published).toEqual([1]);
    await expect(setup.lifecycle.activate(actor, { ...first, approvalId: pending.id, idempotencyKey: "stale" })).rejects.toMatchObject({ code: "stale_approval" });
  });

test("an explicit host access policy permits admin approval without changing owner binding", async () => {
    const setup = await releaseFixture(harness({ async authorizeAccess(candidate) { if (!["owner", "admin"].includes(candidate.principalId)) throw new LifecycleError("not_found", "Installation not found."); } }));
    const approval = await setup.lifecycle.requestApproval(actor, { installationId: setup.installation.id, releaseId: setup.releaseId, grants: [], expectedActiveReleaseId: null });
    const result = await setup.lifecycle.approve({ principalId: "admin", scope: "global", kind: "human" }, setup.installation.id, approval.id, true);
    expect(result.principalId).toBe("owner");
    expect(result.scope).toBe("project:one");
    expect(result.approvedBy).toBe("admin");
  });
