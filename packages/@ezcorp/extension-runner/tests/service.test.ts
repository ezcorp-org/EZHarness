import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { startRunnerService } from "../src/service";
import { RunnerClient, executionLimits, buildLimits, filesDigest } from "../src";
import { command } from "../src/core";

test("Unix API checks peer UID and bearer and carries bidirectional RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ez-runner-socket-"));
  const socketPath = join(directory, "runner.sock");
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
    const execution = await client.start({ workerId: "worker", artifactDigest: "a".repeat(64), context, limits: executionLimits }, async (method, params) => ({ method, params }));
    expect(await execution.request("storage.get", { key: "hello" })).toEqual({ method: "storage.get", params: { key: "hello" } });
    const notification = new Promise(resolve => { const unsubscribe = execution.onNotification((method, params) => { unsubscribe(); resolve({ method, params }); }); });
    await execution.request("notify", { key: "updated" });
    expect(await notification).toEqual({ method: "changed", params: { key: "updated" } });
    await execution.close();
    expect(closed).toBe(true);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
}, 15_000);

test("wrong OS peer UID cannot reach the private runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ez-runner-peer-"));
  const token = "test-service-credential-32-bytes-minimum";
  const socketPath = join(directory, "runner.sock");
  const runner = { inspect: async () => { throw new Error("must never reach handler"); } } as unknown as Runner;
  const server = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() + 1 });
  try { await expect(new RunnerClient({ socketPath, token }).inspect("worker")).rejects.toThrow(); } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
