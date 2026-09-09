import type { LifecycleActor } from "../extensions/v4/types";
// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { RunnerError, runnerBusyRetryMs, LifecycleError, createLifecycleRecoveryScheduler, actor, harness } from "./helpers/durable-lifecycle-fixture";

test("a runner-busy build retains its operation and advances its durable fence on recovery", async () => {
    let now = 1_000;
    const setup = harness({ now: () => now });
    const build = setup.dependencies.runner.build;
    let calls = 0;
    setup.dependencies.runner.build = async request => {
      calls += 1;
      if (calls === 1) throw new RunnerError("runner_busy", "Build concurrency limit reached", "queue", true);
      return build(request);
    };
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "queued" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "runner-busy-recover" });
    const queued = await setup.lifecycle.runBuild(actor, installation.id, operation.id);
    expect(queued).toMatchObject({ state: "queued", lease: { fence: 1, until: now + runnerBusyRetryMs(1) } });
    await setup.lifecycle.recover(actor, installation.id);
    expect(calls).toBe(1);
    now += runnerBusyRetryMs(1);
    await setup.lifecycle.recover(actor, installation.id);
    const recovered = await setup.lifecycle.inspect(actor, installation.id).then(state => state.operations[operation.id]!);
    expect(recovered).toMatchObject({ id: operation.id, state: "verified", lease: { fence: 2 } });
    expect(Object.keys((await setup.lifecycle.inspect(actor, installation.id)).releases)).toHaveLength(1);
  });

test("cancelling a queued runner-busy retry does not cancel its stale runner holder", async () => {
    let buildCalls = 0;
    let cancelCalls = 0;
    const setup = harness({ runner: { async build() { buildCalls += 1; throw new RunnerError("runner_busy", "Build concurrency limit reached", "queue", true); }, async collectArtifacts() { throw new Error("not reached"); }, async cancel() { cancelCalls += 1; throw new Error("stale holder must not be cancelled"); } } });
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "cancel" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "cancel-busy" });
    expect((await setup.lifecycle.runBuild(actor, installation.id, operation.id)).state).toBe("queued");
    await expect(setup.lifecycle.cancel(actor, installation.id, operation.id)).resolves.toMatchObject({ state: "cancelled" });
    await setup.lifecycle.recover(actor, installation.id);
    expect({ buildCalls, cancelCalls }).toEqual({ buildCalls: 1, cancelCalls: 0 });
  });

test("a later accepted build cancels its live holder after an earlier runner-busy retry", async () => {
    let now = 1_000;
    let firstHolder: string | undefined;
    let started: () => void = () => {};
    const startedBuild = new Promise<void>(resolve => { started = resolve; });
    let unblock: () => void = () => {};
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const cancelled: string[] = [];
    const setup = harness({ now: () => now });
    const build = setup.dependencies.runner.build;
    let calls = 0;
    setup.dependencies.runner.build = async input => {
      calls += 1;
      if (calls === 1) { firstHolder = input.operationId; throw new RunnerError("runner_busy", "Build concurrency limit reached", "queue", true); }
      started();
      await blocked;
      return build(input);
    };
    setup.dependencies.runner.cancel = async holder => { cancelled.push(holder); };
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "retry-then-cancel" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "retry-then-cancel" });
    expect((await setup.lifecycle.runBuild(actor, installation.id, operation.id)).state).toBe("queued");
    now += runnerBusyRetryMs(1);
    const accepted = setup.lifecycle.runBuild(actor, installation.id, operation.id);
    await startedBuild;
    const liveHolder = (await setup.lifecycle.inspect(actor, installation.id)).operations[operation.id]?.lease?.holder;
    if (!liveHolder) throw new Error("The accepted build must hold a cancellation lease.");
    await setup.lifecycle.cancel(actor, installation.id, operation.id);
    unblock();
    expect((await accepted).state).toBe("cancelled");
    expect(cancelled).toEqual([liveHolder]);
    expect(liveHolder).not.toBe(firstHolder);
  });

