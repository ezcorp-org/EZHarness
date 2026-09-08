// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { ExtensionLifecycle, actor, repository, harness, releaseFixture, approved } from "./helpers/durable-lifecycle-fixture";
import type { LifecycleRepository } from "./helpers/durable-lifecycle-fixture";

test("a transaction failure before pointer commit leaves the old active release", async () => {
    let failCommit = false;
    const faulty: LifecycleRepository = {
      create: (state) => repository.create(state), read: (id) => repository.read(id), list: (owner, scope) => repository.list(owner, scope),
      transact: (id, change) => repository.transact(id, async (state) => { const result = await change(state); if (failCommit && state.installation.status === "reconciling") throw new Error("database unavailable"); return result; }),
    };
    const setup = await releaseFixture(harness({ repository: faulty }));
    const input = await approved(setup);
    failCommit = true;
    expect((await setup.lifecycle.activate(actor, input)).state).toBe("failed");
    const state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.activeReleaseId).toBeNull();
    expect(state.approvals[input.approvalId]?.status).toBe("approved");
  });

test("a lost database response after pointer commit resumes the durable outbox", async () => {
    let loseResponse = false;
    const faulty: LifecycleRepository = {
      create: (state) => repository.create(state), read: (id) => repository.read(id), list: (owner, scope) => repository.list(owner, scope),
      async transact(id, change) {
        const result = await repository.transact(id, change);
        if (loseResponse && (await repository.read(id))?.installation.status === "reconciling") { loseResponse = false; throw new Error("connection lost after commit"); }
        return result;
      },
    };
    const setup = await releaseFixture(harness({ repository: faulty }));
    const input = await approved(setup);
    loseResponse = true;
    expect((await setup.lifecycle.activate(actor, input)).state).toBe("reconciling");
    await new ExtensionLifecycle(setup.dependencies).recover(actor, setup.installation.id);
    const state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.generation).toBe(1);
    expect(state.installation.status).toBe("active");
    expect(state.installation.activeReleaseId).toBe(setup.releaseId);
    expect(state.installation.acknowledgedGeneration).toBe(state.installation.generation);
    expect(state.installation.grants).toEqual(["storage:read"]);
    expect(state.approvals[input.approvalId]?.status).toBe("consumed");
  });
