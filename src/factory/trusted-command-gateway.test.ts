import { expect, test } from "bun:test";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { TrustedFactoryCommandGateway } from "./trusted-command-gateway";

const raw = "a".repeat(64);
const request = { schemaVersion: "factory.runner.request.v1", authority: { attemptId: "attempt", tenantId: "tenant", projectId: "project", runId: "run", nodeInstanceId: "node", candidateGeneration: 0, attemptNumber: 0, grantRevision: 0, reservationGeneration: 0, executionEpoch: 0, cancellationEpoch: 0, deadlineAtMs: 2_000_000_000_000, nextOperationIndex: 0 }, runner: { package: "runner", version: "1", digest: `sha256:${raw}`, export: "run" }, input: { kind: "inline", value: {} }, grants: [], resources: {}, tools: [], broker: { attemptToken: "token", audience: "gateway" } } as FactoryRunnerRequest;

test("trusted command gateway admits a persisted command before runner dispatch and never accepts body authority", async () => {
  const calls: string[] = [];
  const gateway = new TrustedFactoryCommandGateway({ admit: async (service, reference) => { calls.push(`admit:${service.subject}:${reference.commandId}`); return request; } }, { run: async value => { calls.push(`run:${value.authority.attemptId}`); return { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: -1, operations: [] }; } });
  await expect(gateway.dispatch({ subject: "temporal", tenantId: "tenant" }, { tenantId: "tenant", projectId: "project", logicalRunId: "run", interpreterId: "interpreter", commandId: "command" })).resolves.toMatchObject({ status: "cancelled" });
  expect(calls).toEqual(["admit:temporal:command", "run:attempt"]);
  await expect(gateway.dispatch({ subject: "temporal", tenantId: "other" }, { tenantId: "tenant", projectId: "project", logicalRunId: "run", interpreterId: "interpreter", commandId: "command" })).rejects.toThrow("invalid");
});
