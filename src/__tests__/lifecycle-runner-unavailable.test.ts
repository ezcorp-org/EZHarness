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

const busy = () => new RunnerError("runner_busy", "Build concurrency limit reached", "queue", true);

/** Run the build, then let one recovery attempt follow each lease expiry, `rounds` times. */
async function drive(setup: ReturnType<typeof harness>, clock: { now: number }, installationId: string, operationId: string, rounds: number) {
  await setup.lifecycle.runBuild(actor, installationId, operationId);
  for (let round = 0; round < rounds; round++) {
    clock.now += 60_000;
    await setup.lifecycle.recover(actor, installationId);
  }
  return (await setup.lifecycle.inspect(actor, installationId)).operations[operationId]!;
}

async function scripted(name: string, script: Array<"busy" | "unavailable">) {
  const clock = { now: 1_000 };
  const setup = harness({ now: () => clock.now });
  const calls: string[] = [];
  setup.dependencies.runner.build = async () => {
    const step = script[calls.length] ?? "unavailable";
    calls.push(step);
    throw step === "busy" ? busy() : unavailable();
  };
  const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": name } });
  const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: name });
  return { setup, clock, calls, installationId: installation.id, operationId: operation.id };
}

const exhausted = { code: "runner_unavailable", message: `The runner could not be reached after ${MAX_ATTEMPTS} attempts.`, retryable: false, stage: "runner" };

test(`an always-unreachable runner fails the build, named and classified, after ${MAX_ATTEMPTS} attempts and never loops`, async () => {
  const run = await scripted("unreachable-always", []);
  const failed = await drive(run.setup, run.clock, run.installationId, run.operationId, MAX_ATTEMPTS * 3);
  expect(run.calls).toHaveLength(MAX_ATTEMPTS);
  expect(failed.state).toBe("failed");
  expect(failed.diagnostics.at(-1)).toEqual(exhausted);
});

test("earlier busy re-queues do not use up the unavailable budget", async () => {
  // More busy retries than the whole unavailable budget, then a runner that is never reached again.
  const run = await scripted("busy-then-unreachable", Array(MAX_ATTEMPTS + 4).fill("busy"));
  const failed = await drive(run.setup, run.clock, run.installationId, run.operationId, MAX_ATTEMPTS * 4);
  expect(run.calls.filter((call) => call === "unavailable")).toHaveLength(MAX_ATTEMPTS);
  expect(failed.state).toBe("failed");
  expect(failed.diagnostics.at(-1)).toEqual(exhausted);
});

test("busy re-queues between unreachable attempts neither reset nor use up the count", async () => {
  // Five unreachable attempts, a stretch of busy ones, then unreachable again: the sixth unreachable attempt ends it.
  const script: Array<"busy" | "unavailable"> = [...Array(MAX_ATTEMPTS - 1).fill("unavailable"), ...Array(8).fill("busy")];
  const run = await scripted("interleaved", script);
  const failed = await drive(run.setup, run.clock, run.installationId, run.operationId, MAX_ATTEMPTS * 4);
  expect(run.calls.filter((call) => call === "unavailable")).toHaveLength(MAX_ATTEMPTS);
  expect(run.calls.filter((call) => call === "busy")).toHaveLength(8);
  expect(failed.state).toBe("failed");
  expect(failed.diagnostics.at(-1)).toEqual(exhausted);
});

test("a runner that answers build() and then hangs up at collectArtifacts() still stops at the maximum", async () => {
  const clock = { now: 1_000 };
  const setup = harness({ now: () => clock.now });
  let collects = 0;
  setup.dependencies.runner.collectArtifacts = async () => { collects += 1; throw unavailable(); };
  const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "dies-at-collect" } });
  const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "dies-at-collect" });
  const failed = await drive(setup, clock, installation.id, operation.id, MAX_ATTEMPTS * 3);
  expect(collects).toBe(MAX_ATTEMPTS);
  expect(failed.state).toBe("failed");
  expect(failed.diagnostics.at(-1)).toEqual(exhausted);
});

test("a build that recovers ends verified without its old unreachable entries", async () => {
  // The extension author page lists every diagnostic of an operation: a verified build must not show the
  // unreachable attempts it recovered from as if they were still errors.
  const clock = { now: 1_000 };
  const setup = harness({ now: () => clock.now });
  const build = setup.dependencies.runner.build;
  let calls = 0;
  setup.dependencies.runner.build = async (request) => {
    calls += 1;
    if (calls <= 2) throw unavailable();
    return build(request);
  };
  const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "recovers" } });
  const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "recovers" });
  const verified = await drive(setup, clock, installation.id, operation.id, 4);
  expect(calls).toBe(3);
  expect(verified.state).toBe("verified");
  expect(verified.diagnostics.filter((diagnostic) => diagnostic.code === "runner_unavailable")).toEqual([]);
});

test("lifecycle.ts writes operation diagnostics only through writeDiagnostics", async () => {
  const source = await Bun.file(new URL("../extensions/v4/lifecycle.ts", import.meta.url)).text();
  const helper = /function writeDiagnostics\(.*\): void \{\n[^\n]*\n\}/.exec(source);
  expect(helper).not.toBeNull();
  const outside = source.replace(helper![0], "");
  // An assignment, or a mutating array call, on any `.diagnostics` outside the helper could drop the count.
  expect(outside.match(/\.diagnostics\s*(=(?!=)|\.(push|splice|unshift|pop|shift|length\s*=|fill|sort|reverse|copyWithin)\b)/g) ?? []).toEqual([]);
});

test("the bound above is the lifecycle's own constant", async () => {
  const lifecycle = await import("../extensions/v4/lifecycle");
  expect((lifecycle as Record<string, unknown>).RUNNER_UNAVAILABLE_MAX_ATTEMPTS).toBe(MAX_ATTEMPTS);
});
