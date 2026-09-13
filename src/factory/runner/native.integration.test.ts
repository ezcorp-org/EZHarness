import { expect, test } from "bun:test";
import type { AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { FactoryRunnerRequest, FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { runNativeFactoryRunner } from "./native";

const raw = "a".repeat(64);
const pinned = `sha256:${raw}`;
const usage = { kind: "measured" as const, inputTokens: 1, outputTokens: 1, computeMs: 1, costMicros: "1" };
const checkpoint = { artifactId: "checkpoint", digest: pinned, encodedBytes: 1, journalCursor: 5 };
const request: FactoryRunnerRequest = {
  schemaVersion: "factory.runner.request.v1",
  authority: { attemptId: "attempt", tenantId: "tenant", projectId: "project", runId: "run", nodeInstanceId: "node", candidateGeneration: 0, attemptNumber: 0, grantRevision: 0, reservationGeneration: 0, executionEpoch: 0, cancellationEpoch: 0, deadlineAtMs: 2_000_000_000_000, nextOperationIndex: 5 },
  runner: { package: "runner", version: "1", digest: pinned, export: "run" }, input: { kind: "inline", value: { prompt: "native" } }, grants: [], resources: {}, tools: [], broker: { attemptToken: "attempt-token", audience: "gateway" },
};

test("native Bun entrypoint validates generated C02 wire and routes a model call through shared journal hooks", async () => {
  const events: string[] = [];
  const model = { id: "model", provider: "broker", api: "pi-messages", contextWindow: 100, maxTokens: 10, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<any>;
  const result = await runNativeFactoryRunner(request, {
    model: async () => model,
    input: async value => value.input.kind === "inline" ? value.input.value : null,
    broker: () => ({ stream: async brokerRequest => {
      events.push(`broker:${brokerRequest.operation.operationId}`);
      return { async *[Symbol.asyncIterator]() {}, async result() { return { content: [], model: "model", provider: "broker", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; } } as unknown as AssistantMessageEventStream;
    } }),
    journal: () => ({ before: async operation => { events.push(`before:${operation.operationId}`); }, after: async operation => { events.push(`after:${operation.operationId}`); }, checkpointWorkspace: async () => {} }),
    execute: async ({ runtime }) => {
      const stream = await runtime.streamFn(model, { systemPrompt: "", messages: [], tools: [] }, {});
      await stream.result();
      const output: FactoryRunnerResult = { schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor: 5, operations: [{ operationId: "run:node:0:5", operationIndex: 5, kind: "model", requestDigest: raw, state: "completed", resultDigest: raw, usage, workspaceCheckpoint: checkpoint }], resultDigest: raw, output: { artifactId: "output", digest: pinned, encodedBytes: 1 }, usage, workspaceCheckpoint: checkpoint };
      return output;
    },
  });
  expect(result.status).toBe("completed");
  expect(events).toEqual(["before:run:node:0:5", "broker:run:node:0:5", "after:run:node:0:5"]);
  await expect(runNativeFactoryRunner({}, {} as any)).rejects.toThrow("RUNNER_REQUEST_SCHEMA");
});
