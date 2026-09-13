import { describe, expect, test } from "bun:test";
import { canonicalizeJson } from "./canonical";
import { compileFactory, verifyCompiledFactoryArtifact, type CompiledFactoryPageBytes } from "./compiler";
import { referenceDataV1 } from "./references";
import type {
  CompiledFactory,
  FactoryRunnerRequest,
  FactoryRunnerResult,
  JsonValue,
} from "./types";
import {
  validateCompiledFactory,
  validateFactoryRunnerRequest,
  validateFactoryRunnerResult,
} from "./validation";

const prefixedDigest = `sha256:${"a".repeat(64)}`;
const rawDigest = "b".repeat(64);

function compiled(): CompiledFactory {
  const result = compileFactory(referenceDataV1);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.factory;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value as JsonValue)) as T;
}

function pages(factory: CompiledFactory): CompiledFactoryPageBytes {
  return Object.fromEntries(factory.pages.map((page) => [
    page.id,
    new TextEncoder().encode(canonicalizeJson(page.nodeIds.map((id) => factory.indexes.nodeById[id]) as JsonValue)),
  ]));
}

function code(result: ReturnType<typeof validateCompiledFactory>): string | undefined {
  return result.ok ? undefined : result.issues[0]?.code;
}

function request(): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: {
      attemptId: "attempt-1",
      tenantId: "tenant-1",
      projectId: "project-1",
      runId: "run-1",
      nodeInstanceId: "node-1",
      candidateGeneration: 0,
      attemptNumber: 1,
      grantRevision: 2,
      reservationGeneration: 3,
      executionEpoch: 4,
      cancellationEpoch: 0,
      deadlineAtMs: 2_000_000_000_000,
      nextOperationIndex: 5,
    },
    runner: {
      package: "@example/runner",
      version: "1.2.3",
      digest: prefixedDigest,
      export: "run",
      model: "model-v1",
      configurationDigest: prefixedDigest,
    },
    input: { kind: "inline", value: JSON.parse('{"__proto__":{"safe":true},"constructor":"value","toString":"value"}') as JsonValue },
    grants: ["model:invoke", "tool:read"],
    resources: { maxCostMicros: "1000", maxTokens: 200, maxComputeMs: 30_000, memoryBytes: 1_024, resourceClass: "cpu.small" },
    model: { provider: "anthropic", model: "model-v1", configurationDigest: prefixedDigest, configuration: { temperature: 0 }, policyDigest: prefixedDigest, policy: { retries: 1 } },
    tools: [{ name: "read", description: "Read a value", inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "string" } }],
    broker: { attemptToken: "signed-attempt-token", audience: "installation-1" },
  };
}

function result(): FactoryRunnerResult {
  const checkpoint = { artifactId: "checkpoint-1", digest: prefixedDigest, encodedBytes: 512, journalCursor: 5 };
  const usage = { kind: "measured" as const, inputTokens: 10, outputTokens: 20, computeMs: 30, costMicros: "40" };
  return {
    schemaVersion: "factory.runner.result.v1",
    status: "completed",
    journalCursor: 5,
    operations: [{ operationId: "run-1:node-1:0:5", operationIndex: 5, kind: "model", requestDigest: rawDigest, state: "completed", resultDigest: rawDigest, usage, workspaceCheckpoint: checkpoint }],
    resultDigest: rawDigest,
    output: { artifactId: "result-1", digest: prefixedDigest, encodedBytes: 256 },
    usage,
    workspaceCheckpoint: checkpoint,
  };
}

