import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { startRunnerService } from "../src/service";
import { RunnerClient, executionLimits, buildLimits, filesDigest } from "../src";
import { command } from "../src/core";

test("Unix API checks peer UID and bearer and carries bidirectional RPC", async () => {
  // Use a controlled short public path. The inherited test TMPDIR can already
  // be nested; this keeps the public path valid while the former UUID child
  // still exceeds Linux's AF_UNIX byte limit.
  const temporaryRoot = await mkdtemp("/tmp/ez-runner-nested-");
  const nestedDirectory = await mkdtemp(join(temporaryRoot, "tmp."));
  const directory = await mkdtemp(join(nestedDirectory, "ez-runner-socket-"));
  const socketPath = join(directory, "runner.sock");
  expect(Buffer.byteLength(join(directory, `.private-${"x".repeat(36)}`, "runner.sock"))).toBeGreaterThan(107);
  await command("python3", ["-c", "import socket,sys; connection=socket.socket(socket.AF_UNIX); connection.bind(sys.argv[1]); connection.close()", socketPath]);
  const token = "test-service-credential-32-bytes-minimum";
  let closed = false;
  const runner: Runner = {
    build: async input => ({ operationId: input.operationId, sourceDigest: input.sourceDigest, state: "failed", imageDigest: "test", diagnostics: [], evidence: { protocolVersion: 4, validatorVersion: "test", tests: [], discoveryDigest: "" } }),
    start: async (input, reverseRpc) => {
      const listeners = new Set<(method: string, params: unknown) => void>();
      const execution: RunnerExecution = { workerId: input.workerId, request: async (method, params) => { if (method === "notify") { for (const listener of listeners) listener("changed", params); return null; } return reverseRpc(method, params); }, close: async () => { closed = true; }, onNotification: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
      return execution;
    },
    cancel: async () => {},
    inspect: async id => ({ id, state: "running", diagnostics: [] }),
    collectArtifacts: async () => ({ "extension.js": "export {};" }),
  };
  const server = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
  try {
    const client = new RunnerClient({ socketPath, token });
    await expect(new RunnerClient({ socketPath, token: "wrong" }).inspect("worker")).rejects.toThrow("authentication");
    expect((await client.inspect("worker")).state).toBe("running");
    await expect(client.inspect("../invalid")).rejects.toThrow("identifier");
    expect(await client.collectArtifacts("a".repeat(64))).toEqual({ "extension.js": "export {};" });
    const files = { "extension.ts": "export {};" };
    expect((await client.build({ operationId: "build", files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits })).state).toBe("failed");
    const context = { workerId: "worker", invocationId: "invocation", releaseId: "release", principalId: "user", scopeId: "scope", token: "capability", deadline: Date.now() + 30_000 };
    const execution = await client.start({ workerId: "worker", artifactDigest: "a".repeat(64), context, limits: executionLimits }, async (method, params) => {
      if (method === "conflict") throw Object.assign(new Error("private SQL details"), { code: "STATE_CONFLICT" });
      if (method === "denied") throw new Error("private token");
      return { method, params };
    });
    await expect(execution.request("conflict", {})).rejects.toMatchObject({ code: "STATE_CONFLICT", message: "STATE_CONFLICT: State changed; reload before retrying." });
    await expect(execution.request("denied", {})).rejects.toThrow("Host capability denied or failed");
    expect(await execution.request("storage.get", { key: "hello" })).toEqual({ method: "storage.get", params: { key: "hello" } });
    const notification = new Promise(resolve => { const unsubscribe = execution.onNotification((method, params) => { unsubscribe(); resolve({ method, params }); }); });
    await execution.request("notify", { key: "updated" });
    expect(await notification).toEqual({ method: "changed", params: { key: "updated" } });
    await expect(new RunnerClient({ socketPath, token }).attach({ workerId: "worker", artifactDigest: "a".repeat(64), context, limits: executionLimits }, async () => null)).rejects.toThrow("already attached");
    await execution.close();
    expect(closed).toBe(true);
  } finally { await server.close(); await rm(temporaryRoot, { recursive: true, force: true }); }
}, 15_000);

test("wrong OS peer UID cannot reach the private runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ez-runner-peer-"));
  const token = "test-service-credential-32-bytes-minimum";
  const socketPath = join(directory, "runner.sock");
  const runner = { inspect: async () => { throw new Error("must never reach handler"); } } as unknown as Runner;
  const server = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() + 1 });
  try { await expect(new RunnerClient({ socketPath, token }).inspect("worker")).rejects.toThrow(); } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("failed gateway startup removes owner-only private and public sockets", async () => {
  const directory = await mkdtemp("/tmp/ez-runner-gateway-");
  const socketPath = join(directory, "runner.sock");
  const wrapperPath = join(directory, "failed-gateway.py");
  const observationPath = join(directory, "failed-gateway.result");
  await writeFile(wrapperPath, `#!/usr/bin/env python3
from pathlib import Path
import sys
private_path = Path(sys.argv[3])
status = private_path.parent.stat()
Path(__file__).with_suffix(".result").write_text(f"{private_path}\\n{status.st_uid}\\n{status.st_mode & 0o777:o}\\n")
sys.exit(1)
`);
  await chmod(wrapperPath, 0o700);
  try {
    await expect(startRunnerService({
      runner: { inspect: async () => ({}) } as unknown as Runner,
      socketPath,
      token: "test-service-credential-32-bytes-minimum",
      allowedUid: process.getuid!(),
      python: wrapperPath,
    })).rejects.toThrow("Unix peer gateway exited");
    const observed = (await readFile(observationPath, "utf8")).trim().split("\n");
    expect(observed).toHaveLength(3);
    const [privatePath, owner, mode] = observed as [string, string, string];
    expect(owner).toBe(String(process.getuid!()));
    expect(mode).toBe("700");
    await expect(lstat(privatePath)).rejects.toThrow();
    await expect(lstat(socketPath)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent services allocate separate private upstream sockets", async () => {
  const [firstDirectory, secondDirectory] = await Promise.all([
    mkdtemp(join(tmpdir(), "ez-runner-first-")),
    mkdtemp(join(tmpdir(), "ez-runner-second-")),
  ]);
  const token = "test-service-credential-32-bytes-minimum";
  const runner = { inspect: async (id: string) => ({ id, state: "running", diagnostics: [] }) } as unknown as Runner;
  const [first, second] = await Promise.all([
    startRunnerService({ runner, socketPath: join(firstDirectory, "runner.sock"), token, allowedUid: process.getuid!() }),
    startRunnerService({ runner, socketPath: join(secondDirectory, "runner.sock"), token, allowedUid: process.getuid!() }),
  ]);
  try {
    await expect(new RunnerClient({ socketPath: join(firstDirectory, "runner.sock"), token }).inspect("first")).resolves.toMatchObject({ id: "first" });
    await expect(new RunnerClient({ socketPath: join(secondDirectory, "runner.sock"), token }).inspect("second")).resolves.toMatchObject({ id: "second" });
  } finally {
    await Promise.all([first.close(), second.close()]);
    await Promise.all([rm(firstDirectory, { recursive: true, force: true }), rm(secondDirectory, { recursive: true, force: true })]);
  }
});

test("a rejected duplicate service preserves the active public socket", async () => {
  const directory = await mkdtemp("/tmp/ez-runner-active-");
  const socketPath = join(directory, "runner.sock");
  const token = "test-service-credential-32-bytes-minimum";
  const runner = { inspect: async (id: string) => ({ id, state: "running", diagnostics: [] }) } as unknown as Runner;
  const options = { runner, socketPath, token, allowedUid: process.getuid!() };
  const service = await startRunnerService(options);
  try {
    const before = await lstat(socketPath);
    await expect(startRunnerService(options)).rejects.toThrow("Unix peer gateway exited");
    expect((await lstat(socketPath)).ino).toBe(before.ino);
    await expect(new RunnerClient({ socketPath, token }).inspect("original")).resolves.toMatchObject({ id: "original" });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("capabilities: a runner advertises process-spawn enforcement, and a runner or service without it reads as not enforced", async () => {
  const directory = await mkdtemp("/tmp/ez-runner-caps-");
  const token = "test-service-credential-32-bytes-minimum";
  const base: Runner = {
    build: async () => { throw new Error("unused"); },
    start: async () => { throw new Error("unused"); },
    cancel: async () => {},
    inspect: async id => ({ id, state: "unknown", diagnostics: [] }),
    collectArtifacts: async () => ({}),
  };
  const ask = async (runner: Runner, name: string) => {
    const socketPath = join(directory, `${name}.sock`);
    const server = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
    try { return await new RunnerClient({ socketPath, token }).capabilities(); } finally { await server.close(); }
  };
  // A service from before /v4/capabilities answers unknown_method for it.
  const oldSocket = join(directory, "old.sock");
  const old = Bun.serve({ unix: oldSocket, fetch: () => Response.json({ error: { code: "unknown_method", message: "Unknown runner endpoint" } }, { status: 404 }) });
  try {
    expect(await ask({ ...base, capabilities: async () => ({ processSpawnEnforcement: true }) }, "enforcing")).toEqual({ processSpawnEnforcement: true });
    expect(await ask({ ...base, capabilities: async () => ({ processSpawnEnforcement: false }) }, "unguarded")).toEqual({ processSpawnEnforcement: false });
    expect(await ask(base, "legacy")).toEqual({ processSpawnEnforcement: false });
    expect(await new RunnerClient({ socketPath: oldSocket, token }).capabilities()).toEqual({ processSpawnEnforcement: false });
    await expect(new RunnerClient({ socketPath: join(directory, "absent.sock"), token }).capabilities()).rejects.toThrow();
  } finally { await old.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("an unclassified error answers 500 runner_internal_error with its class and code, is reported once, and is never retried", async () => {
  const temporaryRoot = await mkdtemp("/tmp/ez-runner-unclassified-");
  const socketPath = join(temporaryRoot, "runner.sock");
  const token = "test-service-credential-32-bytes-minimum";
  const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/store/artifacts/x'"), { code: "ENOENT" });
  let calls = 0;
  const runner = { inspect: async () => { calls += 1; throw missing; } } as unknown as Runner;
  const reported: unknown[] = [];
  const server = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!(), onUnclassifiedError: error => { reported.push(error); } });
  try {
    const raw = await fetch("http://runner/v4/inspect", { unix: socketPath, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "worker" }) });
    expect(raw.status).toBe(500);
    expect(await raw.json()).toEqual({ error: { code: "runner_internal_error", stage: "runner", message: "Runner failed with an internal error", retryable: false, errorClass: "Error", errorCode: "ENOENT" } });
    const error = await new RunnerClient({ socketPath, token }).inspect("worker").then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ code: "runner_internal_error", detail: { errorClass: "Error", errorCode: "ENOENT" } });
    expect(String((error as Error).message)).not.toContain("/store");
    expect(calls).toBe(2);
    expect(reported).toEqual([missing, missing]);
  } finally { await server.close(); await rm(temporaryRoot, { recursive: true, force: true }); }
});

test("a genuine validation refusal keeps HTTP 400 and its own text", async () => {
  const temporaryRoot = await mkdtemp("/tmp/ez-runner-validation-");
  const socketPath = join(temporaryRoot, "runner.sock");
  const token = "test-service-credential-32-bytes-minimum";
  const runner = { inspect: async () => ({ id: "w", state: "running", diagnostics: [] }) } as unknown as Runner;
  const server = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
  try {
    const raw = await fetch("http://runner/v4/inspect", { unix: socketPath, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "[]" });
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as { error: unknown }).error).toMatchObject({ code: "invalid_request" });
  } finally { await server.close(); await rm(temporaryRoot, { recursive: true, force: true }); }
});

