// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { ExtensionLifecycle, actor, releaseFixture, approved } from "./helpers/durable-lifecycle-fixture";

test("policy drift invalidates previously approved releases", async () => {
    const setup = await releaseFixture();
    const input = await approved(setup);
    const changedPolicy = new ExtensionLifecycle({ ...setup.dependencies, buildLimits: { ...setup.dependencies.buildLimits, memoryBytes: 2048 } });
    await expect(changedPolicy.activate(actor, input)).rejects.toMatchObject({ code: "stale_approval" });
  });

test("rollback requires a fresh exact approval and keeps data", async () => {
    const setup = await releaseFixture();
    await setup.lifecycle.activate(actor, await approved(setup));
    const workspace = await setup.lifecycle.editWorkspace(actor, { installationId: setup.installation.id, workspaceId: setup.workspace.id, expectedRevision: 1, writes: { "extension.ts": "version-two" } });
    const operation = await setup.lifecycle.build(actor, { installationId: setup.installation.id, workspaceId: workspace.id, expectedRevision: 2, idempotencyKey: "build-two" });
    const built = await setup.lifecycle.runBuild(actor, setup.installation.id, operation.id);
    await setup.lifecycle.activate(actor, await approved({ ...setup, releaseId: built.releaseId! }, "activate-two"));
    const rollback = await approved(setup, "rollback");
    expect((await setup.lifecycle.rollback(actor, rollback)).state).toBe("active");
    expect((await setup.lifecycle.inspect(actor, setup.installation.id)).installation.activeReleaseId).toBe(setup.releaseId);
  });

test("repeated disable preserves the immutable release and advances authority only once", async () => {
  const setup = await releaseFixture();
  await setup.lifecycle.activate(actor, await approved(setup));
  const active = await setup.lifecycle.inspect(actor, setup.installation.id);
  const stopped = await setup.lifecycle.disable(actor, setup.installation.id);
  expect(stopped.enabled).toBe(false);
  expect(stopped.grants).toEqual([]);
  expect(stopped.generation).toBe(active.installation.generation + 1);
  expect(stopped.activeReleaseId).toBe(setup.releaseId);
  expect(await setup.lifecycle.disable(actor, setup.installation.id)).toEqual(stopped);
  const retained = await setup.lifecycle.inspect(actor, setup.installation.id);
  expect(retained.releases).toEqual(active.releases);
  expect(retained.workspaces).toEqual(active.workspaces);
  expect(retained.installation.acknowledgedGeneration).toBe(stopped.generation);
});