describe("compiled artifact validation", () => {
  test("accepts canonical manifests and safe own-property identifiers", () => {
    const factory = compiled();
    expect(validateCompiledFactory(factory)).toEqual({ ok: true });
    expect(verifyCompiledFactoryArtifact(factory, pages(factory))).toEqual({ ok: true });

    const hostile = JSON.parse(canonicalizeJson(factory as unknown as JsonValue).replaceAll("input-snapshot", "__proto__"));
    expect(Object.hasOwn(hostile.indexes.nodeById, "__proto__")).toBe(true);
    expect(validateCompiledFactory(hostile)).toEqual({ ok: true });
  });

  test("rejects schema, digest, presentation, lock, and index tampering", () => {
    expect(code(validateCompiledFactory({}))).toBe("COMPILED_SCHEMA");
    const factory = clone(compiled());
    factory.digest = "sha256:BAD";
    expect(code(validateCompiledFactory(factory))).toBe("COMPILED_DIGEST");
    const presentation = clone(compiled());
    presentation.presentationDigest = prefixedDigest;
    expect(code(validateCompiledFactory(presentation))).toBe("COMPILED_PRESENTATION");
    const lock = clone(compiled());
    lock.lock.interpreter = "changed";
    expect(code(validateCompiledFactory(lock))).toBe("COMPILED_LOCK");
    const node = clone(compiled());
    const id = Object.keys(node.indexes.nodeById)[0]!;
    node.indexes.nodeById[id] = { ...node.indexes.nodeById[id]!, id: "changed" };
    expect(code(validateCompiledFactory(node))).toBe("COMPILED_NODE_INDEX");
    const keys = clone(compiled());
    delete keys.indexes.successors[Object.keys(keys.indexes.successors)[0]!];
    expect(code(validateCompiledFactory(keys))).toBe("COMPILED_INDEX_KEYS");
    const successor = clone(compiled());
    successor.indexes.successors[Object.keys(successor.indexes.successors)[0]!] = ["absent"];
    expect(code(validateCompiledFactory(successor))).toBe("COMPILED_SUCCESSORS");
    const count = clone(compiled());
    count.indexes.dependencyCounts[Object.keys(count.indexes.dependencyCounts)[0]!] = 9;
    expect(code(validateCompiledFactory(count))).toBe("COMPILED_DEPENDENCIES");
  });

  test("rejects partition and page manifest tampering", () => {
    const invalidPartition = clone(compiled());
    invalidPartition.partitions[0]!.id = "other";
    expect(code(validateCompiledFactory(invalidPartition))).toBe("COMPILED_PARTITION");
    const dependency = clone(compiled());
    dependency.partitions[0]!.dependsOn = [dependency.partitions.at(-1)!.id];
    expect(code(validateCompiledFactory(dependency))).toBe("COMPILED_PARTITION_DEPENDENCIES");
    const duplicateNode = clone(compiled());
    duplicateNode.partitions[0]!.nodeIds.push(duplicateNode.partitions[0]!.nodeIds[0]!);
    expect(code(validateCompiledFactory(duplicateNode))).toBe("COMPILED_PARTITION_NODE");
    const page = clone(compiled());
    page.pages[0]!.digest = "sha256:BAD";
    expect(code(validateCompiledFactory(page))).toBe("COMPILED_PAGE");
    const pageNode = clone(compiled());
    const moved = pageNode.partitions[0]!.nodeIds.pop()!;
    pageNode.partitions.push({ id: "partition-1", nodeIds: [moved], dependsOn: [] });
    expect(code(validateCompiledFactory(pageNode))).toBe("COMPILED_PAGE_NODE");
    const coverage = clone(compiled());
    coverage.pages[0]!.nodeIds.pop();
    expect(code(validateCompiledFactory(coverage))).toBe("COMPILED_PAGE_COVERAGE");
  });

  test("recompiles the definition and verifies every fetched page byte", () => {
    const factory = compiled();
    const bytes = pages(factory);
    const nonCanonical = clone(factory);
    nonCanonical.digest = prefixedDigest;
    expect(code(verifyCompiledFactoryArtifact(nonCanonical, pages(nonCanonical)))).toBe("COMPILED_CANONICAL");
    const invalidDefinition = clone(factory);
    invalidDefinition.definition.acceptance.version = "latest";
    expect(code(verifyCompiledFactoryArtifact(invalidDefinition, pages(invalidDefinition)))).toBe("COMPILED_RECOMPILE");
    expect(code(verifyCompiledFactoryArtifact(factory, { ...bytes, extra: new Uint8Array() }))).toBe("COMPILED_PAGE_BYTES");
    const corrupted = { ...bytes, [factory.pages[0]!.id]: bytes[factory.pages[0]!.id]!.slice() };
    corrupted[factory.pages[0]!.id]![0] ^= 1;
    expect(code(verifyCompiledFactoryArtifact(factory, corrupted))).toBe("COMPILED_PAGE_BYTES");
  });
});