test("by default an unclassified error goes to the runner's stderr as one JSON line with its class, code and bounded message", async () => {
  const temporaryRoot = await mkdtemp("/tmp/ez-runner-unclassified-");
  const socketPath = join(temporaryRoot, "runner.sock");
  const token = "test-service-credential-32-bytes-minimum";
  let thrown: unknown = Object.assign(new TypeError("x".repeat(600)), { code: "E_FIXTURE" });
  const runner = { inspect: async () => { throw thrown; } } as unknown as Runner;
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { lines.push(String(line)); };
  const server = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
  try {
    await expect(new RunnerClient({ socketPath, token }).inspect("worker")).rejects.toMatchObject({ code: "runner_internal_error", detail: { errorClass: "TypeError", errorCode: "E_FIXTURE" } });
    const line = JSON.parse(lines.at(-1)!);
    expect(line).toMatchObject({ level: "error", msg: "runner request failed with an unclassified error", errorClass: "TypeError", errorCode: "E_FIXTURE" });
    expect(line.message).toHaveLength(500);
    thrown = "not an error";
    await expect(new RunnerClient({ socketPath, token }).inspect("worker")).rejects.toMatchObject({ code: "runner_internal_error", detail: { errorClass: "string" } });
    expect(JSON.parse(lines.at(-1)!)).toEqual({ level: "error", msg: "runner request failed with an unclassified error", errorClass: "string", message: "not an error" });
  } finally { console.error = original; await server.close(); await rm(temporaryRoot, { recursive: true, force: true }); }
});

