import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { TestWorkflowEnvironment, type TestWorkflowEnvironment as TestEnvironment } from "@temporalio/testing";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { bundleWorkflowCode, Worker, type WorkflowBundle } from "@temporalio/worker";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import { createFactoryWorker } from "../src/worker.ts";
import { Context } from "@temporalio/activity";
import { canonicalizeJson, compileFactory, createCompiledExecutionManifest, createCompiledPartitionArtifact } from "@ezcorp/factory-sdk";
import { encodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import { advanceKernel, createKernelState } from "@ezcorp/factory-sdk/kernel";
import type { KernelState } from "@ezcorp/factory-sdk/kernel-types";
import { factoryWorkflowId, type FactoryWorkflowResult } from "../src/contracts.ts";
import { deliverFactoryCommand, reconcileFactoryCommand } from "../src/dispatcher.ts";

const server = process.env.FACTORY_TEMPORAL_TEST_SERVER ?? "/tmp/factory-tools/temporal-test-server/temporal-test-server_1.38.0_linux_amd64/temporal-test-server";
const queue = "factory-orchestrator";
const namespace = "default";
let environment: TestEnvironment;
let bundle: WorkflowBundle;
let historyDirectory = "";

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const eventHash = (event) => hash(canonicalizeJson(event));
const packageDigest = hash("inert-package");
const runner = { package: "inert", version: "1", digest: packageDigest, export: "run" };
const node = { id: "work", kind: "task", runner, deadlineMs: 600_000 };
const lazyDataInput = { data: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } };

function compileDefinition(definition) {
  const result = compileFactory(definition);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("test factory did not compile");
  return result.factory;
}

function compiled(nodes, id, inputPorts = {}) {
  const childReferences = nodes.filter((item) => item.kind === "subfactory").map((item) => item.factory);
  const definition = {
    schemaVersion: "factory.v1", id, version: "1", interpreterCompatibility: "1",
    inputPorts, outputPorts: {}, graph: { nodes, outputs: {} },
    acceptance: { id: "test-acceptance", version: "1", claims: [{ id: "test", validator: runner, required: true, protected: true }], groups: [] },
    packages: [{ name: runner.package, version: runner.version, digest: runner.digest }], factories: childReferences,
    capabilities: [], effects: [...new Set(["none", ...nodes.flatMap((item) => item.effects ?? [])])], bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16, runDeadlineMs: 600_000 },
  };
  return compileDefinition(definition);
}

const factory = compiled([node], "test");

function storedDefinition(compiledFactory) {
  const content = JSON.stringify(compiledFactory);
  const page = { index: 0, objectId: `definition:${compiledFactory.digest}`, digest: hash(content), encodedBytes: Buffer.byteLength(content) };
  const manifestContent = JSON.stringify({ schemaVersion: "factory.manifest-page.v1", definitionDigest: compiledFactory.digest, definitionEncodedBytes: page.encodedBytes, pages: [page] });
  const manifest = { objectId: `manifest:${compiledFactory.digest}`, digest: hash(manifestContent), encodedBytes: Buffer.byteLength(manifestContent) };
  return { factory: compiledFactory, content, page, source: { definitionDigest: compiledFactory.digest, definitionEncodedBytes: page.encodedBytes, manifest } };
}

function storedPartition(compiledFactory, partitionId) {
  const manifestValue = createCompiledExecutionManifest(compiledFactory);
  const partitionValue = createCompiledPartitionArtifact(compiledFactory, partitionId);
  const manifestContent = canonicalizeJson(manifestValue);
  const partitionContent = canonicalizeJson(partitionValue);
  const partition = compiledFactory.partitions.find((candidate) => candidate.id === partitionId);
  assert.ok(partition);
  assert.equal(Buffer.byteLength(manifestContent), compiledFactory.executionManifest.encodedBytes);
  assert.equal(Buffer.byteLength(partitionContent), partition.encodedBytes);
  return {
    source: {
      definitionDigest: compiledFactory.digest,
      executionManifest: { objectId: `execution-manifest:${compiledFactory.digest}`, ...compiledFactory.executionManifest },
      partition: { objectId: `partition:${compiledFactory.digest}:${partitionId}`, partitionId, digest: partition.digest, encodedBytes: partition.encodedBytes },
    },
    manifestValue,
    partitionValue,
  };
}

function definitionActivities(...factories) {
  const stored = factories.map(storedDefinition);
  const find = (digest) => stored.find((item) => item.factory.digest === digest);
  const transitionPages = new Map();
  const transitionManifests = new Map();
  return {
    stageTransitionPage: async (request) => {
      const key = `${request.logicalRunId}:${request.interpreterId}:${request.sourceSequence}:${request.index}`;
      const content = Buffer.from(request.contentBase64, "base64").toString("utf8");
      transitionPages.set(key, content);
      return { index: request.index, objectId: `transition:${key}`, digest: hash(content), encodedBytes: request.encodedBytes };
    },
    finalizeTransitionArtifact: async (request) => {
      const content = request.pages.map((page) => transitionPages.get(`${request.logicalRunId}:${request.interpreterId}:${request.sourceSequence}:${page.index}`)).join("");
      const transition = JSON.parse(content);
      const eventHash = hash(canonicalizeJson(transition.event));
      assert.equal(request.eventId, transition.event.id);
      if (request.expectedEventHash !== undefined) assert.equal(request.expectedEventHash, eventHash);
      const manifestValue = { schemaVersion: "factory.transition-manifest.v1", tenantId: request.tenantId, projectId: request.projectId, logicalRunId: request.logicalRunId, interpreterId: request.interpreterId, sourceSequence: request.sourceSequence, eventId: request.eventId, eventHash, encodedBytes: Buffer.byteLength(content), pages: request.pages };
      const manifestContent = canonicalizeJson(manifestValue);
      const manifest = { objectId: `transition-manifest:${request.logicalRunId}:${request.interpreterId}:${request.sourceSequence}`, digest: hash(manifestContent), encodedBytes: Buffer.byteLength(manifestContent) };
      transitionManifests.set(manifest.objectId, { ...manifestValue, self: manifest });
      return { manifest, eventHash };
    },
    resolveFactory: async ({ factory: reference }) => {
      const item = find(reference.digest);
      if (!item) throw new Error("unknown child factory");
      return item.source;
    },
    loadManifestPage: async ({ definition, page }) => {
      const item = find(definition.definitionDigest);
      if (!item) throw new Error("unknown manifest");
      return { schemaVersion: "factory.manifest-page.v1", definitionDigest: item.factory.digest, definitionEncodedBytes: item.page.encodedBytes, self: page, pages: [item.page] };
    },
    loadDefinitionPage: async ({ definitionDigest, page }) => {
      const item = find(definitionDigest);
      if (!item) throw new Error("unknown definition page");
      return { index: page.index, objectId: page.objectId, digest: page.digest, contentBase64: encodeFactoryPageBase64(new TextEncoder().encode(item.content)) };
    },
    loadExecutionManifest: async ({ definitionDigest }) => {
      const item = find(definitionDigest);
      if (!item) throw new Error("unknown execution manifest");
      return createCompiledExecutionManifest(item.factory);
    },
    loadPartitionArtifact: async ({ definitionDigest, partition }) => {
      const item = find(definitionDigest);
      if (!item) throw new Error("unknown partition artifact");
      return createCompiledPartitionArtifact(item.factory, partition.partitionId);
    },
    loadTransitionManifest: async ({ manifest }) => {
      const value = transitionManifests.get(manifest.objectId);
      if (!value) throw new Error("unknown transition manifest");
      return value;
    },
    loadTransitionPage: async ({ logicalRunId, interpreterId, sourceSequence, page }) => {
      const content = transitionPages.get(`${logicalRunId}:${interpreterId}:${sourceSequence}:${page.index}`);
      if (content === undefined) throw new Error("unknown transition page");
      return { ...page, contentBase64: encodeFactoryPageBase64(new TextEncoder().encode(content)) };
    },
  };
}

