import { describe, expect, test } from "bun:test";
import type {
  SandboxOperationKind,
  SandboxProtocolOperation,
} from "@ezcorp/extension-contract";
import { createIncusTransportCommand, IncusSandboxAdapter } from "./adapter";
import type { IncusConnectionConfig } from "./config";
import { createHostIncusTransport, INCUS_HOST_TRANSPORT_RPC } from "./host-transport";
import { INCUS_PRESETS } from "./manifest";
import {
  IncusTransportError,
  type IncusProbeResult,
  type IncusTransport,
  type IncusTransportRequest,
} from "./transport";

const rpcDeadlineMs = Date.parse("2026-09-22T12:00:00Z");
const nowMs = Date.parse("2026-09-22T11:00:00Z");
const connectionId = "connection-1";
const sandboxId = "sandbox-1";
const config: IncusConnectionConfig = {
  connectionId,
  serverCertificateSha256: "a".repeat(64),
  project: "ezharness",
  profile: "ezharness-feature",
  helperVersion: "0.1.0",
  guestUser: "sandbox",
};
const scope = { providerId: "incus", connectionId, sandboxId, rpcDeadlineMs };
const mutation = { ...scope, requestId: "request-1", idempotencyKey: "idempotency-1" };

test("operation inspection carries the original journal identity only when supplied", () => {
  const input = { ...scope, operationId: "incus-create-uuid", requestId: "journal-1", idempotencyKey: "journal-1" };
  expect(createIncusTransportCommand("lifecycle.inspectOperation", input, config).idempotency)
    .toEqual({ requestId: "journal-1", key: "journal-1" });
  expect(createIncusTransportCommand("lifecycle.inspectOperation", { ...scope, operationId: input.operationId }, config).idempotency)
    .toBeUndefined();
});
const sandbox = {
  sandboxId,
  profile: "linux-exec.v1",
  presetId: "incus-linux-exec-v1",
  desiredState: "running",
  observedState: "running",
  generation: 1,
  bootId: "boot-1",
  observedAt: "2026-09-22T11:00:00Z",
};
const process = {
  processId: "process-1",
  sandboxId,
  bootId: "boot-1",
  state: "succeeded",
  startedAt: "2026-09-22T11:00:00Z",
  finishedAt: "2026-09-22T11:00:01Z",
  exitCode: 0,
  signal: null,
};

function receipt(kind: SandboxOperationKind) {
  return {
    operationId: `operation-${kind}`,
    kind,
    requestId: mutation.requestId,
    idempotencyKey: mutation.idempotencyKey,
    sandboxId,
    acceptedAt: "2026-09-22T11:00:00Z",
  };
}

const probe: IncusProbeResult = {
  serverCertificateSha256: config.serverCertificateSha256,
  project: config.project,
  profile: config.profile,
  helperVersion: config.helperVersion,
  backendApi: "incus.v1",
  backendVersion: "6.0.6",
  architecture: "amd64",
  storageDriver: "zfs",
  isolation: "container",
  nestedCompose: true,
  controls: {
    restrictedProject: true,
    unprivileged: true,
    projectLimits: true,
    privateNetwork: true,
    workspaceRoot: "/workspace",
    explicitGuestUser: true,
    atomicFileReplace: true,
    durableProcesses: true,
    boundedOutput: true,
    endpointProxy: true,
  },
};

class FakeTransport implements IncusTransport {
  readonly commands: IncusTransportRequest[] = [];
  constructor(readonly respond: (command: IncusTransportRequest) => unknown | Promise<unknown>) {}
  async request(command: Readonly<IncusTransportRequest>): Promise<unknown> {
    const copy = structuredClone(command);
    this.commands.push(copy);
    return this.respond(copy);
  }
}

function adapter(transport: IncusTransport): IncusSandboxAdapter {
  return new IncusSandboxAdapter(config, transport, () => nowMs);
}

