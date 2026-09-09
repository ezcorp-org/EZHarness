// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { ExtensionLifecycle, actor, harness } from "./helpers/durable-lifecycle-fixture";

test("expired build holders cannot publish after another worker recovers", async () => {
    let now = 1_000;
    let unblock: () => void = () => {};
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const setup = harness({ now: () => now, leaseMs: 100 });
    const build = setup.dependencies.runner.build;
    let calls = 0;
    setup.dependencies.runner.build = async (request) => { calls += 1; if (calls === 1) await blocked; return build(request); };
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "one" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "lease" });
    const stale = setup.lifecycle.runBuild(actor, installation.id, operation.id);
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    now += 101;
    await new ExtensionLifecycle(setup.dependencies).recover(actor, installation.id);
    unblock();
    await stale;
    const state = await setup.lifecycle.inspect(actor, installation.id);
    expect(state.operations[operation.id]?.state).toBe("verified");
    expect(Object.keys(state.releases)).toHaveLength(1);
    expect(state.operations[operation.id]?.lease?.fence).toBe(2);
  });

test("cancel fences a build that returns after cancellation", async () => {
    const setup = harness();
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "one" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "cancel" });
    let started = false;
    let unblock: () => void = () => {};
    const build = setup.dependencies.runner.build;
    setup.dependencies.runner.build = async (input) => { started = true; await new Promise<void>((resolve) => { unblock = resolve; }); return build(input); };
    const running = setup.lifecycle.runBuild(actor, installation.id, operation.id);
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
    await setup.lifecycle.cancel(actor, installation.id, operation.id);
    unblock();
    expect((await running).state).toBe("cancelled");
    expect(Object.keys((await setup.lifecycle.inspect(actor, installation.id)).releases)).toHaveLength(0);
  });

test("a cancelled accepted build retries a failed runner stop", async () => {
    const setup = harness();
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "one" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "cancel-retry" });
    let started: () => void = () => {};
    const runningGate = new Promise<void>(resolve => { started = resolve; });
    let unblock: () => void = () => {};
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const build = setup.dependencies.runner.build;
    setup.dependencies.runner.build = async input => { started(); await blocked; return build(input); };
    let cancels = 0;
    setup.dependencies.runner.cancel = async () => { cancels += 1; if (cancels === 1) throw new Error("runner stop unavailable"); };
    const running = setup.lifecycle.runBuild(actor, installation.id, operation.id);
    await runningGate;
    await expect(setup.lifecycle.cancel(actor, installation.id, operation.id)).rejects.toThrow("runner stop unavailable");
    await expect(setup.lifecycle.cancel(actor, installation.id, operation.id)).resolves.toMatchObject({ state: "cancelled" });
    unblock();
    expect((await running).state).toBe("cancelled");
    expect(cancels).toBe(2);
  });
