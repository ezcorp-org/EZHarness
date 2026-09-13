import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { TestWorkflowEnvironment, type TestWorkflowEnvironment as TestEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundle } from "@temporalio/worker";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import { createFactoryWorker } from "../src/worker.ts";
import { Context } from "@temporalio/activity";
import { advanceKernel, createKernelState } from "@ezcorp/factory-sdk/kernel";

const server = "/tmp/factory-tools/temporal-test-server/temporal-test-server_1.38.0_linux_amd64/temporal-test-server";
const queue = "factory-orchestrator";
let environment: TestEnvironment;
let bundle: WorkflowBundle;
let historyDirectory = "";

const runner = { package: "inert", version: "1", digest: "sha256:test", export: "run" };
const node = { id: "work", kind: "task", runner };
const factory = {
  schemaVersion: "factory.ir.v1",
  digest: "sha256:factory",
  definition: {
    schemaVersion: "factory.v1", id: "test", version: "1", interpreterCompatibility: "1",
    inputPorts: {}, outputPorts: {}, graph: { nodes: [node], outputs: {} },
    acceptance: { id: "none", version: "1", claims: [] }, packages: [], capabilities: [], effects: [],
    bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16 },
  },
  lock: { packages: [], factories: [], interpreter: "1" },
  indexes: { nodeById: { work: node }, successors: { work: [] }, dependencyCounts: { work: 0 } },
  partitions: [{ id: "partition-0", nodeIds: ["work"], dependsOn: [] }], pages: [],
};

function compiled(nodes, id) {
  const nodeById = Object.fromEntries(nodes.map((item) => [item.id, item]));
  const successors = Object.fromEntries(nodes.map((item) => [item.id, []]));
  for (const item of nodes) for (const parent of item.dependsOn ?? []) successors[parent].push(item.id);
  return {
    ...factory,
    digest: `sha256:${id}`,
    definition: { ...factory.definition, id, graph: { nodes, outputs: {} } },
    indexes: { nodeById, successors, dependencyCounts: Object.fromEntries(nodes.map((item) => [item.id, item.dependsOn?.length ?? 0])) },
    partitions: nodes.length ? [{ id: "partition-0", nodeIds: nodes.map((item) => item.id), dependsOn: [] }] : [],
  };
}

before(async () => {
  historyDirectory = await mkdtemp(join(tmpdir(), "factory-history-"));
  environment = await TestWorkflowEnvironment.createTimeSkipping({ server: { executable: { type: "existing-path", path: server } } });
  bundle = await bundleWorkflowCode({ workflowsPath: new URL("../src/workflow.ts", import.meta.url).pathname });
  if (process.env.FACTORY_BUNDLE_CODE_PATH) await writeFile(process.env.FACTORY_BUNDLE_CODE_PATH, bundle.code);
  if (process.env.FACTORY_BUNDLE_MAP_PATH) await writeFile(process.env.FACTORY_BUNDLE_MAP_PATH, JSON.stringify(bundle.sourceMap));
});

after(async () => {
  await environment?.teardown();
  if (historyDirectory) await rm(historyDirectory, { recursive: true, force: true });
});