describe("Incus sandbox adapter discovery", () => {
  test("describes only the declared profiles, presets and stable capabilities without I/O", async () => {
    const transport = new FakeTransport(() => {
      throw new Error("describe must stay local");
    });
    expect(await adapter(transport).invoke("describe", { providerId: "incus" })).toEqual({
      providerId: "incus",
      protocolMajor: 1,
      profiles: ["linux-exec.v1", "persistent-web-compose.v1"],
      presetIds: INCUS_PRESETS.map((preset) => preset.id),
      capabilities: ["lifecycle.v1", "files.v1", "processes.v1", "endpoints.v1"],
    });
    expect(transport.commands).toEqual([]);
  });

  test("preflight is a bounded non-allocating probe and reports observed facts", async () => {
    const transport = new FakeTransport(() => probe);
    const input = {
      providerId: "incus",
      connectionId,
      profile: "persistent-web-compose.v1",
      presetId: "incus-compose-v1",
      presetDigest: "b".repeat(64),
      effectiveSettingsDigest: "c".repeat(64),
    };
    expect(await adapter(transport).invoke("preflight", input)).toEqual({
      observation: {
        backendApi: "incus.v1",
        backendVersion: "6.0.6",
        architecture: "amd64",
        storageDriver: "zfs",
        isolation: "container",
        nestedCompose: true,
      },
    });
    expect(transport.commands).toEqual([
      {
        action: "probe",
        connectionId,
        deadlineMs: nowMs + 30_000,
        pins: config,
        tags: { managedBy: "ezharness-incus-sandbox", connectionId },
        payload: {
          providerId: "incus",
          profile: "persistent-web-compose.v1",
          presetId: "incus-compose-v1",
          presetDigest: "b".repeat(64),
          effectiveSettingsDigest: "c".repeat(64),
          allocate: false,
        },
      },
    ]);
  });

  test("preflight fails closed for every pin, required control and preset requirement", async () => {
    const input = {
      providerId: "incus",
      connectionId,
      profile: "persistent-web-compose.v1",
      presetId: "incus-compose-v1",
      presetDigest: "b".repeat(64),
      effectiveSettingsDigest: "c".repeat(64),
    };
    for (const changed of [
      { serverCertificateSha256: "d".repeat(64) },
      { project: "other-project" },
      { profile: "other-profile" },
      { helperVersion: "0.2.0" },
      { backendApi: "incus.v2" },
      { architecture: "arm64" as const },
      { storageDriver: "dir" },
      { isolation: "virtual-machine" as const },
      { nestedCompose: false },
    ]) {
      const transport = new FakeTransport(() => ({ ...probe, ...changed }));
      await expect(adapter(transport).invoke("preflight", input)).rejects.toThrow();
      expect(transport.commands).toHaveLength(1);
    }
    for (const control of Object.keys(probe.controls).filter((name) => name !== "workspaceRoot")) {
      const transport = new FakeTransport(() => ({
        ...probe,
        controls: { ...probe.controls, [control]: false },
      }));
      await expect(adapter(transport).invoke("preflight", input)).rejects.toThrow(control);
    }
    const unsafeRoot = new FakeTransport(() => ({
      ...probe,
      controls: { ...probe.controls, workspaceRoot: "/" },
    }));
    await expect(adapter(unsafeRoot).invoke("preflight", input)).rejects.toThrow("unsafe workspace root");

    for (const changed of [
      { providerId: "other" },
      { connectionId: "connection-2" },
    ]) {
      const transport = new FakeTransport(() => {
        throw new Error("must not dispatch");
      });
      await expect(adapter(transport).invoke("preflight", { ...input, ...changed })).rejects.toThrow("does not match");
      expect(transport.commands).toEqual([]);
    }
  });
});

