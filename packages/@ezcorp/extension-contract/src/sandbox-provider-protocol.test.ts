import { describe, expect, test } from "bun:test";
import type { ExtensionManifestV4, SandboxProviderCapability, SandboxProtocolContribution, SandboxProtocolMethodGroup } from "./types";
import { linuxSandboxPreset, sandboxFixtureManifest } from "./sandbox-presets.fixture";
import {
  SANDBOX_PROVIDER_OPERATIONS,
  assertSandboxProviderOperationSupported,
  sandboxProviderMethodSchemas,
  sandboxProviderOperationCapability,
  validateManifest,
  validateSandboxProviderMethodExchange,
  validateSandboxProviderMethodValue,
  type SandboxProtocolOperation,
} from "./validation";

const rpcDeadlineMs = 1_790_078_460_000;
const scope = { providerId: "incus", connectionId: "connection-1", sandboxId: "sandbox-1", rpcDeadlineMs };
const mutation = { ...scope, requestId: "request-1", idempotencyKey: "idempotency-1" };
const operationReceipt = (kind: "create" | "setPower" | "destroy" | "fileRemove" | "processCancel" | "endpointClose") => ({ operationId: "operation-1", kind, requestId: mutation.requestId, idempotencyKey: mutation.idempotencyKey, sandboxId: scope.sandboxId, acceptedAt: "2026-09-22T12:00:00Z" });
const receipt = operationReceipt("create");
const capabilities: SandboxProviderCapability[] = ["lifecycle.v1", "files.v1", "processes.v1", "endpoints.v1"];

const methodGroup: SandboxProtocolMethodGroup = {
  name: "sandbox.provider.v1",
  methods: {
    describe: "sandbox/describe",
    preflight: "sandbox/preflight",
    lifecycle: {
      create: "sandbox/lifecycle/create",
      inspect: "sandbox/lifecycle/inspect",
      list: "sandbox/lifecycle/list",
      setPower: "sandbox/lifecycle/setPower",
      destroy: "sandbox/lifecycle/destroy",
      inspectOperation: "sandbox/lifecycle/inspectOperation",
    },
    files: {
      stat: "sandbox/files/stat",
      list: "sandbox/files/list",
      readRange: "sandbox/files/readRange",
      writeAtomic: "sandbox/files/writeAtomic",
      remove: "sandbox/files/remove",
    },
    processes: {
      start: "sandbox/processes/start",
      inspect: "sandbox/processes/inspect",
      readOutput: "sandbox/processes/readOutput",
      cancel: "sandbox/processes/cancel",
    },
    endpoints: { open: "sandbox/endpoints/open", close: "sandbox/endpoints/close" },
  },
};

function provider(): SandboxProtocolContribution {
  return {
    id: "incus",
    profiles: ["linux-exec.v1"],
    presets: [linuxSandboxPreset()],
    capabilities,
    kind: "sandbox",
    protocolMajor: 1,
    minimumHostContract: { major: 4, minor: 0 },
    configSchema: { type: "object", additionalProperties: false },
    requiredPermissions: ["storage"],
    methodGroups: [structuredClone(methodGroup)],
  };
}

function methodName(operation: SandboxProtocolOperation): string {
  if (operation === "describe" || operation === "preflight") return methodGroup.methods[operation];
  const [group, name] = operation.split(".") as ["lifecycle" | "files" | "processes" | "endpoints", string];
  return (methodGroup.methods[group] as unknown as Record<string, string>)[name]!;
}