describe("C02 generated runner wire validation", () => {
  test("accepts canonical requests, artifact resumes, and every terminal result shape", () => {
    expect(validateFactoryRunnerRequest(request())).toEqual({ ok: true });
    const resumed = clone(request());
    resumed.input = { kind: "artifact", artifact: { artifactId: "input-1", digest: prefixedDigest, encodedBytes: 4_096 } };
    resumed.checkpoint = { artifactId: "checkpoint-0", digest: prefixedDigest, encodedBytes: 100, journalCursor: -1 };
    expect(validateFactoryRunnerRequest(resumed)).toEqual({ ok: true });
    expect(validateFactoryRunnerResult(result())).toEqual({ ok: true });
    const failed: FactoryRunnerResult = { schemaVersion: "factory.runner.result.v1", status: "failed", journalCursor: 5, operations: [], resultDigest: rawDigest, error: { code: "TOOL_FAILED", message: "failed", retryable: true }, usage: { kind: "unknown", reason: "receipt lost", heldCostMicros: "100" } };
    expect(validateFactoryRunnerResult(failed)).toEqual({ ok: true });
    expect(validateFactoryRunnerResult({ schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: -1, operations: [] })).toEqual({ ok: true });
    expect(validateFactoryRunnerResult({ schemaVersion: "factory.runner.result.v1", status: "uncertain", journalCursor: 4, operations: [], providerReceiptDigest: rawDigest, usage: { kind: "unknown", reason: "provider pending", heldCostMicros: "200" } })).toEqual({ ok: true });
  });

  test("rejects malformed, oversized, stale-shaped, unpinned, and path-like requests", () => {
    expect(code(validateFactoryRunnerRequest({}))).toBe("RUNNER_REQUEST_SCHEMA");
    const oversized = request();
    oversized.broker.attemptToken = "x".repeat(70_000);
    expect(code(validateFactoryRunnerRequest(oversized))).toBe("RUNNER_WIRE_BYTES");
    const authority = request();
    authority.authority.attemptNumber = -1;
    expect(code(validateFactoryRunnerRequest(authority))).toBe("RUNNER_AUTHORITY");
    const deadline = request();
    deadline.authority.deadlineAtMs = 0;
    expect(code(validateFactoryRunnerRequest(deadline))).toBe("RUNNER_DEADLINE");
    const pin = request();
    pin.runner.version = "latest";
    expect(code(validateFactoryRunnerRequest(pin))).toBe("RUNNER_PIN");
    const model = request();
    model.model.model = "different";
    expect(code(validateFactoryRunnerRequest(model))).toBe("RUNNER_MODEL_PIN");
    const grants = request();
    grants.grants = ["same", "same"];
    expect(code(validateFactoryRunnerRequest(grants))).toBe("RUNNER_GRANT");
    const resources = request();
    resources.resources.maxCostMicros = "01";
    expect(code(validateFactoryRunnerRequest(resources))).toBe("RUNNER_RESOURCES");
    const artifact = request();
    artifact.input = { kind: "artifact", artifact: { artifactId: "../local", digest: prefixedDigest, encodedBytes: 1 } };
    expect(code(validateFactoryRunnerRequest(artifact))).toBe("RUNNER_ARTIFACT_ID");
    const checkpoint = request();
    checkpoint.checkpoint = { artifactId: "checkpoint", digest: prefixedDigest, encodedBytes: 1, journalCursor: -2 };
    expect(code(validateFactoryRunnerRequest(checkpoint))).toBe("RUNNER_CURSOR");
    const tools = request();
    tools.tools = [tools.tools[0]!, tools.tools[0]!];
    expect(code(validateFactoryRunnerRequest(tools))).toBe("RUNNER_TOOL");
    const toolSchema = request();
    toolSchema.tools[0]!.inputSchema = { type: "object", properties: {}, required: ["missing"] };
    expect(code(validateFactoryRunnerRequest(toolSchema))).toBe("RUNNER_TOOL_SCHEMA");
  });

  test("rejects malformed result cursors, operation evidence, usage, checkpoints, and terminal evidence", () => {
    expect(code(validateFactoryRunnerResult({}))).toBe("RUNNER_RESULT_SCHEMA");
    const oversized = result();
    oversized.output.artifactId = "x".repeat(70_000);
    expect(code(validateFactoryRunnerResult(oversized))).toBe("RUNNER_WIRE_BYTES");
    const cursor = result();
    cursor.journalCursor = -2;
    expect(code(validateFactoryRunnerResult(cursor))).toBe("RUNNER_CURSOR");
    const order = result();
    order.operations = [order.operations[0]!, { ...order.operations[0]! }];
    expect(code(validateFactoryRunnerResult(order))).toBe("RUNNER_OPERATION_ORDER");
    const operation = result();
    operation.operations[0]!.requestDigest = "bad";
    expect(code(validateFactoryRunnerResult(operation))).toBe("RUNNER_OPERATION");
    const operationUsage = result();
    operationUsage.operations[0]!.usage.costMicros = "01";
    expect(code(validateFactoryRunnerResult(operationUsage))).toBe("RUNNER_USAGE");
    const operationCheckpoint = result();
    operationCheckpoint.operations[0]!.workspaceCheckpoint.artifactId = "../checkpoint";
    expect(code(validateFactoryRunnerResult(operationCheckpoint))).toBe("RUNNER_ARTIFACT_ID");
    const usage = result();
    usage.usage.computeMs = -1;
    expect(code(validateFactoryRunnerResult(usage))).toBe("RUNNER_USAGE");
    const checkpoint = result();
    checkpoint.workspaceCheckpoint.journalCursor = 4;
    expect(code(validateFactoryRunnerResult(checkpoint))).toBe("RUNNER_CURSOR");
    const completed = result();
    completed.resultDigest = "bad";
    expect(code(validateFactoryRunnerResult(completed))).toBe("RUNNER_DIGEST");
    const failed = { schemaVersion: "factory.runner.result.v1", status: "failed", journalCursor: -1, operations: [], resultDigest: rawDigest, error: { code: "", message: "failed", retryable: false } };
    expect(code(validateFactoryRunnerResult(failed))).toBe("RUNNER_FAILURE");
    const uncertain = { schemaVersion: "factory.runner.result.v1", status: "uncertain", journalCursor: -1, operations: [], providerReceiptDigest: "bad", usage: { kind: "unknown", reason: "lost", heldCostMicros: "10" } };
    expect(code(validateFactoryRunnerResult(uncertain))).toBe("RUNNER_UNCERTAIN");
  });
});