describe("Incus sandbox adapter translation", () => {
  test("translates every lifecycle, file, process and endpoint method with bounded scope", async () => {
    const responses: Record<string, unknown> = {
      "instance.create": { ok: true, receipt: receipt("create") },
      "instance.inspect": { ok: true, sandbox },
      "instance.list": { ok: true, sandboxes: [sandbox] },
      "instance.setPower": { ok: true, receipt: receipt("setPower") },
      "instance.destroy": { ok: true, receipt: receipt("destroy") },
      "operation.inspect": {
        ok: true,
        operation: {
          operationId: "operation-create",
          kind: "create",
          sandboxId,
          state: "succeeded",
          desiredState: "running",
          observedState: "running",
          resourceId: null,
          startedAt: "2026-09-22T11:00:00Z",
          finishedAt: "2026-09-22T11:00:01Z",
          error: null,
        },
      },
      "helper.file.stat": {
        ok: true,
        file: { path: "src/app.ts", kind: "file", revision: "revision-1", sizeBytes: 5, executable: false },
      },
      "helper.file.list": {
        ok: true,
        directoryRevision: "revision-src",
        entries: [
          { path: "src/app.ts", kind: "file", revision: "revision-1", sizeBytes: 5, executable: false },
        ],
      },
      "helper.file.readRange": {
        ok: true,
        path: "src/app.ts",
        revision: "revision-1",
        offsetBytes: 0,
        dataBase64: btoa("hello"),
        byteLength: 5,
        eof: true,
      },
      "helper.file.writeAtomic": {
        ok: true,
        path: "src/app.ts",
        revision: "revision-2",
        sizeBytes: 5,
      },
      "helper.file.remove": { ok: true, receipt: receipt("fileRemove") },
      "helper.process.start": {
        ok: true,
        processId: "process-1",
        bootId: "boot-1",
        startedAt: "2026-09-22T11:00:00Z",
      },
      "helper.process.inspect": { ok: true, process },
      "helper.process.readOutput": {
        ok: true,
        chunks: [{ stream: "stdout", offsetBytes: 0, dataBase64: btoa("hello"), byteLength: 5 }],
        nextCursor: { sandboxId, processId: "process-1", bootId: "boot-1", offsetBytes: 5 },
        eof: true,
      },
      "helper.process.cancel": { ok: true, receipt: receipt("processCancel") },
      "endpoint.open": {
        ok: true,
        endpointId: "endpoint-1",
        url: "https://preview.example.test/e/1",
        expiresAt: "2026-09-22T13:00:00Z",
      },
      "endpoint.close": { ok: true, receipt: receipt("endpointClose") },
    };
    const transport = new FakeTransport((command) => responses[command.action]);
    const outputCursor = { sandboxId, processId: "process-1", bootId: "boot-1", offsetBytes: 0 };
    const exchanges: Array<[SandboxProtocolOperation, unknown]> = [
      ["lifecycle.create", { ...mutation, profile: "linux-exec.v1", presetId: "incus-linux-exec-v1", presetDigest: "b".repeat(64), effectiveSettingsDigest: "c".repeat(64), desiredState: "running" }],
      ["lifecycle.inspect", scope],
      ["lifecycle.list", { providerId: "incus", connectionId, rpcDeadlineMs, limit: 1 }],
      ["lifecycle.setPower", { ...mutation, desiredState: "stopped", expectedGeneration: 1 }],
      ["lifecycle.destroy", { ...mutation, expectedGeneration: 1 }],
      ["lifecycle.inspectOperation", { ...scope, operationId: "operation-create" }],
      ["files.stat", { ...scope, path: "src/app.ts" }],
      ["files.list", { ...scope, path: "src", limit: 1 }],
      ["files.readRange", { ...scope, path: "src/app.ts", revision: "revision-1", offsetBytes: 0, lengthBytes: 5 }],
      ["files.writeAtomic", { ...mutation, path: "src/app.ts", expectedRevision: "revision-1", dataBase64: btoa("hello"), byteLength: 5, executable: false }],
      ["files.remove", { ...mutation, path: "src/app.ts", expectedRevision: "revision-2", recursive: false }],
      ["processes.start", { ...mutation, argv: ["bun", "test"], cwd: ".", user: "sandbox", env: [{ name: "CI", value: "1" }], processDeadlineMs: rpcDeadlineMs + 60_000 }],
      ["processes.inspect", { ...scope, processId: "process-1", bootId: "boot-1" }],
      ["processes.readOutput", { ...scope, processId: "process-1", bootId: "boot-1", cursor: outputCursor, maxBytes: 5 }],
      ["processes.cancel", { ...mutation, processId: "process-1", bootId: "boot-1" }],
      ["endpoints.open", { ...mutation, port: 3000, protocol: "http", expiresAt: "2026-09-22T13:00:00Z" }],
      ["endpoints.close", { ...mutation, endpointId: "endpoint-1" }],
    ];
    for (const [operation, input] of exchanges) {
      const result = await adapter(transport).invoke(operation, input);
      expect(result).toEqual(responses[transport.commands.at(-1)!.action]);
    }
    expect(transport.commands.map((command) => command.action)).toEqual([
      "instance.create",
      "instance.inspect",
      "instance.list",
      "instance.setPower",
      "instance.destroy",
      "operation.inspect",
      "helper.file.stat",
      "helper.file.list",
      "helper.file.readRange",
      "helper.file.writeAtomic",
      "helper.file.remove",
      "helper.process.start",
      "helper.process.inspect",
      "helper.process.readOutput",
      "helper.process.cancel",
      "endpoint.open",
      "endpoint.close",
    ]);
    for (const command of transport.commands) {
      expect(command.connectionId).toBe(connectionId);
      expect(command.deadlineMs).toBe(rpcDeadlineMs);
      expect(command.pins).toEqual(config);
      expect(command.tags.managedBy).toBe("ezharness-incus-sandbox");
      if (command.action !== "instance.list") {
        expect(command.sandboxName).toMatch(/^ezh-[a-f0-9]{32}$/);
        expect(command.tags.sandboxId).toBe(sandboxId);
      }
    }
    const mutations = transport.commands.filter((command) => command.idempotency);
    expect(mutations.map((command) => command.action)).toEqual([
      "instance.create",
      "instance.setPower",
      "instance.destroy",
      "helper.file.writeAtomic",
      "helper.file.remove",
      "helper.process.start",
      "helper.process.cancel",
      "endpoint.open",
      "endpoint.close",
    ]);
    expect(mutations.every((command) => command.idempotency?.requestId === mutation.requestId)).toBe(true);
    expect(mutations.every((command) => command.idempotency?.key === mutation.idempotencyKey)).toBe(true);
    for (const command of transport.commands.filter((candidate) => candidate.action.startsWith("helper.file."))) {
      expect(command.payload).toMatchObject({ user: "sandbox", cwd: "/workspace" });
    }
    const processStart = transport.commands.find((command) => command.action === "helper.process.start")!;
    expect(processStart.payload).toMatchObject({ user: "sandbox", cwd: ".", workspaceRoot: "/workspace" });
  });

  test("rejects an unapproved guest user before transport dispatch", async () => {
    const transport = new FakeTransport(() => {
      throw new Error("must not dispatch");
    });
    expect(await adapter(transport).invoke("processes.start", {
      ...mutation,
      argv: ["true"],
      cwd: ".",
      user: "root",
      env: [],
      processDeadlineMs: rpcDeadlineMs + 1,
    })).toEqual({
      ok: false,
      error: { code: "PERMISSION_DENIED", message: "The requested guest user is not approved", retryable: false },
    });
    expect(transport.commands).toEqual([]);
  });

  test("rejects provider, connection and expired scopes before transport dispatch", async () => {
    const transport = new FakeTransport(() => {
      throw new Error("must not dispatch");
    });
    for (const [input, code] of [
      [{ ...scope, providerId: "other" }, "INVALID_ARGUMENT"],
      [{ ...scope, connectionId: "connection-2" }, "PERMISSION_DENIED"],
      [{ ...scope, rpcDeadlineMs: nowMs }, "DEADLINE_EXCEEDED"],
    ] as const) {
      expect(await adapter(transport).invoke("lifecycle.inspect", input)).toMatchObject({
        ok: false,
        error: { code, retryable: false },
      });
    }
    expect(transport.commands).toEqual([]);
  });

  test("derives resource names from both connection and sandbox identity", async () => {
    const first = new FakeTransport(() => ({ ok: true, sandbox }));
    const second = new FakeTransport(() => ({ ok: true, sandbox }));
    await adapter(first).invoke("lifecycle.inspect", scope);
    await new IncusSandboxAdapter(
      { ...config, connectionId: "connection-2" },
      second,
      () => nowMs,
    ).invoke("lifecycle.inspect", { ...scope, connectionId: "connection-2" });
    expect(first.commands[0]!.sandboxName).toMatch(/^ezh-[a-f0-9]{32}$/);
    expect(second.commands[0]!.sandboxName).toMatch(/^ezh-[a-f0-9]{32}$/);
    expect(first.commands[0]!.sandboxName).not.toBe(second.commands[0]!.sandboxName);
  });

  test("rejects unsupported create pairs and escaped cursors before transport dispatch", async () => {
    const transport = new FakeTransport(() => {
      throw new Error("must not dispatch");
    });
    const cases: Array<[SandboxProtocolOperation, unknown]> = [
      ["lifecycle.create", {
        ...mutation,
        profile: "persistent-web-compose.v1",
        presetId: "incus-linux-exec-v1",
        presetDigest: "b".repeat(64),
        effectiveSettingsDigest: "c".repeat(64),
        desiredState: "running",
      }],
      ["lifecycle.list", {
        providerId: "incus",
        connectionId,
        rpcDeadlineMs,
        limit: 1,
        cursor: { connectionId: "connection-2", afterSandboxId: sandboxId },
      }],
      ["files.list", {
        ...scope,
        path: "src",
        limit: 1,
        cursor: { sandboxId: "sandbox-2", directoryRevision: "revision-src", afterName: "app.ts" },
      }],
      ["processes.readOutput", {
        ...scope,
        processId: "process-1",
        bootId: "boot-1",
        cursor: { sandboxId, processId: "process-2", bootId: "boot-1", offsetBytes: 0 },
        maxBytes: 1,
      }],
    ];
    for (const [operation, input] of cases) {
      expect(await adapter(transport).invoke(operation, input)).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGUMENT", retryable: false },
      });
    }
    expect(transport.commands).toEqual([]);
  });
});