test("a 500 on a non-idempotent start reaches the runner exactly once: the client never retries it", async () => {
  const temporaryRoot = await mkdtemp("/tmp/ez-runner-start-once-");
  const socketPath = join(temporaryRoot, "runner.sock");
  const token = "test-service-credential-32-bytes-minimum";
  let starts = 0;
  const runner = { start: async () => { starts += 1; throw Object.assign(new Error("state file vanished"), { code: "ENOENT" }); } } as unknown as Runner;
  const server = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!(), onUnclassifiedError: () => {} });
  try {
    const context = { workerId: "worker", invocationId: "invocation", releaseId: "release", principalId: "user", scopeId: "scope", token: "capability", deadline: Date.now() + 30_000 };
    await expect(new RunnerClient({ socketPath, token }).start({ workerId: "worker", artifactDigest: "a".repeat(64), context, limits: executionLimits }, async () => null))
      .rejects.toMatchObject({ code: "runner_internal_error", detail: { errorClass: "Error", errorCode: "ENOENT" } });
    await Bun.sleep(200);
    expect(starts).toBe(1);
  } finally { await server.close(); await rm(temporaryRoot, { recursive: true, force: true }); }
});

test("restore: the client hands an artifact to the runner through the service, and a runner without restore answers unknown_method (W4H-32)", async () => {
  const directory = await mkdtemp("/tmp/ez-runner-restore-");
  const token = "test-service-credential-32-bytes-minimum";
  const files = { "extension.js": "export {};", ".runner/recipe.json": "{}" };
  const restored: unknown[] = [];
  const base: Runner = {
    build: async () => { throw new Error("unused"); },
    start: async () => { throw new Error("unused"); },
    cancel: async () => {},
    inspect: async id => ({ id, state: "unknown", diagnostics: [] }),
    collectArtifacts: async () => ({}),
  };
  const restore = async (runner: Runner, name: string) => {
    const socketPath = join(directory, `${name}.sock`);
    const server = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
    try { return await new RunnerClient({ socketPath, token }).restoreArtifact(filesDigest(files), files); } finally { await server.close(); }
  };
  try {
    expect(await restore({ ...base, restoreArtifact: async (digest, given) => { restored.push([digest, given]); } }, "restoring")).toBeUndefined();
    expect(restored).toEqual([[filesDigest(files), files]]);
    await expect(restore(base, "legacy")).rejects.toMatchObject({ code: "unknown_method" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
