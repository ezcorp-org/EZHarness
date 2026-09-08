// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { actor, human, database, releaseFixture, approved } from "./helpers/durable-lifecycle-fixture";

test("approval and lifecycle mutations audit atomically once with the real actor and retained release binding", async () => {
    const setup = await releaseFixture();
    const input = await approved(setup);
    await setup.lifecycle.activate(actor, input);
    await setup.lifecycle.activate(actor, input);
    await setup.lifecycle.disable(human, input.installationId);
    await setup.lifecycle.disable(human, input.installationId);
    await setup.lifecycle.uninstall(human, input.installationId);
    await setup.lifecycle.uninstall(human, input.installationId);
    const rows = (await database.query<{ action: string; user_id: string; metadata: Record<string, unknown> }>("SELECT action, user_id, metadata FROM audit_log WHERE target = $1 ORDER BY created_at", [input.installationId])).rows;
    for (const action of ["ext:approval_pending", "ext:approval_approved", "ext:approval_consumed", "ext:activated", "ext:disabled", "ext:uninstalled"]) expect(rows.filter((row) => row.action === action)).toHaveLength(1);
    expect(rows.find((row) => row.action === "ext:approval_approved")).toMatchObject({ user_id: human.principalId, metadata: { actorKind: "human", approvalReleaseId: setup.releaseId } });
    expect(rows.find((row) => row.action === "ext:uninstalled")).toMatchObject({ metadata: { purgeData: false, source: "release-v4", oldVersion: "1.0.0", releaseId: setup.releaseId } });
  });

test("audit storage failure rolls back consent and retry cannot duplicate the decision", async () => {
    const setup = await releaseFixture();
    const approval = await setup.lifecycle.requestApproval(actor, { installationId: setup.installation.id, releaseId: setup.releaseId, grants: [], expectedActiveReleaseId: null });
    await database.exec("ALTER TABLE audit_log RENAME TO unavailable_audit_log");
    try { await expect(setup.lifecycle.approve(human, setup.installation.id, approval.id, true)).rejects.toThrow(); }
    finally { await database.exec("ALTER TABLE unavailable_audit_log RENAME TO audit_log"); }
    expect((await setup.lifecycle.inspect(actor, setup.installation.id)).approvals[approval.id]?.status).toBe("pending");
    await setup.lifecycle.approve(human, setup.installation.id, approval.id, true);
    expect((await database.query("SELECT id FROM audit_log WHERE target = $1 AND action = 'ext:approval_approved'", [setup.installation.id])).rows).toHaveLength(1);
  });

test("a rejected capability review records the human decision once without publishing", async () => {
  const setup = await releaseFixture();
  const approval = await setup.lifecycle.requestApproval(actor, { installationId: setup.installation.id, releaseId: setup.releaseId, grants: ["events:read"], expectedActiveReleaseId: null });
  const rejected = await setup.lifecycle.approve(human, setup.installation.id, approval.id, false);
  expect(rejected.status).toBe("rejected");
  expect(rejected.approvedBy).toBe(human.principalId);
  await expect(setup.lifecycle.approve(human, setup.installation.id, approval.id, true)).rejects.toMatchObject({ code: "approval_decided" });
  const state = await setup.lifecycle.inspect(actor, setup.installation.id);
  expect(state.installation.activeReleaseId).toBeNull();
  expect(state.installation.grants).toEqual([]);
  expect(setup.published).toEqual([]);
  expect((await database.query("SELECT action FROM audit_log WHERE target = $1 AND action = 'ext:approval_rejected'", [setup.installation.id])).rows).toHaveLength(1);
});
