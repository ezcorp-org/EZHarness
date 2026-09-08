// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { RunnerError, LifecycleError, actor, harness } from "./helpers/durable-lifecycle-fixture";

test("host candidate checks cannot be replaced by builder evidence", async () => {
    const setup = harness({ async verifyCandidate() { throw new LifecycleError("host_test_failed", "Host protocol check failed."); } });
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "console.log('PASS')" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "printed-pass" });
    const result = await setup.lifecycle.runBuild(actor, installation.id, operation.id);
    expect(result.state).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("host_test_failed");
    expect(Object.keys((await setup.lifecycle.inspect(actor, installation.id)).releases)).toHaveLength(0);
  });

test("runner failures retain only an allowlisted safe diagnostic", async () => {
    const setup = harness();
    setup.dependencies.runner.build = async () => { throw new RunnerError("runner_busy", "Build concurrency limit reached", "queue", true); };
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "console.log('queued')" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "runner-diagnostic" });
    const result = await setup.lifecycle.runBuild(actor, installation.id, operation.id);
    expect(result).toMatchObject({ state: "queued", diagnostics: [{ code: "runner_busy", stage: "runner", message: "The runner is busy; retry after the current build.", retryable: true }], lease: { fence: 1 } });
    expect(result.lease?.until).toBeGreaterThan(Date.now());
    setup.dependencies.runner.build = async () => { throw new RunnerError("command_failed", "private child stderr", "compile", false); };
    const next = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "runner-redaction" });
    expect((await setup.lifecycle.runBuild(actor, installation.id, next.id)).diagnostics).toContainEqual(expect.objectContaining({ code: "operation_failed", message: "Operation failed. See host diagnostics." }));
  });
