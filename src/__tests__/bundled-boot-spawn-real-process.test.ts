// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { PGlite, drizzle, mkdtemp, rm, tmpdir, join, up, DatabaseLifecycleRepository, ExtensionLifecycle, actor, harness, releaseFixture, approved } from "./helpers/durable-lifecycle-fixture";

test("lost acknowledgement is durable and recovers without a second pointer switch", async () => {
    let failPublish = true;
    const setup = await releaseFixture(harness({ async publish() { if (failPublish) throw new Error("lost acknowledgement"); } }));
    const activation = await setup.lifecycle.activate(actor, await approved(setup));
    expect(activation.state).toBe("reconciling");
    let state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.generation).toBe(1);
    expect(state.installation.acknowledgedGeneration).toBe(0);
    failPublish = false;
    await new ExtensionLifecycle(setup.dependencies).recover(actor, setup.installation.id);
    state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.generation).toBe(1);
    expect(state.installation.acknowledgedGeneration).toBe(1);
    expect(state.operations[activation.id]?.state).toBe("active");
  });

test("queued builds survive closing and reopening the actual database", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "extension-db-restart-"));
    let persistent = new PGlite(storagePath);
    try {
      let driver = drizzle(persistent);
      await up(driver);
      const setup = harness({ repository: new DatabaseLifecycleRepository(driver) });
      const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "persisted" } });
      const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "restart" });
      await persistent.close();
      persistent = new PGlite(storagePath);
      driver = drizzle(persistent);
      const restarted = new ExtensionLifecycle({ ...setup.dependencies, repository: new DatabaseLifecycleRepository(driver) });
      await restarted.recover(actor, installation.id);
      const state = await restarted.inspect(actor, installation.id);
      expect(state.operations[operation.id]?.state).toBe("verified");
      expect(Object.keys(state.revisions)).toHaveLength(1);
    } finally { await persistent.close(); await rm(storagePath, { recursive: true, force: true }); }
  });