describe("Incus sandbox adapter failures", () => {
  const createInput = {
    ...mutation,
    profile: "linux-exec.v1",
    presetId: "incus-linux-exec-v1",
    presetDigest: "b".repeat(64),
    effectiveSettingsDigest: "c".repeat(64),
    desiredState: "running",
  };

  test("preserves a stable unknown mutation outcome without blind retry", async () => {
    const transport = new FakeTransport(() => {
      throw new IncusTransportError("unavailable", "raw-canary", {
        effect: "unknown",
        operationId: "operation-unknown",
      });
    });
    expect(await adapter(transport).invoke("lifecycle.create", createInput)).toEqual({
      ok: false,
      error: {
        code: "OUTCOME_UNKNOWN",
        message: "The Incus mutation outcome is unknown",
        retryable: false,
        operationId: "operation-unknown",
      },
    });
    expect(JSON.stringify(await adapter(transport).invoke("lifecycle.create", createInput))).not.toContain("raw-canary");
  });

  test("does not fabricate OUTCOME_UNKNOWN without a stable operation identity", async () => {
    const transport = new FakeTransport(() => {
      throw new IncusTransportError("unavailable", "lost", { effect: "unknown" });
    });
    expect(await adapter(transport).invoke("lifecycle.create", createInput)).toEqual({
      ok: false,
      error: {
        code: "INTERNAL",
        message: "The Incus transport lost a mutation without a stable operation identity",
        retryable: false,
      },
    });
  });

  test("does not retry an unclassified lost mutation from an injected transport", async () => {
    for (const kind of ["deadline", "unavailable", "internal"] as const) {
      const transport = new FakeTransport(() => {
        throw new IncusTransportError(kind, "lost reply");
      });
      expect(await adapter(transport).invoke("lifecycle.create", createInput)).toEqual({
        ok: false,
        error: {
          code: "INTERNAL",
          message: "The Incus transport lost a mutation without a stable operation identity",
          retryable: false,
        },
      });
    }
  });

  test("maps transport failures to bounded provider errors and redacts raw diagnostics", async () => {
    const cases = [
      ["invalid", "INVALID_ARGUMENT", false],
      ["not_found", "NOT_FOUND", false],
      ["already_exists", "ALREADY_EXISTS", false],
      ["revision_conflict", "REVISION_CONFLICT", false],
      ["unsupported", "UNSUPPORTED_CAPABILITY", false],
      ["deadline", "DEADLINE_EXCEEDED", true],
      ["unavailable", "UNAVAILABLE", true],
      ["permission", "PERMISSION_DENIED", false],
      ["resource_exhausted", "RESOURCE_EXHAUSTED", false],
      ["internal", "INTERNAL", false],
    ] as const;
    for (const [kind, code, retryable] of cases) {
      const transport = new FakeTransport(() => {
        throw new IncusTransportError(kind, "secret-raw-diagnostic");
      });
      const result = await adapter(transport).invoke("lifecycle.inspect", scope) as {
        ok: false;
        error: { code: string; retryable: boolean; message: string };
      };
      expect(result.error.code).toBe(code);
      expect(result.error.retryable).toBe(retryable);
      expect(result.error.message).not.toContain("secret-raw-diagnostic");
    }
  });

  test("validates bounded output and scope after the transport returns", async () => {
    const oversized = new FakeTransport(() => ({
      ok: true,
      path: "src/app.ts",
      revision: "revision-1",
      offsetBytes: 0,
      dataBase64: Buffer.alloc(65_537).toString("base64"),
      byteLength: 65_537,
      eof: true,
    }));
    await expect(adapter(oversized).invoke("files.readRange", {
      ...scope,
      path: "src/app.ts",
      revision: "revision-1",
      offsetBytes: 0,
      lengthBytes: 1,
    })).rejects.toThrow();

    const escaped = new FakeTransport(() => ({ ok: true, sandbox: { ...sandbox, sandboxId: "other" } }));
    await expect(adapter(escaped).invoke("lifecycle.inspect", scope)).rejects.toThrow("changed sandbox identity");
  });
});

