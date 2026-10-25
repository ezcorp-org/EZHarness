// A build whose runner could not be reached is re-queued like a busy runner, with the same backoff, and fails
// with a named diagnostic after a bounded number of attempts. Before this, the client's raw `socket hang up`
// reached the lifecycle unclassified: it logged "Operation failed with an unclassified error" and failed the
// build for good (real-auth lane, run 40217994555, the bundled scratchpad build at teardown).
import { expect, test } from "bun:test";
import { RunnerError, runnerBusyRetryMs, actor, harness } from "./helpers/durable-lifecycle-fixture";

/** The bound the lifecycle exports; the last test proves the two agree. */
const MAX_ATTEMPTS = 6;

const unavailable = () => new RunnerError("runner_unavailable", "The extension runner could not be reached", "runner", true, { errorClass: "Error", errorCode: "ECONNRESET" });

test("an unreachable runner re-queues the build with the busy backoff, and the next attempt builds it", async () => {
  let now = 1_000;
  const setup = harness({ now: () => now });
  const build = setup.dependencies.runner.build;
  let calls = 0;
  setup.dependencies.runner.build = async (request) => {
    calls += 1;
    if (calls === 1) throw unavailable();
    return build(request);
  };
  const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "unreachable-once" } });
  const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "runner-unavailable-recover" });
  const queued = await setup.lifecycle.runBuild(actor, installation.id, operation.id);
  expect(queued).toMatchObject({ state: "queued", lease: { fence: 1, until: now + runnerBusyRetryMs(1) } });
  expect(queued.diagnostics).toEqual([{ code: "runner_unavailable", message: "The runner could not be reached; retry after it restarts.", retryable: true, stage: "runner" }]);
  now += runnerBusyRetryMs(1);
  await setup.lifecycle.recover(actor, installation.id);
  const recovered = (await setup.lifecycle.inspect(actor, installation.id)).operations[operation.id]!;
  expect(recovered).toMatchObject({ state: "verified", lease: { fence: 2 } });
  expect(calls).toBe(2);
});

test(`an always-unreachable runner fails the build, named, after ${MAX_ATTEMPTS} attempts and never loops`, async () => {
  let now = 1_000;
  const setup = harness({ now: () => now });
  let calls = 0;
  setup.dependencies.runner.build = async () => { calls += 1; throw unavailable(); };
  const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "unreachable-always" } });
  const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "runner-unavailable-bound" });
  await setup.lifecycle.runBuild(actor, installation.id, operation.id);
  // Far more recovery rounds than the bound; each one first lets the lease expire.
  for (let round = 0; round < MAX_ATTEMPTS * 3; round++) {
    now += 60_000;
    await setup.lifecycle.recover(actor, installation.id);
  }
  const failed = (await setup.lifecycle.inspect(actor, installation.id)).operations[operation.id]!;
  expect(calls).toBe(MAX_ATTEMPTS);
  expect(failed.state).toBe("failed");
  expect(failed.diagnostics.at(-1)).toEqual({ code: "runner_unavailable", message: "The runner could not be reached; retry after it restarts.", retryable: true, stage: "runner" });
});

test("the bound above is the lifecycle's own constant", async () => {
  const lifecycle = await import("../extensions/v4/lifecycle");
  expect((lifecycle as Record<string, unknown>).RUNNER_UNAVAILABLE_MAX_ATTEMPTS).toBe(MAX_ATTEMPTS);
});