function workflowInput(compiledFactory, values) {
  return { tenantId: "tenant", projectId: "project", logicalRunId: "run", interpreterId: "interpreter", startedAtMs: 1, definition: storedDefinition(compiledFactory).source, input: {}, ...values };
}

async function assertClosedReceipt(handle) {
  const description = await handle.describe();
  assert.equal(description.status.name, "COMPLETED");
  assert.equal(description.raw.pendingActivities?.length ?? 0, 0);
  assert.equal(description.raw.pendingChildren?.length ?? 0, 0);
}

async function waitForContinuedRun(handle, previousRunId) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const runId = (await environment.client.workflow.getHandle(handle.workflowId).describe()).runId;
    if (runId !== previousRunId) return runId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`workflow did not continue from run ${previousRunId}`);
}

async function waitForState(handle): Promise<KernelState> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { return await environment.client.workflow.getHandle(handle.workflowId).query("factoryState"); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`workflow ${handle.workflowId} did not register its state query`);
}

async function waitForActivityCancellation(started) {
  started?.();
  const context = Context.current();
  const heartbeat = setInterval(() => context.heartbeat(), 10);
  try {
    await new Promise((resolve, reject) => context.cancellationSignal.addEventListener("abort", () => reject(context.cancellationSignal.reason), { once: true }));
  } finally {
    clearInterval(heartbeat);
  }
}

