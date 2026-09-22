import { describe, expect, test } from "bun:test";
import { providerMethodSchemas, validateProviderMethodExchange, validateProviderMethodValue, type SandboxProviderGroup } from "./validation";

const digest = "a".repeat(64);
const call = { scope: { projectId: "project-1", bindingId: "binding-1", generation: 1 }, operationId: "operation-1", idempotencyKey: "retry-1", requestDigest: digest };
const receipt = { operationId: call.operationId, idempotencyKey: call.idempotencyKey, requestDigest: digest, outcome: "succeeded" as const, providerOperationId: "provider-operation-1" };
const limits = { memoryBytes: 1024 * 1024, milliCpu: 1000, pids: 64, diskBytes: 1024 * 1024 * 1024 };
const resource = { resourceId: "resource-1", desiredState: "running" as const, observedState: "running" as const, limits };
const identity = { bootId: "boot-1", processId: "process-1" };
const process = { identity, state: "running" as const, outputCursor: 0 };
const entry = { path: "/src/main.ts", kind: "file" as const, revision: "revision-1", sizeBytes: 2, mode: 0o644 };

const methods: Array<{ group: SandboxProviderGroup; operation: string; input: Record<string, unknown>; result: Record<string, unknown> }> = [
  { group: "sandbox.lifecycle.v1", operation: "create", input: { call, profile: "linux-exec.v1", limits }, result: { receipt, resource } },
  { group: "sandbox.lifecycle.v1", operation: "inspect", input: { call, resourceId: resource.resourceId }, result: { receipt, resource } },
  { group: "sandbox.lifecycle.v1", operation: "start", input: { call, resourceId: resource.resourceId }, result: { receipt, resource } },
  { group: "sandbox.lifecycle.v1", operation: "stop", input: { call, resourceId: resource.resourceId }, result: { receipt, resource } },
  { group: "sandbox.lifecycle.v1", operation: "destroy", input: { call, resourceId: resource.resourceId }, result: { receipt, resource } },
  { group: "sandbox.process.v1", operation: "start", input: { call, resourceId: resource.resourceId, argv: ["bun", "test"], env: { CI: "1" }, cwd: "/", user: "workspace", timeoutMs: 60_000 }, result: { receipt, process } },
  { group: "sandbox.process.v1", operation: "inspect", input: { call, resourceId: resource.resourceId, identity }, result: { receipt, process } },
  { group: "sandbox.process.v1", operation: "readOutput", input: { call, resourceId: resource.resourceId, identity, cursor: 0, maxBytes: 1024 }, result: { receipt, identity, cursor: 2, chunks: [{ stream: "stdout", encoding: "utf8", data: "ok" }], eof: false, gap: false } },
  { group: "sandbox.process.v1", operation: "cancel", input: { call, resourceId: resource.resourceId, identity }, result: { receipt, process: { ...process, state: "cancelled" } } },
  { group: "sandbox.files.v1", operation: "stat", input: { call, resourceId: resource.resourceId, path: entry.path }, result: { receipt, entry } },
  { group: "sandbox.files.v1", operation: "list", input: { call, resourceId: resource.resourceId, path: "/src", limit: 10 }, result: { receipt, entries: [entry], nextCursor: "cursor-1" } },
  { group: "sandbox.files.v1", operation: "read", input: { call, resourceId: resource.resourceId, path: entry.path, revision: entry.revision, offsetBytes: 0, lengthBytes: 1024 }, result: { receipt, path: entry.path, revision: entry.revision, offsetBytes: 0, nextOffsetBytes: 2, eof: true, encoding: "utf8", data: "ok" } },
  { group: "sandbox.files.v1", operation: "write", input: { call, resourceId: resource.resourceId, path: entry.path, expectedRevision: entry.revision, encoding: "base64", data: "b2s=" }, result: { receipt, entry } },
  { group: "sandbox.files.v1", operation: "mkdir", input: { call, resourceId: resource.resourceId, path: "/src/new", recursive: true }, result: { receipt, entry: { ...entry, path: "/src/new", kind: "directory", sizeBytes: 0, mode: 0o755 } } },
  { group: "sandbox.files.v1", operation: "remove", input: { call, resourceId: resource.resourceId, path: entry.path, expectedRevision: entry.revision, recursive: false }, result: { receipt, removedRevision: entry.revision } },
  { group: "sandbox.files.v1", operation: "chmod", input: { call, resourceId: resource.resourceId, path: entry.path, expectedRevision: entry.revision, mode: 0o755 }, result: { receipt, entry: { ...entry, mode: 0o755 } } },
];

