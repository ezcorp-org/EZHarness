// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { actor, human, database, releaseFixture, approved } from "./helpers/durable-lifecycle-fixture";

test("disable revokes pending approvals and uninstall retains source, releases, and user data", async () => {
    const setup = await releaseFixture();
    await database.exec("CREATE TABLE IF NOT EXISTS fixture_user_data (value TEXT); INSERT INTO fixture_user_data VALUES ('keep-me')");
    const pending = await approved(setup);
    await setup.lifecycle.disable(actor, setup.installation.id);
    await expect(setup.lifecycle.activate(actor, pending)).rejects.toMatchObject({ code: "stale_approval" });
    const fresh = await approved(setup, "fresh");
    expect((await setup.lifecycle.activate(actor, fresh)).state).toBe("active");
    await setup.lifecycle.uninstall(actor, setup.installation.id);
    const state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.uninstalled).toBe(true);
    expect(state.installation.enabled).toBe(false);
    expect(state.releases[setup.releaseId]).toBeDefined();
    expect((await setup.lifecycle.readWorkspace(actor, setup.installation.id, setup.workspace.id)).files["extension.ts"]).toBe("export default 1");
    expect((await database.query("SELECT value FROM fixture_user_data")).rows).toContainEqual({ value: "keep-me" });
  });

test("only human approval revocation stops a candidate and consumed consent requires disable", async () => {
    const setup = await releaseFixture();
    const activation = await approved(setup);
    await expect(setup.lifecycle.revokeApproval(actor, setup.installation.id, activation.approvalId)).rejects.toMatchObject({ code: "human_approval_required" });
    expect((await setup.lifecycle.revokeApproval(human, setup.installation.id, activation.approvalId)).status).toBe("revoked");
    await expect(setup.lifecycle.activate(actor, activation)).rejects.toMatchObject({ code: "stale_approval" });
    const replacement = await approved(setup, "replacement");
    expect((await setup.lifecycle.activate(actor, replacement)).state).toBe("active");
    await expect(setup.lifecycle.revokeApproval(human, setup.installation.id, replacement.approvalId)).rejects.toMatchObject({ code: "operation_committed" });
  });