async function waitForReleaseOrCancellation(released) {
  const context = Context.current();
  context.cancellationSignal.throwIfAborted();
  let cancel = () => undefined;
  const cancellation = new Promise((_, reject) => {
    cancel = () => reject(context.cancellationSignal.reason);
    context.cancellationSignal.addEventListener("abort", cancel, { once: true });
  });
  const heartbeat = setInterval(() => context.heartbeat(), 10);
  try { await Promise.race([released, cancellation]); }
  finally {
    clearInterval(heartbeat);
    context.cancellationSignal.removeEventListener("abort", cancel);
  }
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
  it("reconciles a repeated durable start against the real Temporal workflow identity", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const logicalRunId = `repeated-start-${process.pid}`;
    const workflowId = `tenant/${logicalRunId}`;
    const command = {
      commandId: `start-${logicalRunId}`,
      requestId: `start-${logicalRunId}`,
      tenantId: "tenant",
      projectId: "project",
      logicalRunId,
      workflowId,
      kind: "start_run",
      interpreterId: "interpreter",
      body: workflowInput(factory, { logicalRunId, startedAtMs }),
    };
    const activities = {
      ...definitionActivities(factory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command: kernelCommand }) => {
        if (kernelCommand.kind === "request-admission") return { kind: "admission-result", id: `${kernelCommand.id}:admitted`, atMs: startedAtMs + 1, nodeId: kernelCommand.nodeId, commandId: kernelCommand.id, candidateGeneration: kernelCommand.candidateGeneration, granted: true };
        if (kernelCommand.kind === "dispatch-node") return { kind: "node-result", id: `${kernelCommand.id}:result`, atMs: startedAtMs + 2, nodeId: kernelCommand.nodeId, commandId: kernelCommand.id, candidateGeneration: kernelCommand.candidateGeneration, attempt: kernelCommand.attempt, output: {} };
        throw new Error(`unexpected ${kernelCommand.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    let observedStatus: FactoryWorkflowResult["status"] | undefined;
    await worker.runUntil(async () => {
      await deliverFactoryCommand(environment.client, command);
      await deliverFactoryCommand(environment.client, command);
      await assert.rejects(deliverFactoryCommand(environment.client, { ...command, commandId: `${command.commandId}-conflict`, requestId: `${command.commandId}-conflict` }), WorkflowExecutionAlreadyStartedError);
      observedStatus = (await environment.client.workflow.getHandle(workflowId).result()).status;
    });
    assert.equal(observedStatus, "completed");
  });

  it("fails a malformed workflow input before it reads the definition", async () => {
    let definitionReads = 0;
    const baseActivities = definitionActivities(factory);
    const activities = {
      ...baseActivities,
      resolveFactory: async (request) => {
        definitionReads += 1;
        return baseActivities.resolveFactory(request);
      },
      loadManifestPage: async (request) => {
        definitionReads += 1;
        return baseActivities.loadManifestPage(request);
      },
      loadDefinitionPage: async (request) => {
        definitionReads += 1;
        return baseActivities.loadDefinitionPage(request);
      },
      recordTransition: async () => undefined,
      executeCommand: async () => {
        throw new Error("invalid input must not execute effects");
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/invalid-input-${process.pid}`,
        taskQueue: queue,
        retry: { maximumAttempts: 1 },
        args: [workflowInput(factory, { tenantId: "" })],
      });
      await assert.rejects(handle.result());
    });
    assert.equal(definitionReads, 0);
  });

  it("fails an unavailable immutable definition before audit or effects", async () => {
    let transitions = 0;
    let effects = 0;
    const missingDigest = hash("missing-definition");
    const input = workflowInput(factory, {});
    const activities = {
      ...definitionActivities(factory),
      recordTransition: async () => {
        transitions += 1;
      },
      executeCommand: async () => {
        effects += 1;
        throw new Error("missing definition must not execute effects");
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/missing-definition-${process.pid}`,
        taskQueue: queue,
        retry: { maximumAttempts: 1 },
        args: [{ ...input, definition: { ...input.definition, definitionDigest: missingDigest } }],
      });
      await assert.rejects(handle.result());
    });
    assert.equal(transitions, 0);
    assert.equal(effects, 0);
  });

  it("records audit before effects and replays the saved real-server history", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const order = [];
    const activities = {
      ...definitionActivities(factory),
      recordTransition: async (record) => { order.push(`audit:${record.sourceSequence}`); },
      executeCommand: async ({ command }) => {
        order.push(`effect:${command.kind}`);
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: startedAtMs + 1, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") return { kind: "node-result", id: `${command.id}:result`, atMs: startedAtMs + 2, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, output: {} };
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    const workflowId = `tenant/run-${process.pid}`;
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(factory, { startedAtMs })],
      });
      assert.deepEqual(await handle.result(), { status: "completed", output: {}, state: await handle.query("factoryState") });
      const history = await handle.fetchHistory();
      const path = join(historyDirectory, "history.json");
      await writeFile(path, historyToJSON(history));
      await Worker.runReplayHistory({ workflowBundle: bundle }, JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")), workflowId);
    });
    assert.deepEqual(order, ["audit:1", "effect:request-admission", "audit:2", "effect:dispatch-node", "audit:3"]);
  });

  it("replays a sealed repair input and preserves the prior candidate", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const repairFactory = compiled([{ ...node, inputPorts: { instruction: { type: "string" } }, bindings: { instruction: { kind: "literal", value: "first" } }, repairableInputs: ["instruction"] }], "repair-replay");
    let firstStarted = () => undefined;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    let releaseFirst = () => undefined;
    const replacementStarted = new Promise<void>(resolve => { releaseFirst = resolve; });
    const dispatched = [];
    const activities = {
      ...definitionActivities(repairFactory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") {
          dispatched.push({ generation: command.candidateGeneration, input: command.input });
          if (command.candidateGeneration === 0) { firstStarted(); await replacementStarted; }
          else releaseFirst();
          return { kind: "node-result", id: `${command.id}:result`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, output: {} };
        }
        if (command.kind === "cancel-node") {
          return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        }
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    const workflowId = `tenant/repair-replay-${process.pid}`;
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", { workflowId, taskQueue: queue, retry: { maximumAttempts: 1 }, args: [workflowInput(repairFactory, { logicalRunId: "repair-replay", startedAtMs })] });
      await started;
      const repair = { kind: "repair", id: "repair-replay:event", atMs: startedAtMs + 1, nodeId: "work", reason: "correct instruction", inputOverride: { instruction: "second" } };
      await handle.signal("factoryInbox", { sequence: 1, eventId: repair.id, eventHash: eventHash(repair), event: repair });
      const result = await handle.result();
      assert.equal(result.status, "completed");
      assert.deepEqual(dispatched, [{ generation: 0, input: { instruction: "first" } }, { generation: 1, input: { instruction: "second" } }]);
      const state = await handle.query("factoryState");
      assert.deepEqual(state.nodes.work.priorCandidates, [{ candidateGeneration: 0, status: "cancelled", inputOverride: { instruction: "first" } }]);
      const history = await handle.fetchHistory();
      await Worker.runReplayHistory({ workflowBundle: bundle }, JSON.parse(historyToJSON(history)), workflowId);
    });
  });

  it("answers a protected rejection with a bounded remediation wait and replays the new decision", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const remediationFactory = compiled([
      { ...node, id: "candidate", inputPorts: { instruction: { type: "string" } }, bindings: { instruction: { kind: "literal", value: "first" } }, repairableInputs: ["instruction"], outputPorts: { candidate: { type: "string" } } },
      { id: "accept", kind: "acceptance", dependsOn: ["candidate"], contract: "test-acceptance", candidate: { kind: "ref", root: "node", name: "candidate", path: ["candidate"] }, evidence: { kind: "literal", value: [] }, maxRepairs: 1, outputPorts: { acceptedCandidate: { type: "string" } } },
    ], "remediation-replay");
    let rejected = () => undefined;
    const rejection = new Promise<void>(resolve => { rejected = resolve; });
    const decisions = [];
    const stops = [];
    const activities = {
      ...definitionActivities(remediationFactory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") return { kind: "node-result", id: `${command.id}:result`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, output: { candidate: `tree-${command.candidateGeneration}` } };
        if (command.kind === "request-acceptance") {
          decisions.push({ generation: command.candidateGeneration, candidate: command.candidate });
          if (command.candidateGeneration > 0) return { kind: "node-result", id: `${command.id}:accepted`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: 1, output: { acceptedCandidate: command.candidate } };
          // The rejected fact returns as an event. Throwing here would retry until the activity
          // timed out and the run would never reach its bounded repair.
          const failure = { kind: "node-failed", id: `${command.id}:rejected`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: 1, error: "factory_assurance_claim_failed", failureKind: "acceptance_rejected" };
          setTimeout(rejected, 0);
          return failure;
        }
        if (command.kind === "cancel-node") {
          // Recorded, not answered: the gateway resolves this through the attempt queue, which holds
          // nothing for an acceptance, so one reaching here would fail the activity and kill the run.
          stops.push(command.nodeId);
          return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        }
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    const workflowId = `tenant/remediation-replay-${process.pid}`;
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", { workflowId, taskQueue: queue, retry: { maximumAttempts: 1 }, args: [workflowInput(remediationFactory, { logicalRunId: "remediation-replay", startedAtMs })] });
      await rejection;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const waiting: KernelState = await handle.query("factoryState");
        if (waiting.nodes.accept?.waitingReason === "remediation") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const waiting: KernelState = await handle.query("factoryState");
      assert.equal(waiting.nodes.accept?.status, "waiting");
      assert.equal(waiting.nodes.accept?.waitingReason, "remediation");
      assert.equal(waiting.status, "waiting");

      const repair = { kind: "repair", id: "remediation-replay:event", atMs: startedAtMs + 1, nodeId: "candidate", reason: "factory_assurance_claim_failed", inputOverride: { instruction: "second" } };
      await handle.signal("factoryInbox", { sequence: 1, eventId: repair.id, eventHash: eventHash(repair), event: repair });
      const result = await handle.result();
      assert.equal(result.status, "completed");
      assert.deepEqual(decisions, [{ generation: 0, candidate: "tree-0" }, { generation: 1, candidate: "tree-1" }]);
      assert.deepEqual(stops, []);
      const state: KernelState = await handle.query("factoryState");
      assert.equal(state.nodes.accept?.candidateGeneration, 1);
      assert.deepEqual(state.nodes.accept?.priorCandidates, [{ candidateGeneration: 0, status: "cancelled", error: "factory_assurance_claim_failed" }]);
      const history = await handle.fetchHistory();
      await Worker.runReplayHistory({ workflowBundle: bundle }, JSON.parse(historyToJSON(history)), workflowId);
    });
  });

  it("advances independent successors while another branch is blocked", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const parallelFactory = compiled([
      { ...node, id: "a" },
      { ...node, id: "b", dependsOn: ["a"] },
      { ...node, id: "c" },
      { ...node, id: "d", dependsOn: ["a"] },
    ], "parallel");
    const completed = new Set();
    let successorsFinished = () => undefined;
    const successors = new Promise<void>((resolve) => { successorsFinished = resolve; });
    const activities = {
      ...definitionActivities(parallelFactory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node" && command.nodeId === "c") {
          await waitForActivityCancellation();
        }
        if (command.kind === "dispatch-node") {
          completed.add(command.nodeId);
          if (completed.has("b") && completed.has("d")) successorsFinished();
          return { kind: "node-result", id: `${command.id}:result`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, output: {} };
        }
        if (command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/parallel-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(parallelFactory, { logicalRunId: "parallel", startedAtMs })],
      });
      await successors;
      assert.deepEqual([...completed].sort(), ["a", "b", "d"]);
      const cancel = { kind: "cancel", id: "cancel-parallel", atMs: Date.now(), reason: "test complete" };
      await handle.signal("factoryInbox", { sequence: 1, eventId: cancel.id, eventHash: eventHash(cancel), event: cancel });
      assert.equal((await handle.result()).status, "cancelled");
      await assertClosedReceipt(handle);
    });
  });

  it("loads bounded partitions from a 10,000-node plan and advances a cross-partition successor before a slow sibling", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const largeFactory = compiled([
      { ...node, id: "a", outputPorts: { value: { type: "number" } } },
      ...Array.from({ length: 9_998 }, (_, index) => ({ ...node, id: `slow-${index.toString().padStart(4, "0")}` })),
      {
        ...node,
        id: "z",
        dependsOn: ["a"],
        inputPorts: { fromA: { type: "number" } },
        bindings: { fromA: { kind: "ref", root: "node", name: "a", path: ["value"] } },
      },
    ], "ten-thousand-partition-plan");
    assert.equal(largeFactory.definition.graph.nodes.length, 10_000);
    assert.ok(largeFactory.partitions.length > 1);
    assert.ok(largeFactory.partitions.every((partition) => partition.nodeIds.length <= 128 && partition.encodedBytes <= 32 * 1024));
    const sourcePartition = largeFactory.partitions.find((partition) => partition.nodeIds.includes("a"));
    const targetPartition = largeFactory.partitions.find((partition) => partition.nodeIds.includes("z"));
    assert.ok(sourcePartition);
    assert.ok(targetPartition);
    assert.notEqual(sourcePartition.id, targetPartition.id);
    const sourceStored = storedPartition(largeFactory, sourcePartition.id);
    const targetStored = storedPartition(largeFactory, targetPartition.id);
    assert.ok(sourceStored.source.executionManifest.encodedBytes <= 32 * 1024);
    assert.ok(sourceStored.source.partition.encodedBytes <= 32 * 1024);
    assert.ok(targetStored.source.partition.encodedBytes <= 32 * 1024);

    const sourceWorkflowId = `tenant/partition-10k-${process.pid}/partitions/${sourcePartition.id}`;
    const targetWorkflowId = `tenant/partition-10k-${process.pid}/partitions/${targetPartition.id}`;
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let zDispatched!: () => void;
    const zStarted = new Promise<void>((resolve) => { zDispatched = resolve; });
    let slowReleased = false;
    let zAdvancedBeforeSlow = false;
    let activeEffects = 0;
    let maximumActiveEffects = 0;
    const activities = {
      ...definitionActivities(largeFactory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        activeEffects += 1;
        maximumActiveEffects = Math.max(maximumActiveEffects, activeEffects);
        try {
          if (command.kind === "request-admission") {
            return { kind: "admission-result", id: `${command.id}:admitted`, atMs: startedAtMs + 1, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
          }
          if (command.kind === "dispatch-node") {
            if (command.nodeId === "slow-0000") await waitForReleaseOrCancellation(slow);
            if (command.nodeId === "z") {
              assert.deepEqual(command.input, { fromA: 7 });
              zAdvancedBeforeSlow = !slowReleased;
              zDispatched();
            }
            return { kind: "node-result", id: `${command.id}:result`, atMs: startedAtMs + 2, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, output: command.nodeId === "a" ? { value: 7 } : {} };
          }
          if (command.kind === "notify-partition") {
            const { kind: _kind, id, ...completion } = command;
            const event = { kind: "partition-node-completed", id, atMs: startedAtMs + 2, ...completion };
            await environment.client.workflow.getHandle(targetWorkflowId).signal("factoryInbox", { sequence: 1, eventId: id, eventHash: eventHash(event), event });
            return null;
          }
          throw new Error(`unexpected ${command.kind}`);
        } finally {
          activeEffects -= 1;
        }
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const target = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: targetWorkflowId,
        taskQueue: queue,
        retry: { maximumAttempts: 1 },
        args: [workflowInput(largeFactory, { logicalRunId: `partition-10k-${process.pid}`, interpreterId: targetPartition.id, startedAtMs, definition: targetStored.source })],
      });
      const source = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: sourceWorkflowId,
        taskQueue: queue,
        retry: { maximumAttempts: 1 },
        args: [workflowInput(largeFactory, { logicalRunId: `partition-10k-${process.pid}`, interpreterId: sourcePartition.id, startedAtMs, definition: sourceStored.source })],
      });
      await zStarted;
      assert.equal(zAdvancedBeforeSlow, true);
      assert.equal((await source.query("factoryState")).nodes["slow-0000"].status, "running");
      slowReleased = true;
      releaseSlow();
      assert.equal((await source.result()).status, "completed");
      assert.equal((await target.result()).status, "completed");
      assert.ok(maximumActiveEffects <= 32);
      const history = await target.fetchHistory();
      await Worker.runReplayHistory({ workflowBundle: bundle }, JSON.parse(historyToJSON(history)), targetWorkflowId);
      await assertClosedReceipt(source);
      await assertClosedReceipt(target);
    });
  });

  it("propagates repair invalidation across three live partitions before recomputation", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const sourcePadding = Array.from({ length: 256 }, (_, index) => ({ ...node, id: `before-middle-${index.toString().padStart(3, "0")}` }));
    const targetPadding = Array.from({ length: 256 }, (_, index) => ({ ...node, id: `next-middle-${index.toString().padStart(3, "0")}` }));
    const source = { ...node, id: "a", outputPorts: { value: { type: "number" } } };
    const bridge = { ...node, id: "m", dependsOn: ["a"], outputPorts: { value: { type: "number" } } };
    const approval = { id: "z-approval", kind: "approval", dependsOn: ["m"], choices: ["approve"], context: { kind: "literal", value: null }, actorScope: "owner", expiresInMs: 60_000, onDenied: "fail", onExpired: "fail" };
    const publish = { ...node, id: "zz-publish-repaired", dependsOn: ["z-approval"], effects: ["publish"] };
    const repairFactory = compiled([source, ...sourcePadding, bridge, ...targetPadding, approval, publish], "partition-repair-transitive");
    const sourcePartition = repairFactory.partitions.find((partition) => partition.nodeIds.includes("a"));
    const middlePartition = repairFactory.partitions.find((partition) => partition.nodeIds.includes("m"));
    const targetPartition = repairFactory.partitions.find((partition) => partition.nodeIds.includes("z-approval"));
    assert.ok(sourcePartition);
    assert.ok(middlePartition);
    assert.ok(targetPartition);
    assert.equal(new Set([sourcePartition.id, middlePartition.id, targetPartition.id]).size, 3);
    assert.ok(targetPartition.nodeIds.includes("zz-publish-repaired"));
    const sourceHoldId = sourcePartition.nodeIds.find((id) => id.startsWith("before-middle-"));
    const middleHoldId = middlePartition.nodeIds.find((id) => id.startsWith("next-middle-"));
    assert.ok(sourceHoldId);
    assert.ok(middleHoldId);
    const logicalRunId = `partition-repair-${process.pid}`;
    const partitions = [sourcePartition, middlePartition, targetPartition];
    const workflowId = (partitionId) => `tenant/${logicalRunId}/partitions/${partitionId}`;
    const handles = new Map();
    const sequences = new Map();
    const send = async (partitionId, event) => {
      const handle = handles.get(partitionId);
      assert.ok(handle);
      const sequence = (sequences.get(partitionId) ?? 0) + 1;
      sequences.set(partitionId, sequence);
      await handle.signal("factoryInbox", { sequence, eventId: event.id, eventHash: eventHash(event), event });
    };
    let releaseReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    let releaseSourceHold!: () => void;
    const sourceHold = new Promise<void>((resolve) => { releaseSourceHold = resolve; });
    let releaseMiddleHold!: () => void;
    const middleHold = new Promise<void>((resolve) => { releaseMiddleHold = resolve; });
    const approvals = [];
    let approvalArrived!: () => void;
    let nextApproval = new Promise<void>((resolve) => { approvalArrived = resolve; });
    let publishCount = 0;
    let targetInvalidationDelivered!: () => void;
    const targetInvalidation = new Promise<void>((resolve) => { targetInvalidationDelivered = resolve; });
    const activities = {
      ...definitionActivities(repairFactory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") {
          if (command.nodeId === sourceHoldId) await waitForReleaseOrCancellation(sourceHold);
          if (command.nodeId === middleHoldId) await waitForReleaseOrCancellation(middleHold);
          if (command.nodeId === "a" && command.candidateGeneration === 1) await waitForReleaseOrCancellation(replacementGate);
          if (command.nodeId === "zz-publish-repaired") publishCount += 1;
          return { kind: "node-result", id: `${command.id}:result`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, output: command.nodeId === "a" || command.nodeId === "m" ? { value: command.candidateGeneration + 1 } : {} };
        }
        if (command.kind === "request-approval") {
          approvals.push(command);
          approvalArrived();
          return null;
        }
        if (command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        if (command.kind === "notify-partition") {
          const { kind: _kind, id, ...completion } = command;
          await send(command.targetPartitionId, { kind: "partition-node-completed", id, atMs: Date.now(), ...completion });
          return null;
        }
        if (command.kind === "invalidate-partition") {
          const { kind: _kind, id, ...invalidation } = command;
          await send(command.targetPartitionId, { kind: "partition-source-invalidated", id, atMs: Date.now(), ...invalidation });
          if (command.targetPartitionId === targetPartition.id && command.nodeId === "z-approval") targetInvalidationDelivered();
          return null;
        }
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      for (const partition of [targetPartition, middlePartition, sourcePartition]) {
        const stored = storedPartition(repairFactory, partition.id);
        const handle = await environment.client.workflow.start("factoryWorkflow", {
          workflowId: workflowId(partition.id), taskQueue: queue, retry: { maximumAttempts: 1 },
          args: [workflowInput(repairFactory, { logicalRunId, interpreterId: partition.id, startedAtMs, definition: stored.source })],
        });
        handles.set(partition.id, handle);
      }
      await nextApproval;
      const oldApproval = approvals[0];
      assert.ok(oldApproval);
      const repair = { kind: "repair", id: "repair-partition-source", atMs: Date.now(), nodeId: "a", reason: "replace source" };
      await send(sourcePartition.id, repair);
      await Promise.race([
        targetInvalidation,
        new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error("target invalidation command was not delivered")), 5_000); }),
      ]);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await handles.get(targetPartition.id).query("factoryState");
        if (state.nodes["z-approval"].candidateGeneration === 1 && state.nodes["z-approval"].status === "blocked") break;
        if (attempt === 99) assert.fail("target approval was not transitively invalidated");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const staleDecision = { kind: "approval-decided", id: "stale-partition-approval", atMs: Date.now(), nodeId: "z-approval", commandId: oldApproval.id, choice: "approve" };
      await send(targetPartition.id, staleDecision);
      assert.equal(publishCount, 0);
      nextApproval = new Promise<void>((resolve) => { approvalArrived = resolve; });
      releaseReplacement();
      await nextApproval;
      const newApproval = approvals[1];
      assert.ok(newApproval);
      assert.notEqual(newApproval.id, oldApproval.id);
      assert.equal(publishCount, 0);
      const currentDecision = { kind: "approval-decided", id: "current-partition-approval", atMs: Date.now(), nodeId: "z-approval", commandId: newApproval.id, choice: "approve" };
      await send(targetPartition.id, currentDecision);
      assert.equal((await handles.get(targetPartition.id).result()).status, "completed");
      assert.equal(publishCount, 1);
      releaseSourceHold();
      releaseMiddleHold();
      for (const partition of partitions.slice(0, 2)) assert.equal((await handles.get(partition.id).result()).status, "completed");
      for (const partition of partitions) await assertClosedReceipt(handles.get(partition.id));
    });
  });

  it("cancels an in-flight activity and waits for the fenced stop acknowledgement", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    let cancelledResult: FactoryWorkflowResult | undefined;
    let dispatchStarted = () => undefined;
    const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
    const activities = {
      ...definitionActivities(factory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: startedAtMs + 1, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") {
          await waitForActivityCancellation(dispatchStarted);
        }
        if (command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: startedAtMs + 3, nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/cancel-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(factory, { logicalRunId: "cancel", startedAtMs })],
      });
      await started;
      const future = { kind: "repair", id: "future-repair", atMs: startedAtMs + 2, nodeId: "work", reason: "queued after cancellation" };
      await handle.signal("factoryInbox", { sequence: 2, eventId: future.id, eventHash: eventHash(future), event: future });
      assert.deepEqual(await handle.query("factoryInboxReceipt"), {
        acknowledgedSequence: 0,
        pending: [{ sequence: 2, eventId: future.id, eventHash: eventHash(future) }],
      });
      const cancel = { kind: "cancel", id: "cancel-event", atMs: startedAtMs + 2, reason: "requested" };
      await handle.signal("factoryInbox", { sequence: 1, eventId: cancel.id, eventHash: eventHash(cancel), event: cancel });
      cancelledResult = await handle.result();
      assert.equal(cancelledResult.status, "cancelled", JSON.stringify(cancelledResult));
      assert.equal(cancelledResult.state.nodes.work.attempts[0].stopped, true);
      await assertClosedReceipt(handle);
    });
    assert.equal(cancelledResult?.status, "cancelled");
    assert.equal(cancelledResult?.state.nodes.work.attempts[0].stopped, true);
  });

  it("uses a durable retry timer and succeeds on the second fenced attempt", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const retryFactory = compiled([{ ...node, retry: { maxAttempts: 3, initialDelayMs: 0, maximumDelayMs: 0 } }], "retry");
    let dispatches = 0;
    const activities = {
      ...definitionActivities(retryFactory),
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
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const result = await environment.client.workflow.execute("factoryWorkflow", {
        workflowId: `tenant/retry-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(retryFactory, { logicalRunId: "retry", startedAtMs })],
      });
      assert.equal(result.status, "completed");
    });
    assert.equal(dispatches, 2);
  });

  it("resolves a durable artifact field through the recorded command activity", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const lazyFactory = compiled([
      { ...node, bindings: { value: { kind: "ref", root: "input", name: "data", path: ["label"] } }, inputPorts: { value: { type: "string" } }, outputPorts: { value: { type: "string" } } },
    ], "lazy-field", lazyDataInput);
    const artifact = { artifactId: "lazy-field", digest: packageDigest, encodedBytes: 70_000 };
    const observed = [];
    const activities = {
      ...definitionActivities(lazyFactory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        observed.push(command.kind);
        if (command.kind === "read-input-value") {
          assert.deepEqual(command, { ...command, name: "data", artifact, path: ["label"], maxBytes: 32 * 1024 });
          return { kind: "input-value-read", id: `${command.id}:value`, atMs: startedAtMs + 1, commandId: command.id, nodeId: command.nodeId, candidateGeneration: command.candidateGeneration, cancellationEpoch: command.cancellationEpoch, name: command.name, artifact: command.artifact, path: command.path, storageVersion: "storage-v1", mediaType: "application/json", value: "loaded" };
        }
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: startedAtMs + 2, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") {
          assert.deepEqual(command.input, { value: "loaded" });
          return { kind: "node-result", id: `${command.id}:result`, atMs: startedAtMs + 3, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, output: { value: "loaded" } };
        }
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const result = await environment.client.workflow.execute("factoryWorkflow", {
        workflowId: `tenant/lazy-field-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(lazyFactory, { logicalRunId: "lazy-field", startedAtMs, input: { data: { label: "placeholder" } }, durableInput: { schemaVersion: "factory.lazy-input.v1", parameters: { data: { kind: "artifact", artifact } } } })],
      });
      assert.equal(result.status, "completed");
      assert.deepEqual(result.state.durableInput, { schemaVersion: "factory.lazy-input.v1", parameters: { data: { kind: "artifact", artifact } } });
      assert.equal(result.state.lazyInput?.versions[`${artifact.artifactId}\u0000${artifact.digest}\u0000${artifact.encodedBytes}`], "storage-v1");
    });
    assert.deepEqual(observed, ["read-input-value", "request-admission", "dispatch-node"]);
  });

  it("passes the tagged descriptor and command correlation into a child workflow", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const childFactory = compiled([
      { ...node, bindings: { value: { kind: "ref", root: "input", name: "data", path: ["label"] } }, inputPorts: { value: { type: "string" } }, outputPorts: { value: { type: "string" } } },
    ], "lazy-child", lazyDataInput);
    const parentFactory = compiled([{ id: "child", kind: "subfactory", factory: { id: "lazy-child", version: "1", digest: childFactory.digest }, releaseMode: "none", grants: [] }], "lazy-parent", lazyDataInput);
    const artifact = { artifactId: "lazy-child", digest: packageDigest, encodedBytes: 70_000 };
    let resolvedCommandId: string | undefined;
    let childLogicalRunId: string | undefined;
    const baseActivities = definitionActivities(parentFactory, childFactory);
    const activities = {
      ...baseActivities,
      resolveFactory: async (request) => {
        resolvedCommandId = request.commandId;
        return baseActivities.resolveFactory(request);
      },
      recordTransition: async () => undefined,
      executeCommand: async ({ logicalRunId, command }) => {
        if (command.kind === "read-input-value") {
          childLogicalRunId = logicalRunId;
          assert.deepEqual(command.artifact, artifact);
          return { kind: "input-value-read", id: `${command.id}:value`, atMs: startedAtMs + 1, commandId: command.id, nodeId: command.nodeId, candidateGeneration: command.candidateGeneration, cancellationEpoch: command.cancellationEpoch, name: command.name, artifact: command.artifact, path: command.path, storageVersion: "storage-v1", mediaType: "application/json", value: "child" };
        }
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: startedAtMs + 2, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") return { kind: "node-result", id: `${command.id}:result`, atMs: startedAtMs + 3, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, attempt: command.attempt, output: { value: "child" } };
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const result = await environment.client.workflow.execute("factoryWorkflow", {
        workflowId: `tenant/lazy-parent-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(parentFactory, { logicalRunId: "lazy-parent", startedAtMs, input: { data: { label: "placeholder" } }, durableInput: { schemaVersion: "factory.lazy-input.v1", parameters: { data: { kind: "artifact", artifact } } } })],
      });
      assert.equal(result.status, "completed");
    });
    assert.ok(resolvedCommandId);
    assert.match(childLogicalRunId ?? "", /^child-[a-f0-9]{64}$/);
    const child = await environment.client.workflow.getHandle(factoryWorkflowId("tenant", childLogicalRunId!)).describe();
    assert.equal(child.type, "factoryWorkflow");
  });

  it("fails an undeclared durable input once before recording a transition or effect", { timeout: 45_000 }, async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    let work = 0;
    const activities = {
      ...definitionActivities(factory),
      recordTransition: async () => { work += 1; },
      executeCommand: async () => { work += 1; throw new Error("invalid input must not execute"); },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/undeclared-durable-input-${process.pid}`, taskQueue: queue,
        workflowExecutionTimeout: "10 seconds", retry: { maximumAttempts: 1 },
        args: [workflowInput(factory, { logicalRunId: "undeclared-durable-input", startedAtMs, input: { data: {} }, durableInput: { schemaVersion: "factory.lazy-input.v1", parameters: { data: { kind: "artifact", artifact: { artifactId: "undeclared", digest: packageDigest, encodedBytes: 70_000 } } } } })],
      });
      await assert.rejects(handle.result(), (error) => {
        const cause = (error as { cause?: { type?: string; nonRetryable?: boolean; message?: string } }).cause;
        return cause?.type === "FACTORY_INPUT_INVALID" && cause.nonRetryable === true && cause.message === "Durable input contains an undeclared port.";
      });
    });
    assert.equal(work, 0);
  });

  it("runs a pinned subfactory as a child workflow", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const childFactory = compiled([], "child");
    const parentFactory = compiled([{ id: "child", kind: "subfactory", factory: { id: "child", version: "1", digest: childFactory.digest }, releaseMode: "none", grants: [] }], "parent");
    const activities = {
      ...definitionActivities(parentFactory, childFactory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => { throw new Error(`unexpected ${command.kind}`); },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const result = await environment.client.workflow.execute("factoryWorkflow", {
        workflowId: `tenant/parent-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(parentFactory, { logicalRunId: "parent", startedAtMs })],
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
      ...definitionActivities(parentFactory, childFactory),
      recordTransition: async () => undefined,
      executeCommand: async ({ logicalRunId, command }) => {
        if (logicalRunId !== "cancel-parent" && command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: startedAtMs + 1, nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (logicalRunId !== "cancel-parent" && command.kind === "dispatch-node") {
          await waitForActivityCancellation(childStarted);
        }
        if (logicalRunId === "cancel-parent" && command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: startedAtMs + 3, nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        throw new Error(`unexpected ${logicalRunId}:${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/cancel-parent-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(parentFactory, { logicalRunId: "cancel-parent", startedAtMs })],
      });
      await started;
      const cancel = { kind: "cancel", id: "cancel-child", atMs: startedAtMs + 2, reason: "requested" };
      await handle.signal("factoryInbox", { sequence: 1, eventId: cancel.id, eventHash: eventHash(cancel), event: cancel });
      assert.equal((await handle.result()).status, "cancelled");
      await assertClosedReceipt(handle);
    });
  });

  it("continues only from a quiescent state and restores absolute timers", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const approval = { id: "approval", kind: "approval", choices: ["approve"], context: { kind: "literal", value: null }, actorScope: "owner", expiresInMs: 60_000, onDenied: "fail", onExpired: "fail" };
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
      ...definitionActivities(approvalFactory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: startedAtMs + 60_001, nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/continue-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [{
          tenantId: "tenant", projectId: "project", logicalRunId: "continue", interpreterId: "interpreter", startedAtMs,
          ...workflowInput(approvalFactory, { logicalRunId: "continue", startedAtMs }),
          continuation: { state: continuationState, inbox: [{ kind: "repair", id: "ignored-repair", atMs: startedAtMs + 1, nodeId: "approval", reason: "ignored while waiting" }], pendingInbox: [], sourceSequence: 1, handledSinceContinuation: 63, acknowledgedInboxSequence: 0 },
        }],
      });
      assert.equal((await handle.result()).status, "failed");
    });
  });

  it("rejects a continuation that substitutes its durable descriptor", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const continuationFactory = compiled([node], "durable-continuation-factory", lazyDataInput);
    const artifact = { artifactId: "persisted", digest: packageDigest, encodedBytes: 70_000 };
    const replacement = { artifactId: "replacement", digest: packageDigest, encodedBytes: 70_000 };
    const state = createKernelState(continuationFactory, "durable-continuation", {}, startedAtMs, {
      schemaVersion: "factory.lazy-input.v1",
      parameters: { data: { kind: "artifact", artifact } },
    });
    let effects = 0;
    const activities = {
      ...definitionActivities(continuationFactory),
      recordTransition: async () => { effects += 1; },
      executeCommand: async () => { effects += 1; throw new Error("mismatched continuation must not execute"); },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/durable-continuation-${process.pid}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(continuationFactory, {
          logicalRunId: "durable-continuation",
          startedAtMs,
          durableInput: { schemaVersion: "factory.lazy-input.v1", parameters: { data: { kind: "artifact", artifact: replacement } } },
          continuation: { state, inbox: [], pendingInbox: [], sourceSequence: 0, handledSinceContinuation: 0, acknowledgedInboxSequence: 0 },
        })],
      });
      await assert.rejects(handle.result(), (error) => (error as { cause?: { message?: unknown } }).cause?.message === "continuation durable input does not match workflow input");
    });
    assert.equal(effects, 0);
  });

  it("persists ordered approval inbox positions across repeated continuations and accepts cancellation after them", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const approval = { id: "approval", kind: "approval", choices: ["approve"], context: { kind: "literal", value: null }, actorScope: "owner", expiresInMs: 60_000, onDenied: "fail", onExpired: "fail" };
    const gatedTask = { ...node, id: "after-approval", dependsOn: ["approval"] };
    const approvalFactory = compiled([approval, gatedTask], "continued-approval");
    const initial = createKernelState(approvalFactory, "continued-approval", {}, startedAtMs);
    const started = advanceKernel(approvalFactory, initial, { kind: "start", id: "continued-approval:start", atMs: startedAtMs });
    const approvalCommand = started.commands.find((command) => command.kind === "request-approval");
    assert.ok(approvalCommand);
    let taskStarted = () => undefined;
    const taskIsRunning = new Promise<void>((resolve) => { taskStarted = resolve; });
    const activities = {
      ...definitionActivities(approvalFactory),
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "request-admission") return { kind: "admission-result", id: `${command.id}:admitted`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.id, candidateGeneration: command.candidateGeneration, granted: true };
        if (command.kind === "dispatch-node") {
          await waitForActivityCancellation(taskStarted);
        }
        if (command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const workflowId = `tenant/continued-approval-${process.pid}`;
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [{
          ...workflowInput(approvalFactory, { logicalRunId: "continued-approval", startedAtMs }),
          continuation: { state: started.nextState, inbox: [], pendingInbox: [], sourceSequence: 1, handledSinceContinuation: 63, acknowledgedInboxSequence: 0 },
        }],
      });
      const firstRunId = (await handle.describe()).runId;
      const repair = { kind: "repair", id: "repair-before-continuation", atMs: startedAtMs + 1, nodeId: "approval", reason: "ignored while waiting" };
      await handle.signal("factoryInbox", { sequence: 1, eventId: repair.id, eventHash: eventHash(repair), event: repair });
      const secondRunId = await waitForContinuedRun(handle, firstRunId);
      for (let sequence = 2; sequence <= 65; sequence += 1) {
        const ignored = { kind: "repair", id: `repair-before-second-continuation-${sequence}`, atMs: startedAtMs + sequence, nodeId: "approval", reason: "ignored while waiting" };
        await handle.signal("factoryInbox", { sequence, eventId: ignored.id, eventHash: eventHash(ignored), event: ignored });
      }
      const decision = { kind: "approval-decided", id: "approval-during-second-continuation", atMs: startedAtMs + 66, nodeId: "approval", commandId: approvalCommand.id, choice: "approve" };
      await handle.signal("factoryInbox", { sequence: 66, eventId: decision.id, eventHash: eventHash(decision), event: decision });
      await taskIsRunning;
      const current = environment.client.workflow.getHandle(workflowId);
      assert.notEqual((await current.describe()).runId, secondRunId);
      const forged = {
        commandId: "forged-decision",
        requestId: "forged-decision",
        tenantId: "tenant",
        projectId: "project",
        logicalRunId: "continued-approval",
        workflowId,
        kind: "decision",
        eventId: "forged-at-acknowledged-sequence",
        eventSequence: 66,
        eventHash: hash("forged-at-acknowledged-sequence"),
        body: { kind: "cancel", id: "forged-at-acknowledged-sequence", atMs: Date.now(), reason: "must not match" },
      };
      assert.equal(await reconcileFactoryCommand(environment.client, forged, { confirmInboxIdentity: async () => false }), "outcome_unknown");
      const cancel = { kind: "cancel", id: "cancel-after-continuation", atMs: Date.now(), reason: "requested" };
      await current.signal("factoryInbox", { sequence: 67, eventId: cancel.id, eventHash: eventHash(cancel), event: cancel });
      const result = await handle.result();
      assert.equal(result.status, "cancelled");
      await assertClosedReceipt(current);
    });
  });

  it("keeps a 9,999-item nested map bounded across paged transitions and repeated continuations", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const mapFactory = compileDefinition({
      schemaVersion: "factory.v1", id: "bounded-map", version: "1", interpreterCompatibility: "1",
      inputPorts: { items: { type: "array", items: { type: "number" }, maxItems: 9_999 } },
      outputPorts: { choices: { type: "array", items: { type: "string" } } },
      graph: {
        nodes: [{
          id: "map", kind: "map", collection: { kind: "ref", root: "input", name: "items", path: [] }, itemSchema: { type: "number" },
          body: {
            nodes: [{ id: "approve", kind: "approval", choices: ["approve"], context: { kind: "ref", root: "map", name: "item", path: [] }, actorScope: "owner", expiresInMs: 60_000, onDenied: "fail", onExpired: "fail", outputPorts: { choice: { type: "string" } } }],
            outputs: { choices: { kind: "ref", root: "node", name: "approve", path: ["choice"] } },
          },
          outputPorts: { choices: { type: "array", items: { type: "string" } } },
          mode: "all", maxItems: 9_999, maxConcurrency: 1,
        }],
        outputs: { choices: { kind: "ref", root: "node", name: "map", path: ["choices"] } },
      },
      acceptance: { id: "test-acceptance", version: "1", claims: [{ id: "test", validator: runner, required: true, protected: true }], groups: [] },
      packages: [{ name: runner.package, version: runner.version, digest: runner.digest }],
      capabilities: [], effects: ["none"], bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16, runDeadlineMs: 600_000 },
    });
    const base = definitionActivities(mapFactory);
    const pageCounts = new Map();
    const activities = {
      ...base,
      stageTransitionPage: async (request) => {
        pageCounts.set(request.sourceSequence, (pageCounts.get(request.sourceSequence) ?? 0) + 1);
        return base.stageTransitionPage(request);
      },
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => {
        if (command.kind === "request-approval") return null;
        if (command.kind === "cancel-node") return { kind: "attempt-stopped", id: `${command.id}:stopped`, atMs: Date.now(), nodeId: command.nodeId, commandId: command.attemptCommandId, candidateGeneration: command.candidateGeneration, attempt: command.attempt };
        throw new Error(`unexpected ${command.kind}`);
      },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const workflowId = `tenant/bounded-map-${process.pid}`;
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(mapFactory, { logicalRunId: "bounded-map", startedAtMs, input: { items: Array.from({ length: 9_999 }, () => 0) } })],
      });
      for (let attempt = 0; pageCounts.size === 0 && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(pageCounts.size > 0, "initial transition was not persisted");
      let initial: KernelState | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        initial = await waitForState(handle);
        if (initial.nodes["map/items/0/approve"]) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(initial);
      assert.ok(initial.nodes["map/items/0/approve"], "first map item was not opened");
      assert.deepEqual(Object.keys(initial.nodes).sort(), ["map", "map/items/0/approve"]);
      assert.equal(initial.scopes.root.expandedNodeCount, 2);
      assert.ok([...pageCounts.values()].some((count) => count > 1), "large transition did not use bounded pages");

      const firstRunId = (await handle.describe()).runId;
      for (let sequence = 1; sequence <= 63; sequence += 1) {
        const repair = { kind: "repair", id: `bounded-map-repair-${sequence}`, atMs: startedAtMs + sequence, nodeId: "map/items/0/approve", reason: "protected approval remains waiting" };
        await handle.signal("factoryInbox", { sequence, eventId: repair.id, eventHash: eventHash(repair), event: repair });
      }
      const secondRunId = await waitForContinuedRun(handle, firstRunId);
      for (let sequence = 64; sequence <= 127; sequence += 1) {
        const repair = { kind: "repair", id: `bounded-map-repair-${sequence}`, atMs: startedAtMs + sequence, nodeId: "map/items/0/approve", reason: "protected approval remains waiting" };
        await handle.signal("factoryInbox", { sequence, eventId: repair.id, eventHash: eventHash(repair), event: repair });
      }
      await waitForContinuedRun(handle, secondRunId);
      const restored = await waitForState(handle);
      assert.deepEqual(Object.keys(restored.nodes).sort(), ["map", "map/items/0/approve"]);
      assert.equal(restored.scopes.root.expandedNodeCount, 2);
      const cancel = { kind: "cancel", id: "bounded-map-cancel", atMs: Date.now(), reason: "test complete" };
      await handle.signal("factoryInbox", { sequence: 128, eventId: cancel.id, eventHash: eventHash(cancel), event: cancel });
      assert.equal((await handle.result()).status, "cancelled");
      await assertClosedReceipt(handle);
    });
  });

  it("persists and restores a completed 9,999-item output through bounded pages", async () => {
    const startedAtMs = Math.trunc(await environment.currentTimeMs());
    const emptyOutput = { nodes: [], outputs: { value: { kind: "literal", value: "" } } };
    const completedMapFactory = compileDefinition({
      schemaVersion: "factory.v1", id: "completed-bounded-map", version: "1", interpreterCompatibility: "1",
      inputPorts: { items: { type: "array", items: { type: "number" }, maxItems: 9_999 } },
      outputPorts: { values: { type: "array", items: { type: "string" } } },
      graph: {
        nodes: [{
          id: "map", kind: "map", collection: { kind: "ref", root: "input", name: "items", path: [] }, itemSchema: { type: "number" },
          body: {
            nodes: [{ id: "choose", kind: "branch", condition: { kind: "literal", value: true }, then: emptyOutput, else: emptyOutput, outputPorts: { value: { type: "string" } } }],
            outputs: { values: { kind: "ref", root: "node", name: "choose", path: ["value"] } },
          },
          outputPorts: { values: { type: "array", items: { type: "string" } } }, mode: "all", maxItems: 9_999, maxConcurrency: 1,
        }],
        outputs: { values: { kind: "ref", root: "node", name: "map", path: ["values"] } },
      },
      acceptance: { id: "test-acceptance", version: "1", claims: [{ id: "test", validator: runner, required: true, protected: true }], groups: [] },
      packages: [{ name: runner.package, version: runner.version, digest: runner.digest }],
      capabilities: [], effects: ["none"], bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16, runDeadlineMs: 600_000 },
    });
    const base = definitionActivities(completedMapFactory);
    const pageCounts = new Map();
    const activities = {
      ...base,
      stageTransitionPage: async (request) => {
        pageCounts.set(request.sourceSequence, (pageCounts.get(request.sourceSequence) ?? 0) + 1);
        return base.stageTransitionPage(request);
      },
      recordTransition: async () => undefined,
      executeCommand: async ({ command }) => { throw new Error(`unexpected ${command.kind}`); },
    };
    const worker = await createFactoryWorker({ connection: environment.nativeConnection, namespace, activities });
    await worker.runUntil(async () => {
      const logicalRunId = `completed-bounded-map-${process.pid}`;
      const handle = await environment.client.workflow.start("factoryWorkflow", {
        workflowId: `tenant/${logicalRunId}`, taskQueue: queue, retry: { maximumAttempts: 1 },
        args: [workflowInput(completedMapFactory, { logicalRunId, startedAtMs, input: { items: Array.from({ length: 9_999 }, (_, index) => index) } })],
      });
      const result = await handle.result();
      assert.equal(result.status, "completed");
      assert.deepEqual(Object.keys(result.state.nodes), ["map"]);
      assert.deepEqual(Object.keys(result.state.scopes), ["root"]);
      assert.equal(result.state.scopes.root.expandedNodeCount, 10_000);
      assert.equal(result.state.nodes.map.output.values.length, 9_999);
      assert.ok([...pageCounts.values()].some((count) => count > 1), "completed output transition did not use bounded pages");
      await assertClosedReceipt(handle);
    });
  });
});