describe("factory Temporal workflow", () => {
  it("records audit before effects and replays the saved real-server history", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const order = [];
    const activities = {
      recordTransition: async (record) => { order.push(`audit:${record.sourceSequence}`); },
      executeCommand: async ({ command }) => {
        order.push(`effect:${command.kind}`);
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: startedAtMs + 1, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") return { kind: "node-result", id: `${command.id}:result`, atMs: startedAtMs + 2, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, output: {} };
        throw new Error(`unexpected ${command.kind}`);
      },
      loadFactory: async () => { throw new Error("no child expected"); },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, activities });
    const workflowId = `tenant/run-${process.pid}`;
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [{ tenantId: "tenant", projectId: "project", logicalRunId: "run", interpreterId: "interpreter", startedAtMs, factory, input: {} }],
      });
      assert.deepEqual(await handle.result(), { status: "completed", output: {}, state: await handle.query("factoryState") });
      const history = await handle.fetchHistory();
      const path = join(historyDirectory, "history.json");
      await writeFile(path, historyToJSON(history));
      await Worker.runReplayHistory({ workflowBundle: bundle }, JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")), workflowId);
    });
    assert.deepEqual(order, ["audit:1", "effect:request-admission", "audit:2", "effect:dispatch-node", "audit:3"]);
  });

  it("cancels an in-flight activity and waits for the fenced stop acknowledgement", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    let dispatchStarted = () => undefined;
    const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
    const activities = {
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: startedAtMs + 1, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") {
          dispatchStarted();
          await new Promise((resolve, reject) => {
            const signal = Context.current().cancellationSignal;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        if (command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: startedAtMs + 3, nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        throw new Error(`unexpected ${command.kind}`);
      },
      loadFactory: async () => { throw new Error("no child expected"); },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/cancel-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [{ tenantId: "tenant", projectId: "project", logicalRunId: "cancel", interpreterId: "interpreter", startedAtMs, factory, input: {} }],
      });
      await started;
      await handle.signal("factoryInbox", { kind: "cancel", id: "cancel-event", atMs: startedAtMs + 2, reason: "requested" });
      const result = await handle.result();
      assert.equal(result.status, "cancelled", JSON.stringify(result));
      assert.equal(result.state.nodes.work.attempts[0].stopped, true);
    });
  });

  it("uses a durable retry timer and succeeds on the second fenced attempt", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const retryFactory = compiled([{ ...node, retry: { maxAttempts: 3, initialDelayMs: 0, maximumDelayMs: 0 } }], "retry");
    let dispatches = 0;
    const activities = {
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: startedAtMs + dispatches, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") {
          dispatches += 1;
          if (dispatches === 1) return { kind: "node-failed", id: `${command.id}:failed`, atMs: startedAtMs + 1, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, error: "retry" };
          return { kind: "node-result", id: `${command.id}:result`, atMs: startedAtMs + 2, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, output: {} };
        }
        if (command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: startedAtMs + 1, nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        throw new Error(`unexpected ${command.kind}`);
      },
      loadFactory: async () => { throw new Error("no child expected"); },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, activities });
    await worker.runUntil(async () => {
      const result = await environment.client.workflow.execute("factoryWorkflow", {
        workflowId: `tenant/retry-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [{ tenantId: "tenant", projectId: "project", logicalRunId: "retry", interpreterId: "interpreter", startedAtMs, factory: retryFactory, input: {} }],
      });
      assert.equal(result.status, "completed");
    });
    assert.equal(dispatches, 2);
  });

  it("runs a pinned subfactory as a child workflow", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const childFactory = compiled([], "child");
    const parentFactory = compiled([{ id: "child", kind: "subfactory", factory: { id: "child", version: "1", digest: childFactory.digest }, releaseMode: "none", grants: [] }], "parent");
    const activities = {
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => { throw new Error(`unexpected ${command.kind}`); },
      loadFactory: async (reference) => {
        assert.equal(reference.digest, childFactory.digest);
        return childFactory;
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, activities });
    await worker.runUntil(async () => {
      const result = await environment.client.workflow.execute("factoryWorkflow", {
        workflowId: `tenant/parent-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [{ tenantId: "tenant", projectId: "project", logicalRunId: "parent", interpreterId: "interpreter", startedAtMs, factory: parentFactory, input: {} }],
      });
      assert.equal(result.status, "completed");
    });
  });

  it("cancels an active child before it accepts the parent stop acknowledgement", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const childFactory = compiled([node], "slow-child");
    const parentFactory = compiled([{ id: "child", kind: "subfactory", factory: { id: "child", version: "1", digest: childFactory.digest }, releaseMode: "none", grants: [] }], "cancel-parent");
    let childStarted = () => undefined;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    const activities = {
      recordTransition: async () => undefined,
      executeCommand: async ({ logicalRunId, command }) => {
        if (logicalRunId.endsWith("/child") && command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: startedAtMs + 1, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (logicalRunId.endsWith("/child") && command.kind === "dispatch-node") {
          childStarted();
          await new Promise((resolve, reject) => {
            const signal = Context.current().cancellationSignal;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        if (logicalRunId === "cancel-parent" && command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: startedAtMs + 3, nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        throw new Error(`unexpected ${logicalRunId}:${command.kind}`);
      },
      loadFactory: async () => childFactory,
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/cancel-parent-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [{ tenantId: "tenant", projectId: "project", logicalRunId: "cancel-parent", interpreterId: "interpreter", startedAtMs, factory: parentFactory, input: {} }],
      });
      await started;
      await handle.signal("factoryInbox", { kind: "cancel", id: "cancel-child", atMs: startedAtMs + 2, reason: "requested" });
      assert.equal((await handle.result()).status, "cancelled");
    });
  });

  it("continues only from a quiescent state and restores absolute timers", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const approval = { id: "approval", kind: "approval", choices: ["approve"], context: { kind: "literal", value: null }, actorScope: "owner", deadlineMs: 60_000 };
    const approvalFactory = compiled([approval], "continue");
    const initial = createKernelState(approvalFactory, "continue", {}, startedAtMs);
    const started = advanceKernel(approvalFactory, initial, { kind: "start", id: "continue:start", atMs: startedAtMs });
    const approvalCommand = started.commands.find((command) => command.kind === "request-approval");
    assert.ok(approvalCommand);
    const continuationState = {
      ...started.nextState,
      runDeadlineAtMs: startedAtMs + 600_000,
      runTimerId: "continue:run:start-timer",
      nodes: { approval: { ...started.nextState.nodes.approval, timer: { id: "continue:approval:start-timer", deadlineAtMs: startedAtMs + 60_000, purpose: "deadline" } } },
    };
    const activities = {
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: startedAtMs + 60_001, nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        throw new Error(`unexpected ${command.kind}`);
      },
      loadFactory: async () => { throw new Error("no child expected"); },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/continue-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [{
          tenantId: "tenant", projectId: "project", logicalRunId: "continue", interpreterId: "interpreter", startedAtMs,
          factory: approvalFactory, input: {},
          continuation: { state: continuationState, inbox: [{ kind: "repair", id: "ignored-repair", atMs: startedAtMs + 1, nodeId: "approval", reason: "ignored while waiting" }], sourceSequence: 1, handledSinceContinuation: 63 },
        }],
      });
      assert.equal((await handle.result()).status, "failed");
    });
  });
});