test("a completed build drains another installation deferred by runner capacity", async () => {
    const setup = harness();
    const originalBuild = setup.dependencies.runner.build;
    let active = false;
    let firstStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let calls = 0;
    setup.dependencies.runner.build = async request => {
      if (active) throw new RunnerError("runner_busy", "Build concurrency limit reached", "queue", true);
      active = true;
      try {
        calls += 1;
        if (calls === 1) { firstStarted(); await firstGate; }
        return await originalBuild(request);
      } finally { active = false; }
    };
    const first = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "first" } });
    const second = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "second" } });
    const firstOperation = await setup.lifecycle.build(actor, { installationId: first.installation.id, workspaceId: first.workspace.id, expectedRevision: 1, idempotencyKey: "first" });
    const secondOperation = await setup.lifecycle.build(actor, { installationId: second.installation.id, workspaceId: second.workspace.id, expectedRevision: 1, idempotencyKey: "second" });
    const scheduler = createLifecycleRecoveryScheduler(async () => {
      await setup.lifecycle.recover(actor, first.installation.id);
      await setup.lifecycle.recover(actor, second.installation.id, { capacityAvailable: true });
      return undefined;
    }, error => { throw error; });
    setup.dependencies.onBuildSettled = deferredByRunner => scheduler.request({ followUp: !deferredByRunner });
    const firstRun = setup.lifecycle.runBuild(actor, first.installation.id, firstOperation.id);
    await started;
    expect((await setup.lifecycle.runBuild(actor, second.installation.id, secondOperation.id)).state).toBe("queued");
    releaseFirst();
    await firstRun;
    await scheduler.drain();
    const state = await setup.lifecycle.inspect(actor, second.installation.id);
    expect(state.operations[secondOperation.id]).toMatchObject({ id: secondOperation.id, state: "verified" });
  });

test("a post-build owner denial still wakes another queued installation", async () => {
    let ownerActive = true;
    const other: LifecycleActor = { ...actor, principalId: "other" };
    const setup = harness({ async authorizeAccess(current) { if (current.principalId === actor.principalId && !ownerActive) throw new LifecycleError("unauthorized", "Owner deactivated"); } });
    const originalBuild = setup.dependencies.runner.build;
    let active = false;
    let firstStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let calls = 0;
    setup.dependencies.runner.build = async request => {
      if (active) throw new RunnerError("runner_busy", "Build concurrency limit reached", "queue", true);
      active = true;
      try {
        calls += 1;
        if (calls === 1) { firstStarted(); await firstGate; }
        return await originalBuild(request);
      } finally { active = false; }
    };
    const first = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "first" } });
    const second = await setup.lifecycle.createWorkspace(other, { files: { "extension.ts": "second" } });
    const firstOperation = await setup.lifecycle.build(actor, { installationId: first.installation.id, workspaceId: first.workspace.id, expectedRevision: 1, idempotencyKey: "first-denied" });
    const secondOperation = await setup.lifecycle.build(other, { installationId: second.installation.id, workspaceId: second.workspace.id, expectedRevision: 1, idempotencyKey: "second-queued" });
    const scheduler = createLifecycleRecoveryScheduler(async () => {
      try { await setup.lifecycle.recover(actor, first.installation.id); } catch { /* owner denial remains visible to its installation */ }
      await setup.lifecycle.recover(other, second.installation.id, { capacityAvailable: true });
      return undefined;
    }, error => { throw error; });
    setup.dependencies.onBuildSettled = deferredByRunner => scheduler.request({ followUp: !deferredByRunner });
    const firstRun = setup.lifecycle.runBuild(actor, first.installation.id, firstOperation.id);
    await started;
    expect((await setup.lifecycle.runBuild(other, second.installation.id, secondOperation.id)).state).toBe("queued");
    ownerActive = false;
    releaseFirst();
    await expect(firstRun).rejects.toMatchObject({ code: "unauthorized" });
    await scheduler.drain();
    expect((await setup.lifecycle.inspect(other, second.installation.id)).operations[secondOperation.id]?.state).toBe("verified");
  });
