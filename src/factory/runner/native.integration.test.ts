import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { FactoryRunnerOperationResult, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { FactoryExecutionContext } from "../../runtime/factory-execution";
import { AgentExecutor } from "../../runtime/executor";
import { EventBus } from "../../runtime/events";
import { closeTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { createProject } from "../../db/queries/projects";
import { createConversation } from "../../db/queries/conversations";
import type { AgentEvents } from "../../types";
import { runNativeFactoryRunner } from "./native";

mockDbConnection();
let conversationId = "";
beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Native factory", path: "/tmp/native-factory" });
  conversationId = (await createConversation(project.id, { title: "Native factory" })).id;
});
afterAll(closeTestDb);

const raw = "a".repeat(64);
const pinned = `sha256:${raw}`;
const checkpoint = { artifactId: "checkpoint", digest: pinned, encodedBytes: 1, journalCursor: 5 };
const operation: FactoryRunnerOperationResult = { operationId: "run:node:0:5", operationIndex: 5, kind: "model", requestDigest: raw, state: "completed", resultDigest: raw, usage: { kind: "measured", inputTokens: 1, outputTokens: 1, computeMs: 1, costMicros: "0" }, workspaceCheckpoint: checkpoint };
const request: FactoryRunnerRequest = {
  schemaVersion: "factory.runner.request.v1",
  authority: { attemptId: "attempt", tenantId: "tenant", projectId: "project", runId: "run", nodeInstanceId: "node", candidateGeneration: 0, attemptNumber: 0, grantRevision: 0, reservationGeneration: 0, executionEpoch: 0, cancellationEpoch: 0, deadlineAtMs: 2_000_000_000_000, nextOperationIndex: 5 },
  runner: { package: "runner", version: "1", digest: pinned, export: "run" }, input: { kind: "inline", value: { prompt: "native" } }, grants: [], resources: {}, tools: [], broker: { attemptToken: "attempt-token", audience: "gateway" },
};

test("native Bun entrypoint executes through the shared factory runtime and derives its result from journal evidence", async () => {
  const events: string[] = [];
  const model = { id: "model", provider: "broker", api: "pi-messages", contextWindow: 100, maxTokens: 10, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<any>;
  const execution: FactoryExecutionContext = {
    attempt: { attemptToken: "attempt-token", runId: "run", nodeInstanceId: "node", candidateGeneration: 0, nextOperationIndex: 5 }, model,
    broker: { stream: async brokerRequest => {
      events.push(`broker:${brokerRequest.operation.operationId}`);
      return { async *[Symbol.asyncIterator]() {}, async result() { return { content: [{ type: "text", text: "done" }], model: "model", provider: "broker", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; } } as unknown as AssistantMessageEventStream;
    } },
    journal: { before: async item => { events.push(`before:${item.operationId}`); }, after: async item => { events.push(`after:${item.operationId}`); }, checkpointWorkspace: async () => {} },
  };
  const options = {
    execution: () => execution,
    conversation: () => ({ conversationId, userMessage: "make output" }),
    executor: new AgentExecutor(new Map(), new EventBus<AgentEvents>(), { persist: false }),
    journal: { operations: async () => [operation], journalCursor: async () => 5, usage: async () => operation.usage! },
    artifacts: { output: async () => ({ artifactId: "output", digest: pinned, encodedBytes: 4 }), checkpoint: async () => checkpoint },
  };
  const result = await runNativeFactoryRunner(request, options);
  expect(result).toMatchObject({ status: "completed", journalCursor: 5, operations: [operation], output: { artifactId: "output" }, workspaceCheckpoint: checkpoint });
  expect(events).toEqual(["before:run:node:0:5", "broker:run:node:0:5", "after:run:node:0:5"]);
  await expect(runNativeFactoryRunner(request, { ...options, executor: { executeFactoryAttempt: async () => ({ id: "cancelled", agentName: "chat", status: "cancelled" as const, startedAt: 1, logs: [] }) } })).resolves.toMatchObject({ status: "cancelled", journalCursor: 5 });
  await expect(runNativeFactoryRunner(request, { ...options, executor: { executeFactoryAttempt: async () => ({ id: "failed", agentName: "chat", status: "error" as const, startedAt: 1, logs: [], result: { success: false, output: null, error: "broker failed" } }) } })).resolves.toMatchObject({ status: "failed", error: { code: "FACTORY_AGENT_FAILED" } });
  await expect(runNativeFactoryRunner(request, {
    execution: () => ({ ...execution, attempt: { ...execution.attempt, runId: "forged" } }), conversation: () => ({ conversationId: "factory-conversation", userMessage: "make output" }),
    executor: { executeFactoryAttempt: async () => { throw new Error("must not execute forged request"); } }, journal: { operations: async () => [operation], journalCursor: async () => 5, usage: async () => operation.usage! },
    artifacts: { output: async () => ({ artifactId: "output", digest: pinned, encodedBytes: 4 }), checkpoint: async () => checkpoint },
  })).rejects.toThrow("does not match the signed runner request");
  await expect(runNativeFactoryRunner({}, {} as any)).rejects.toThrow("RUNNER_REQUEST_SCHEMA");
});
