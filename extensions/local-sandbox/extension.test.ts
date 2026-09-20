import { describe, expect, test } from "bun:test";
import { validateManifest, type ExtensionContext } from "@ezcorp/sdk/v4";
import { localSandboxDefinition, localSandboxExtension } from "./provider";
import { start } from "./extension";
import manifest from "./ezcorp.config";

const call = { scope: { projectId: "project", bindingId: "binding", generation: 1 }, operationId: "operation", idempotencyKey: "retry", requestDigest: "a".repeat(64) };
const limits = { memoryBytes: 128 * 1024 * 1024, milliCpu: 500, pids: 64, diskBytes: 32 * 1024 * 1024 };
const receipt = { operationId: call.operationId, idempotencyKey: call.idempotencyKey, requestDigest: call.requestDigest, outcome: "unknown" as const };
function context(response: unknown, calls: unknown[] = []): ExtensionContext {
  return { invocation: { invocationId: "invoke", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "project", token: "fixture", deadline: Date.now() + 30000 }, signal: new AbortController().signal, call: async (method, input) => { calls.push({ method, input }); return response; } };
}
const identity = { bootId: "boot", processId: "process" };
function inputFor(name: string): Record<string, unknown> {
  const base = { call, resourceId: "resource" };
  const inputs: Record<string, Record<string, unknown>> = {
    "sandbox/create": { call, profile: "linux-exec.v1", limits },
    "process/start": { ...base, argv: ["true"], env: {}, cwd: "/", user: "workspace", timeoutMs: 1000 },
    "process/inspect": { ...base, identity }, "process/cancel": { ...base, identity },
    "process/output": { ...base, identity, cursor: 0, maxBytes: 1 },
    "files/stat": { ...base, path: "/x" }, "files/list": { ...base, path: "/", limit: 1 },
    "files/read": { ...base, path: "/x", offsetBytes: 0, lengthBytes: 1 },
    "files/write": { ...base, path: "/x", encoding: "utf8", data: "x" },
    "files/mkdir": { ...base, path: "/x", recursive: false },
    "files/remove": { ...base, path: "/x", recursive: false },
    "files/chmod": { ...base, path: "/x", mode: 0o644 },
  };
  return inputs[name] ?? base;
}

describe("local sandbox provider", () => {
  test("declares only the canonical local profile and one approved host route", async () => {
    const definition = localSandboxDefinition();
    expect(validateManifest(definition.manifest)).toEqual(localSandboxExtension.manifest);
    expect(manifest).toBe(localSandboxExtension.manifest);
    expect(definition.manifest.permissions).toEqual({ hostApi: { events: false, routes: [{ method: "POST", path: "/api/local-sandbox/operations/:id/execute" }] } });
    expect(definition.manifest.providers?.[0]).toMatchObject({ id: "local", profiles: ["linux-exec.v1"], capabilities: [] });
    expect(Object.keys(definition.methods!)).toHaveLength(16);
    let served = false;
    await start(async (extension) => { expect(extension).toBe(localSandboxExtension); served = true; });
    expect(served).toBeTrue();
  });

  test("all methods forward only the admitted operation ID and preserve an unknown outcome", async () => {
    for (const name of Object.keys(localSandboxDefinition().methods!)) {
      const calls: unknown[] = [];
      expect(await localSandboxExtension.dispatch(name, inputFor(name), context({ status: 200, body: JSON.stringify({ receipt }) }, calls))).toEqual({ receipt });
      expect(calls).toEqual([{ method: "ezcorp/api.request", input: { method: "POST", path: "/api/local-sandbox/operations/operation/execute" } }]);
    }
  });

  test("validates successful results, host denial, malformed data, and changed receipts", async () => {
    const resource = { resourceId: "resource", desiredState: "stopped", observedState: "stopped", limits };
    const result = { receipt: { ...receipt, outcome: "succeeded" }, resource };
    expect(await localSandboxExtension.dispatch("sandbox/create", inputFor("sandbox/create"), context({ status: 200, body: JSON.stringify(result) }))).toEqual(result);
    for (const response of [null, { status: 403, body: "private host error" }, { status: 200, body: {} }, { status: 200, body: "x".repeat(512 * 1024 + 1) }, { status: 200, body: "bad json" }, { status: 200, body: JSON.stringify({ ...result, receipt: { ...result.receipt, operationId: "other" } }) }]) {
      await expect(localSandboxExtension.dispatch("sandbox/create", inputFor("sandbox/create"), context(response))).rejects.toThrow();
    }
    const calls: unknown[] = [];
    await expect(localSandboxExtension.dispatch("sandbox/create", { call, profile: "other", limits }, context({}, calls))).rejects.toThrow();
    expect(calls).toHaveLength(0);
    const aborted = context({}); const controller = new AbortController(); controller.abort();
    await expect(localSandboxExtension.dispatch("sandbox/create", inputFor("sandbox/create"), { ...aborted, signal: controller.signal })).rejects.toThrow();
  });
});