function validate(group: SandboxProviderGroup, operation: string, input: unknown, result: unknown): void {
  validateProviderMethodExchange(group, operation as never, input, result);
}

describe("sandbox provider wire contract", () => {
  test("all method schemas admit succeeded, failed, and unknown receipts", () => {
    for (const method of methods) {
      const schemas = providerMethodSchemas(method.group, method.operation as never);
      expect(JSON.stringify(schemas).length).toBeLessThan(256 * 1024);
      validate(method.group, method.operation, method.input, method.result);
      validate(method.group, method.operation, method.input, { receipt: { ...receipt, outcome: "failed", error: { code: "backend_failed", message: "failed", retryable: true } } });
      validate(method.group, method.operation, method.input, { receipt: { ...receipt, outcome: "unknown" } });
      expect(() => validate(method.group, method.operation, method.input, { receipt })).toThrow();
      expect(() => validate(method.group, method.operation, method.input, { ...method.result, receipt: { ...receipt, outcome: "unknown" } })).toThrow();
    }
  });

  test("receipts preserve the exact operation, idempotency key, and request digest", () => {
    const method = methods[0]!;
    for (const field of ["operationId", "idempotencyKey", "requestDigest"] as const) {
      expect(() => validate(method.group, method.operation, method.input, { ...method.result, receipt: { ...receipt, [field]: field === "requestDigest" ? "b".repeat(64) : "changed" } })).toThrow(`changed ${field}`);
    }
    expect(() => validateProviderMethodValue("sandbox.lifecycle.v1", "create", "result", { receipt: { ...receipt, outcome: "failed" } })).toThrow();
    expect(() => validateProviderMethodValue("sandbox.lifecycle.v1", "create", "result", { receipt: { ...receipt, error: { code: "bad", message: "bad", retryable: false } }, resource })).toThrow();
  });

  test("rejects unsafe identities, resource units, process limits, paths, and byte ranges", () => {
    const create = methods[0]!;
    for (const badCall of [
      { ...call, scope: { ...call.scope, generation: 0 } },
      { ...call, scope: { ...call.scope, projectId: "../project" } },
      { ...call, requestDigest: "short" },
    ]) expect(() => validate(create.group, create.operation, { ...create.input, call: badCall }, create.result)).toThrow();
    for (const badLimits of [{ ...limits, memoryBytes: 0 }, { ...limits, milliCpu: 1_000_001 }, { ...limits, pids: 32_769 }, { ...limits, diskBytes: 1.5 }]) expect(() => validate(create.group, create.operation, { ...create.input, limits: badLimits }, create.result)).toThrow();

    const processStart = methods.find(method => method.group === "sandbox.process.v1" && method.operation === "start")!;
    for (const change of [{ argv: [] }, { argv: ["x".repeat(4097)] }, { argv: ["bad\0arg"] }, { env: { "BAD-NAME": "x" } }, { env: { BAD: "nul\0value" } }, { cwd: "/../host" }, { timeoutMs: 86_400_001 }]) expect(() => validate(processStart.group, processStart.operation, { ...processStart.input, ...change }, processStart.result)).toThrow();
    const output = methods.find(method => method.operation === "readOutput")!;
    expect(() => validate(output.group, output.operation, { ...output.input, maxBytes: 262_145 }, output.result)).toThrow();

    const read = methods.find(method => method.group === "sandbox.files.v1" && method.operation === "read")!;
    for (const change of [{ path: "relative" }, { path: "/src/" }, { path: "/src/../host" }, { lengthBytes: 0 }, { lengthBytes: 262_145 }]) expect(() => validate(read.group, read.operation, { ...read.input, ...change }, read.result)).toThrow();
    const write = methods.find(method => method.operation === "write")!;
    for (const change of [{ data: "%%%", encoding: "base64" }, { data: "a".repeat(262_145), encoding: "utf8" }]) expect(() => validate(write.group, write.operation, { ...write.input, ...change }, write.result)).toThrow();
  });

  test("bounds provider output, revisions, modes, and list pages", () => {
    const output = methods.find(method => method.operation === "readOutput")!;
    expect(() => validate(output.group, output.operation, output.input, { ...output.result, chunks: [{ stream: "stdout", encoding: "utf8", data: "a".repeat(262_145) }] })).toThrow();
    expect(() => validate(output.group, output.operation, output.input, { ...output.result, chunks: Array.from({ length: 257 }, () => ({ stream: "stdout", encoding: "utf8", data: "" })) })).toThrow();
    const list = methods.find(method => method.operation === "list")!;
    expect(() => validate(list.group, list.operation, { ...list.input, limit: 257 }, list.result)).toThrow();
    expect(() => validate(list.group, list.operation, { ...list.input, cursor: "../cursor" }, list.result)).toThrow();
    expect(() => validate(list.group, list.operation, list.input, { ...list.result, entries: Array.from({ length: 257 }, () => entry) })).toThrow();
    expect(() => validate(list.group, list.operation, list.input, { ...list.result, nextCursor: "../cursor" })).toThrow();
    expect(() => validate(list.group, list.operation, list.input, { ...list.result, entries: [{ ...entry, mode: 0o1000 }] })).toThrow();
    const read = methods.find(method => method.group === "sandbox.files.v1" && method.operation === "read")!;
    expect(() => validate(read.group, read.operation, read.input, { ...read.result, revision: "../revision" })).toThrow();
    expect(() => validate(read.group, read.operation, read.input, { ...read.result, nextOffsetBytes: -1 })).toThrow();
    expect(() => validate(read.group, read.operation, read.input, { ...read.result, offsetBytes: 2, nextOffsetBytes: 1 })).toThrow();
    const remove = methods.find(method => method.operation === "remove")!;
    expect(() => validate(remove.group, remove.operation, remove.input, { ...remove.result, removedRevision: "../revision" })).toThrow();
    expect(() => providerMethodSchemas("sandbox.files.v1", "unsupported" as never)).toThrow("Unsupported provider method");
  });

  test("binds successful payload identity and ranges to the request", () => {
    const lifecycle = methods.find(method => method.group === "sandbox.lifecycle.v1" && method.operation === "start")!;
    expect(() => validate(lifecycle.group, lifecycle.operation, lifecycle.input, { ...lifecycle.result, resource: { ...resource, resourceId: "resource-2" } })).toThrow("changed resource ID");

    const inspect = methods.find(method => method.group === "sandbox.process.v1" && method.operation === "inspect")!;
    expect(() => validate(inspect.group, inspect.operation, inspect.input, { ...inspect.result, process: { ...process, identity: { ...identity, processId: "process-2" } } })).toThrow("changed process identity");
    const output = methods.find(method => method.operation === "readOutput")!;
    expect(() => validate(output.group, output.operation, output.input, { ...output.result, identity: { ...identity, bootId: "boot-2" } })).toThrow("changed process identity");
    expect(() => validate(output.group, output.operation, { ...output.input, cursor: 3 }, { ...output.result, cursor: 2 })).toThrow("cursor or byte range");
    expect(() => validate(output.group, output.operation, { ...output.input, maxBytes: 1 }, output.result)).toThrow("cursor or byte range");
    expect(() => validate(output.group, output.operation, output.input, { ...output.result, cursor: 1, chunks: [] })).toThrow("cursor or byte range");
    for (const chunk of [
      { stream: "stdout", encoding: "utf8", data: "€" },
      { stream: "stdout", encoding: "base64", data: "wqM=" },
    ] as const) {
      expect(() => validate(output.group, output.operation, output.input, { ...output.result, cursor: 1, chunks: [chunk], gap: true })).toThrow("cursor or byte range");
      expect(() => validate(output.group, output.operation, output.input, { ...output.result, cursor: chunk.encoding === "utf8" ? 3 : 2, chunks: [chunk], gap: true })).not.toThrow();
    }

    const stat = methods.find(method => method.operation === "stat")!;
    expect(() => validate(stat.group, stat.operation, stat.input, { ...stat.result, entry: { ...entry, path: "/other" } })).toThrow("changed file path");
    const read = methods.find(method => method.group === "sandbox.files.v1" && method.operation === "read")!;
    for (const change of [
      { path: "/other" },
      { revision: "revision-2" },
      { offsetBytes: 1, nextOffsetBytes: 3 },
      { nextOffsetBytes: 1 },
    ]) expect(() => validate(read.group, read.operation, read.input, { ...read.result, ...change })).toThrow();
    expect(() => validate(read.group, read.operation, { ...read.input, lengthBytes: 1 }, read.result)).toThrow("invalid byte range");

    const list = methods.find(method => method.operation === "list")!;
    expect(() => validate(list.group, list.operation, list.input, { ...list.result, entries: [{ ...entry, path: "/other/file" }] })).toThrow("outside the requested directory");
    expect(() => validate(list.group, list.operation, list.input, { ...list.result, entries: [{ ...entry, path: "/src/nested/file" }] })).toThrow("outside the requested directory");
    const remove = methods.find(method => method.operation === "remove")!;
    expect(() => validate(remove.group, remove.operation, remove.input, { ...remove.result, removedRevision: "revision-2" })).toThrow("changed the expected revision");
  });
});