describe("host-mediated Incus transport", () => {
  const command: IncusTransportRequest = {
    action: "instance.inspect",
    connectionId,
    deadlineMs: rpcDeadlineMs,
    pins: config,
    tags: { managedBy: "ezharness-incus-sandbox", connectionId, sandboxId },
    sandboxName: "ezh-0123456789abcdef0123456789abcdef",
    payload: {},
  };

  test("sends one reserved provider RPC without an endpoint or key", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const transport = createHostIncusTransport({
      call: async (method, input) => {
        calls.push({ method, input });
        return { ok: true, result: { ok: true, sandbox } };
      },
    });
    expect(await transport.request(command)).toEqual({ ok: true, sandbox });
    expect(calls).toEqual([
      {
        method: INCUS_HOST_TRANSPORT_RPC,
        input: { command },
      },
    ]);
    const sent = JSON.stringify(calls).toLowerCase();
    expect(sent).not.toContain("privatekey");
    expect(sent).not.toContain("clientcertificate");
    expect(sent).not.toContain("https://");
  });

  test("maps bounded host envelopes and rejects unavailable or malformed transport", async () => {
    for (const kind of ["invalid", "permission", "not_found", "revision_conflict", "resource_exhausted", "unavailable"] as const) {
      const transport = createHostIncusTransport({ call: async () => ({ ok: false, error: { kind, effect: "none" } }) });
      await expect(transport.request(command)).rejects.toMatchObject({ kind });
    }
    for (const response of [null, { ok: true }, { ok: false, error: {} }]) {
      const transport = createHostIncusTransport({ call: async () => response });
      await expect(transport.request(command)).rejects.toMatchObject({ kind: "internal" });
    }
    const unknown = createHostIncusTransport({
      call: async () => ({ ok: false, error: { kind: "unavailable", effect: "unknown", operationId: "operation-1" } }),
    });
    await expect(unknown.request(command)).rejects.toMatchObject({
      kind: "unavailable",
      effect: "unknown",
      operationId: "operation-1",
    });
    const untrusted = createHostIncusTransport({
      call: async () => ({ ok: false, error: { kind: "unavailable", effect: "unknown", operationId: "../../escape" } }),
    });
    await expect(untrusted.request(command)).rejects.toMatchObject({
      kind: "internal",
      effect: "none",
      operationId: undefined,
    });
    const unavailable = createHostIncusTransport({ call: async () => { throw new Error("secret-canary"); } });
    await expect(unavailable.request(command)).rejects.toMatchObject({
      kind: "unavailable",
      message: "Protected Incus transport is unavailable",
    });
  });

  test("never marks an unclassified lost mutation safe to retry", async () => {
    const createInput = {
      ...mutation,
      profile: "linux-exec.v1",
      presetId: "incus-linux-exec-v1",
      presetDigest: "b".repeat(64),
      effectiveSettingsDigest: "c".repeat(64),
      desiredState: "running",
    };
    const lost = createHostIncusTransport({ call: async () => { throw new Error("lost reply"); } });
    expect(await adapter(lost).invoke("lifecycle.create", createInput)).toEqual({
      ok: false,
      error: {
        code: "INTERNAL",
        message: "The Incus transport lost a mutation without a stable operation identity",
        retryable: false,
      },
    });

    const stable = createHostIncusTransport({
      call: async () => ({ ok: false, error: { kind: "unavailable", effect: "unknown", operationId: "operation-stable" } }),
    });
    expect(await adapter(stable).invoke("lifecycle.create", createInput)).toEqual({
      ok: false,
      error: {
        code: "OUTCOME_UNKNOWN",
        message: "The Incus mutation outcome is unknown",
        retryable: false,
        operationId: "operation-stable",
      },
    });

    const knownNone = createHostIncusTransport({
      call: async () => ({ ok: false, error: { kind: "unavailable", effect: "none" } }),
    });
    expect(await adapter(knownNone).invoke("lifecycle.create", createInput)).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", retryable: true },
    });

    for (const response of [
      { ok: true },
      { ok: false },
      { ok: false, error: { kind: "invalid", effect: "missing" } },
      { ok: true, result: "x".repeat(1_048_577) },
    ]) {
      const unclassified = createHostIncusTransport({ call: async () => response });
      expect(await adapter(unclassified).invoke("lifecycle.create", createInput)).toMatchObject({
        ok: false,
        error: {
          code: "INTERNAL",
          message: "The Incus transport lost a mutation without a stable operation identity",
          retryable: false,
        },
      });
    }
  });
});