describe("sandbox.provider.v1 canonical protocol", () => {
  test("publishes exactly the frozen v1 methods through one validator and accepts their canonical manifest schemas", () => {
    expect(SANDBOX_PROVIDER_OPERATIONS).toEqual([
      "describe", "preflight",
      "lifecycle.create", "lifecycle.inspect", "lifecycle.list", "lifecycle.setPower", "lifecycle.destroy", "lifecycle.inspectOperation",
      "files.stat", "files.list", "files.readRange", "files.writeAtomic", "files.remove",
      "processes.start", "processes.inspect", "processes.readOutput", "processes.cancel",
      "endpoints.open", "endpoints.close",
    ]);
    const manifest: ExtensionManifestV4 = {
      ...sandboxFixtureManifest,
      permissions: { storage: true },
      methods: SANDBOX_PROVIDER_OPERATIONS.map(operation => ({ name: methodName(operation), ...sandboxProviderMethodSchemas(operation) })),
      sandboxProviders: [provider()],
    };
    expect(validateManifest(manifest)).toEqual(manifest);
  });

  test("accepts a bounded exchange for every frozen v1 method", () => {
    const observation = { backendApi: "incus.v1", backendVersion: "6.0.6", architecture: "amd64", storageDriver: "zfs", isolation: "container", nestedCompose: false };
    const sandbox = { sandboxId: scope.sandboxId, profile: "linux-exec.v1", presetId: "default-linux", desiredState: "running", observedState: "running", generation: 1, bootId: "boot-1", observedAt: "2026-09-22T12:00:00Z" };
    const process = { processId: "process-1", sandboxId: scope.sandboxId, bootId: "boot-1", state: "succeeded", startedAt: "2026-09-22T12:00:00Z", finishedAt: "2026-09-22T12:00:01Z", exitCode: 0, signal: null };
    const outputCursor = { sandboxId: scope.sandboxId, processId: "process-1", bootId: "boot-1", offsetBytes: 0 };
    const exchanges: Record<SandboxProtocolOperation, [unknown, unknown]> = {
      describe: [{ providerId: "incus" }, { providerId: "incus", protocolMajor: 1, profiles: ["linux-exec.v1"], presetIds: ["default-linux"], capabilities }],
      preflight: [{ providerId: "incus", connectionId: scope.connectionId, profile: "linux-exec.v1", presetId: "default-linux", presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64) }, { observation }],
      "lifecycle.create": [{ ...mutation, profile: "linux-exec.v1", presetId: "default-linux", presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64), desiredState: "running" }, { ok: true, receipt }],
      "lifecycle.inspect": [scope, { ok: true, sandbox }],
      "lifecycle.list": [{ providerId: "incus", connectionId: scope.connectionId, rpcDeadlineMs, limit: 1 }, { ok: true, sandboxes: [sandbox] }],
      "lifecycle.setPower": [{ ...mutation, desiredState: "stopped", expectedGeneration: 1 }, { ok: true, receipt: operationReceipt("setPower") }],
      "lifecycle.destroy": [{ ...mutation, expectedGeneration: 1 }, { ok: true, receipt: operationReceipt("destroy") }],
      "lifecycle.inspectOperation": [{ ...scope, operationId: receipt.operationId }, { ok: true, operation: { operationId: receipt.operationId, kind: "create", sandboxId: scope.sandboxId, state: "succeeded", desiredState: "running", observedState: "running", resourceId: null, startedAt: "2026-09-22T12:00:00Z", finishedAt: "2026-09-22T12:00:01Z", error: null } }],
      "files.stat": [{ ...scope, path: "src/app.ts" }, { ok: true, file: { path: "src/app.ts", kind: "file", revision: "revision-1", sizeBytes: 5, executable: false } }],
      "files.list": [{ ...scope, path: ".", limit: 1 }, { ok: true, directoryRevision: "revision-dir", entries: [{ path: "src", kind: "directory", revision: "revision-src", sizeBytes: 0, executable: false }] }],
      "files.readRange": [{ ...scope, path: "src/app.ts", revision: "revision-1", offsetBytes: 0, lengthBytes: 5 }, { ok: true, path: "src/app.ts", revision: "revision-1", offsetBytes: 0, dataBase64: btoa("hello"), byteLength: 5, eof: true }],
      "files.writeAtomic": [{ ...mutation, path: "src/app.ts", expectedRevision: "revision-1", dataBase64: btoa("hello"), byteLength: 5, executable: false }, { ok: true, path: "src/app.ts", revision: "revision-2", sizeBytes: 5 }],
      "files.remove": [{ ...mutation, path: "src/app.ts", expectedRevision: "revision-2", recursive: false }, { ok: true, receipt: operationReceipt("fileRemove") }],
      "processes.start": [{ ...mutation, argv: ["true"], cwd: ".", user: "sandbox", env: [], processDeadlineMs: rpcDeadlineMs + 60_000 }, { ok: true, processId: "process-1", bootId: "boot-1", startedAt: "2026-09-22T12:00:00Z" }],
      "processes.inspect": [{ ...scope, processId: "process-1", bootId: "boot-1" }, { ok: true, process }],
      "processes.readOutput": [{ ...scope, processId: "process-1", bootId: "boot-1", cursor: outputCursor, maxBytes: 1 }, { ok: true, chunks: [], nextCursor: outputCursor, eof: true }],
      "processes.cancel": [{ ...mutation, processId: "process-1", bootId: "boot-1" }, { ok: true, receipt: operationReceipt("processCancel") }],
      "endpoints.open": [{ ...mutation, port: 3000, protocol: "http", expiresAt: "2026-09-22T13:00:00Z" }, { ok: true, endpointId: "endpoint-1", url: "https://preview.example.test/e/1", expiresAt: "2026-09-22T13:00:00Z" }],
      "endpoints.close": [{ ...mutation, endpointId: "endpoint-1" }, { ok: true, receipt: operationReceipt("endpointClose") }],
    };
    for (const operation of SANDBOX_PROVIDER_OPERATIONS) expect(validateSandboxProviderMethodExchange(operation, ...exchanges[operation])).toBeTruthy();
  });

  test("requires complete capability groups and distinct canonical method mappings", () => {
    expect(() => validateManifest({ ...sandboxFixtureManifest, sandboxProviders: [{ id: "incus", profiles: ["linux-exec.v1"], presets: [linuxSandboxPreset()], capabilities: ["lifecycle.v1", "files.v1", "processes.v1"] }] })).toThrow("complete contribution");

    const missing = provider();
    delete missing.methodGroups[0]!.methods.files;
    expect(() => validateManifest({ ...sandboxFixtureManifest, permissions: { storage: true }, sandboxProviders: [missing] })).toThrow("files methods");

    const unadvertised = provider();
    unadvertised.capabilities = capabilities.filter(capability => capability !== "endpoints.v1");
    expect(() => validateManifest({ ...sandboxFixtureManifest, permissions: { storage: true }, sandboxProviders: [unadvertised] })).toThrow("endpoints methods");

    const duplicate = provider();
    duplicate.methodGroups[0]!.methods.files!.stat = duplicate.methodGroups[0]!.methods.lifecycle!.inspect;
    expect(() => validateManifest({ ...sandboxFixtureManifest, permissions: { storage: true }, sandboxProviders: [duplicate] })).toThrow("distinct");
  });

  test("binds lifecycle receipts, desired and observed states, generations, cursors, and unknown outcomes", () => {
    const create = {
      ...mutation,
      profile: "linux-exec.v1",
      presetId: "default-linux",
      presetDigest: "a".repeat(64),
      effectiveSettingsDigest: "b".repeat(64),
      desiredState: "running",
    };
    expect(validateSandboxProviderMethodExchange("lifecycle.create", create, { ok: true, receipt })).toBeTruthy();
    expect(() => validateSandboxProviderMethodExchange("lifecycle.create", create, { ok: true, receipt: { ...receipt, idempotencyKey: "changed" } })).toThrow("idempotency scope");
    expect(validateSandboxProviderMethodExchange("lifecycle.inspect", scope, {
      ok: true,
      sandbox: { sandboxId: scope.sandboxId, profile: "linux-exec.v1", presetId: "default-linux", desiredState: "running", observedState: "running", generation: 2, bootId: "boot-1", observedAt: "2026-09-22T12:00:01Z" },
    })).toBeTruthy();
    expect(validateSandboxProviderMethodExchange("lifecycle.list", { providerId: "incus", connectionId: "connection-1", rpcDeadlineMs, limit: 1 }, {
      ok: true,
      sandboxes: [{ sandboxId: scope.sandboxId, profile: "linux-exec.v1", presetId: "default-linux", desiredState: "stopped", observedState: "stopped", generation: 3, bootId: null, observedAt: "2026-09-22T12:00:02Z" }],
      nextCursor: { connectionId: "connection-1", afterSandboxId: scope.sandboxId },
    })).toBeTruthy();
    const unknown = { ok: false, error: { code: "OUTCOME_UNKNOWN", message: "Create response was lost", retryable: false, operationId: "operation-1" } };
    expect(validateSandboxProviderMethodExchange("lifecycle.create", create, unknown)).toBeTruthy();
    expect(validateSandboxProviderMethodExchange("lifecycle.inspectOperation", { ...scope, operationId: "operation-1" }, {
      ok: true,
      operation: { operationId: "operation-1", kind: "create", sandboxId: scope.sandboxId, state: "outcome_unknown", desiredState: "running", observedState: "unknown", resourceId: null, startedAt: "2026-09-22T12:00:00Z", finishedAt: "2026-09-22T12:00:01Z", error: unknown.error },
    })).toBeTruthy();
    expect(() => validateSandboxProviderMethodValue("lifecycle.create", "result", { ...unknown, error: { ...unknown.error, retryable: true } })).toThrow("blind retry");
    expect(() => validateSandboxProviderMethodValue("lifecycle.create", "result", { ok: false, error: { code: "OUTCOME_UNKNOWN", message: "unknown", retryable: false } })).toThrow("stable operation");
    expect(() => validateSandboxProviderMethodValue("lifecycle.inspect", "result", unknown)).toThrow("mutating");
    expect(() => validateSandboxProviderMethodValue("lifecycle.create", "result", { ok: true, receipt: { operationId: "operation-1" } })).toThrow();
  });

  test("enforces safe relative paths, revision-bound ranges, canonical chunks, and atomic compare-and-swap writes", () => {
    const encoded = btoa("hello");
    const read = { ...scope, path: "src/app.ts", revision: "revision-1", offsetBytes: 0, lengthBytes: 5 };
    expect(validateSandboxProviderMethodExchange("files.readRange", read, { ok: true, path: read.path, revision: read.revision, offsetBytes: 0, dataBase64: encoded, byteLength: 5, eof: true })).toBeTruthy();
    expect(validateSandboxProviderMethodExchange("files.writeAtomic", { ...mutation, path: read.path, expectedRevision: read.revision, dataBase64: encoded, byteLength: 5, executable: false }, { ok: true, path: read.path, revision: "revision-2", sizeBytes: 5 })).toBeTruthy();
    expect(() => validateSandboxProviderMethodValue("files.readRange", "input", { ...read, path: "../secret" })).toThrow("Unsafe file path");
    expect(() => validateSandboxProviderMethodValue("files.readRange", "input", { ...read, path: "é".repeat(121) })).toThrow("UTF-8 byte bound");
    expect(() => validateSandboxProviderMethodValue("files.readRange", "input", { ...read, lengthBytes: 65_537 })).toThrow("file range length");
    expect(() => validateSandboxProviderMethodValue("files.writeAtomic", "input", { ...mutation, path: read.path, expectedRevision: null, dataBase64: "a===", byteLength: 1, executable: false })).toThrow("file data");
    expect(() => validateSandboxProviderMethodValue("files.writeAtomic", "input", { ...mutation, path: read.path, expectedRevision: null, dataBase64: encoded, byteLength: 4, executable: false })).toThrow("does not match");
    expect(() => validateSandboxProviderMethodValue("files.stat", "input", { ...scope, path: read.path, extra: true })).toThrow();
    expect(() => validateSandboxProviderMethodExchange("files.list", { ...scope, path: "src", limit: 1 }, {
      ok: true,
      directoryRevision: "revision-src",
      entries: [{ path: "other/app.ts", kind: "file", revision: "revision-1", sizeBytes: 5, executable: false }],
    })).toThrow("directory scope");
  });

  test("bounds process execution and keeps output cursors tied to process and boot identities", () => {
    const start = { ...mutation, argv: ["bun", "test"], cwd: ".", user: "sandbox", env: [{ name: "CI", value: "1" }], processDeadlineMs: rpcDeadlineMs + 60_000 };
    expect(validateSandboxProviderMethodExchange("processes.start", start, { ok: true, processId: "process-1", bootId: "boot-1", startedAt: "2026-09-22T12:00:00Z" })).toBeTruthy();
    const cursor = { sandboxId: scope.sandboxId, processId: "process-1", bootId: "boot-1", offsetBytes: 0 };
    const output = { ...scope, processId: "process-1", bootId: "boot-1", cursor, maxBytes: 10 };
    expect(validateSandboxProviderMethodExchange("processes.readOutput", output, {
      ok: true,
      chunks: [{ stream: "stdout", offsetBytes: 5, dataBase64: btoa("world"), byteLength: 5 }],
      nextCursor: { ...cursor, offsetBytes: 10 },
      gap: { fromOffsetBytes: 0, toOffsetBytes: 5, reason: "retention" },
      eof: false,
    })).toBeTruthy();
    expect(() => validateSandboxProviderMethodValue("processes.start", "input", { ...start, argv: [] })).toThrow("argv");
    expect(() => validateSandboxProviderMethodValue("processes.start", "input", { ...start, cwd: "/host" })).toThrow();
    expect(() => validateSandboxProviderMethodValue("processes.start", "input", { ...start, env: [{ name: "BAD-NAME", value: "x" }] })).toThrow("environment");
    expect(() => validateSandboxProviderMethodExchange("processes.readOutput", output, { ok: true, chunks: [], nextCursor: { ...cursor, sandboxId: "other" }, eof: true })).toThrow("escaped");
  });

  test("gates optional endpoints by capability and binds the approved expiry", () => {
    const description = { providerId: "incus", protocolMajor: 1, profiles: ["linux-exec.v1"], presetIds: ["default-linux"], capabilities };
    expect(sandboxProviderOperationCapability("endpoints.open")).toBe("endpoints.v1");
    expect(() => assertSandboxProviderOperationSupported(description, "endpoints.open")).not.toThrow();
    expect(() => assertSandboxProviderOperationSupported({ ...description, capabilities: capabilities.filter(capability => capability !== "endpoints.v1") }, "endpoints.open")).toThrow("does not advertise");
    const open = { ...mutation, port: 3000, protocol: "http", expiresAt: "2026-09-22T13:00:00Z" };
    expect(validateSandboxProviderMethodExchange("endpoints.open", open, { ok: true, endpointId: "endpoint-1", url: "https://preview.example.test/e/1", expiresAt: open.expiresAt })).toBeTruthy();
    expect(() => validateSandboxProviderMethodExchange("endpoints.open", open, { ok: true, endpointId: "endpoint-1", url: "https://preview.example.test/e/1", expiresAt: "2026-09-22T14:00:00Z" })).toThrow("expiry");
    expect(() => validateSandboxProviderMethodValue("endpoints.open", "result", { ok: true, endpointId: "endpoint-1", url: "http://private.example.test", expiresAt: open.expiresAt })).toThrow("HTTPS");
    expect(() => validateSandboxProviderMethodValue("endpoints.open", "result", { ok: true, endpointId: "endpoint-1", url: "https://user:password@preview.example.test", expiresAt: open.expiresAt })).toThrow("credentials");
    expect(() => validateSandboxProviderMethodValue("endpoints.open", "result", { ok: true, endpointId: "endpoint-1", url: `https://preview.example.test/${"é".repeat(1_011)}`, expiresAt: open.expiresAt })).toThrow("bounded HTTPS");
    expect(() => validateSandboxProviderMethodValue("endpoints.open", "input", { ...open, expiresAt: "2026-09-24T13:00:00Z" })).toThrow("24 hours");
    expect(() => validateSandboxProviderMethodValue("endpoints.open", "input", { ...open, rpcDeadlineMs: Date.parse("2026-03-02T11:00:00Z"), expiresAt: "2026-02-30T12:00:00Z" })).toThrow("endpoint expiry");
  });
});
