import { expect, test } from "bun:test";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Runner } from "@ezcorp/extension-contract";
import { RunnerClient } from "../src/client";
import { executionLimits, RunnerError } from "../src/core";
import { FramedExecution, requestSensitiveProviderResult, SENSITIVE_PROVIDER_METHOD, SensitiveRunnerExecution, type ReverseRpc } from "../src/protocol";
import { startRunnerService } from "../src/service";

function rawRunnerCall(socketPath: string, path: string, authorization: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, path, method: "POST", headers: { authorization, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on("data", chunk => chunks.push(chunk));
      incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

const unexpectedRunnerMethod = async (): Promise<never> => { throw new Error("Fixture attempted an unrelated runner method"); };
const unusedRunnerMethods: Pick<Runner, "build" | "inspect" | "collectArtifacts"> = {
  build: unexpectedRunnerMethod, inspect: unexpectedRunnerMethod, collectArtifacts: unexpectedRunnerMethod,
};

async function readyExecution(child: ChildProcess, execution: FramedExecution, signal: AbortSignal): Promise<FramedExecution> {
  const waiting = new AbortController();
  try {
    const [message] = await Promise.race([
      once(child, "message", { signal: AbortSignal.any([signal, waiting.signal]) }),
      execution.exited.then(() => { throw new Error("Provider fixture exited before readiness"); }),
    ]);
    if (message !== "ready") throw new Error("Invalid provider fixture readiness");
    return execution;
  } catch (error) {
    await execution.close();
    await execution.exited;
    throw error;
  } finally { waiting.abort(); }
}

function spawnProvider(program: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["-e", program], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill("SIGKILL");
    throw new Error("Provider fixture requires piped standard streams");
  }
  return child as ChildProcessWithoutNullStreams;
}

function startupFixture(program: string, timeoutMs = 1000) {
  const child = spawnProvider(program);
  const execution = new FramedExecution("startup-provider", child, async () => null,
    async () => { child.kill("SIGKILL"); }, 64 * 1024, timeoutMs);
  return { child, execution };
}

test("provider startup failures are redacted and close their fresh child", async () => {
  const canary = "startup-failure-secret-canary";
  for (const fixture of [
    { program: `process.stderr.write(${JSON.stringify(canary)}); process.exit(1);`, reason: "exited before readiness" },
    { program: `process.send(${JSON.stringify(canary)}); process.stdin.resume();`, reason: "Invalid provider fixture readiness" },
  ]) {
    const { child, execution } = startupFixture(fixture.program);
    try {
      const startup = readyExecution(child, execution, new AbortController().signal);
      await expect(startup).rejects.toThrow(fixture.reason);
      await expect(startup).rejects.not.toThrow(canary);
      await expect(execution.exited).resolves.toBeDefined();
    } finally { await execution.close(); await execution.exited; }
  }
});

test("aborting provider startup terminates the child before any request", async () => {
  const { child, execution } = startupFixture('process.stdin.resume(); process.stderr.write("startup-held");');
  const controller = new AbortController();
  try {
    const startup = readyExecution(child, execution, controller.signal);
    await once(child.stderr, "data");
    controller.abort();
    await expect(startup).rejects.toMatchObject({ name: "AbortError" });
    await expect(execution.exited).resolves.toBeDefined();
    expect(child.killed).toBe(true);
  } finally { await execution.close(); await execution.exited; }
});

test("a ready provider still enforces the sensitive request deadline", async () => {
  const { child, execution } = startupFixture('process.stdin.on("data", () => {}); process.send("ready");', 20);
  try {
    await readyExecution(child, execution, new AbortController().signal);
    await expect(requestSensitiveProviderResult(execution, {})).rejects.toMatchObject({
      code: "sensitive_failed", message: "Sensitive provider request failed",
    });
    await expect(execution.exited).resolves.toBeDefined();
    expect(child.killed).toBe(true);
  } finally { await execution.close(); await execution.exited; }
});

test("the remote service keeps sensitive bytes off ordinary JSON responses", async () => {
  const directory = await mkdtemp("/tmp/ez-sensitive-service-");
  const socketPath = join(directory, "runner.sock");
  const token = "sensitive-service-credential-32-bytes";
  const canary = "remote-sensitive-provider-canary";
  const sdk = new URL("../../sdk/src/v4/index.ts", import.meta.url).pathname;
  const runner: Runner = { ...unusedRunnerMethods,
    start: async input => {
      // SDK import/initialization is startup, not a provider request. Each fresh
      // child signals readiness on IPC after serve has attached its input loop.
      const child = spawnProvider(`import { defineExtension, serve } from ${JSON.stringify(sdk)}; const running = serve(defineExtension({ manifest: { schemaVersion: 4, name: "provider", version: "1.0.0", description: "Provider", author: { name: "Test" }, permissions: {} }, providerCredentials: () => ${JSON.stringify(canary)} })); process.send("ready"); await running;`);
      const execution = new FramedExecution(input.workerId, child, async () => null, async () => { child.kill("SIGKILL"); }, 64 * 1024, 1000, undefined, params => ({ ...(params as Record<string, unknown>), context: { ...input.context, invocationId: "provider-credential", deadline: Date.now() + 5000 } }));
      return readyExecution(child, execution, AbortSignal.timeout(Math.max(1, input.context.deadline - Date.now())));
    },
    cancel: async () => {},
  };
  const service = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
  try {
    const context = { workerId: "provider", invocationId: "invocation", releaseId: "release", principalId: "host", scopeId: "scope", token: "capability", deadline: Date.now() + 30_000 };
    const execution = await new RunnerClient({ socketPath, token }).start({ workerId: "provider", artifactDigest: "a".repeat(64), context, limits: executionLimits }, async () => null);
    const unauthorized = await rawRunnerCall(socketPath, "/v4/sensitive-request", "Bearer wrong", JSON.stringify({ workerId: "provider", params: {} }));
    expect(unauthorized).not.toContain(canary);
    expect(unauthorized).toContain("authentication failed");
    await expect(execution.request(SENSITIVE_PROVIDER_METHOD, {})).rejects.toThrow("credential broker");
    const ordinary = await rawRunnerCall(socketPath, "/v4/request", `Bearer ${token}`, JSON.stringify({ workerId: "provider", method: SENSITIVE_PROVIDER_METHOD, params: {} }));
    expect(ordinary).toContain("credential broker");
    expect(ordinary).not.toContain(canary);
    const bytes = await requestSensitiveProviderResult(execution, { providerId: "infisical", connectionId: "connection-a", name: "OPENAI_API_KEY", scope: { extensionId: "consumer", userId: "user-a", conversationId: "conversation-a" } });
    expect(bytes && new TextDecoder().decode(bytes)).toBe(canary);
    bytes?.fill(0);
    await execution.close();
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("the sensitive service route redacts runner errors", async () => {
  const directory = await mkdtemp("/tmp/ez-sensitive-service-error-");
  const socketPath = join(directory, "runner.sock");
  const token = "sensitive-service-error-credential";
  const canary = "service-runner-error-canary";
  class ThrowingExecution extends SensitiveRunnerExecution {
    readonly workerId = "provider-error";
    request(): Promise<unknown> { return Promise.resolve(null); }
    close(): Promise<void> { return Promise.resolve(); }
    onNotification(): () => void { return () => {}; }
    requestSensitiveProviderResult(): Promise<Uint8Array | null> { return Promise.reject(new RunnerError("provider_failed", canary)); }
  }
  const runner: Runner = { ...unusedRunnerMethods, start: async () => new ThrowingExecution(), cancel: async () => {} };
  const service = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
  try {
    const context = { workerId: "provider-error", invocationId: "invocation", releaseId: "release", principalId: "host", scopeId: "scope", token: "capability", deadline: Date.now() + 30_000 };
    const execution = await new RunnerClient({ socketPath, token }).start({ workerId: "provider-error", artifactDigest: "a".repeat(64), context, limits: executionLimits }, async () => null);
    try {
      const error = await requestSensitiveProviderResult(execution, {}).catch(reason => reason);
      expect(error).toMatchObject({ code: "sensitive_failed", message: "Sensitive provider request failed" });
      expect(String(error)).not.toContain(canary);
      const response = await rawRunnerCall(socketPath, "/v4/sensitive-request", `Bearer ${token}`, JSON.stringify({ workerId: "provider-error", params: {} }));
      expect(response).toContain("Sensitive provider request failed");
      expect(response).not.toContain(canary);
    } finally { await execution.close(); }
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sensitive worker notifications cannot escape through the Unix service event route", async () => {
  const directory = await mkdtemp("/tmp/ez-sensitive-events-");
  const socketPath = join(directory, "runner.sock");
  const token = "sensitive-event-service-credential-32-bytes";
  const canary = "service-notification-secret-canary";
  const runner: Runner = { ...unusedRunnerMethods,
    start: async (input, reverse) => {
      const child = spawn(process.execPath, ["-e", `process.stdin.on("data", chunk => { const request = JSON.parse(chunk); const notification = { jsonrpc: "2.0", method: "provider/log", params: ${JSON.stringify(canary)} }; process.stdout.write([notification, { jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", encoding: "base64", data: Buffer.from(${JSON.stringify(canary)}).toString("base64") } }, notification].map(frame => JSON.stringify(frame) + "\\n").join("")); });`], { stdio: ["pipe", "pipe", "pipe"] });
      return new FramedExecution(input.workerId, child, reverse, async () => { child.kill("SIGKILL"); }, 64 * 1024, 1000);
    },
    cancel: async () => {},
  };
  const service = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
  const call = (path: string, params = {}) => rawRunnerCall(socketPath, path, `Bearer ${token}`, JSON.stringify({ workerId: "provider", ...params }));
  try {
    const context = { workerId: "provider", invocationId: "invocation", releaseId: "release", principalId: "host", scopeId: "scope", token: "capability", deadline: Date.now() + 30_000 };
    await call("/v4/start", { artifactDigest: "a".repeat(64), context, limits: executionLimits });
    expect(await call("/v4/sensitive-request", { params: {} })).toBe(canary);
    const eventsResponse = call("/v4/events");
    const ordinary = await call("/v4/request", { method: "ordinary", params: {} });
    expect(ordinary).not.toContain(canary);
    expect(ordinary).toContain("Sensitive provider");
    await call("/v4/cancel", { id: "provider" });
    const events = await eventsResponse;
    expect(events).not.toContain(canary);
    expect(JSON.parse(events)).toEqual({ events: [] });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("the service independently fences ordinary events, reverse RPC, and concurrent requests", async () => {
  const directory = await mkdtemp("/tmp/ez-sensitive-fence-");
  const socketPath = join(directory, "runner.sock");
  const token = "sensitive-service-fence-credential-32-bytes";
  const canary = "injected-runner-sensitive-canary";
  let reverse!: ReverseRpc;
  let ordinaryStarted!: () => void;
  const started = new Promise<void>(resolve => { ordinaryStarted = resolve; });
  let finishOrdinary!: () => void;
  const finish = new Promise<void>(resolve => { finishOrdinary = resolve; });
  class ProviderExecution extends SensitiveRunnerExecution {
    readonly workerId = "provider";
    readonly sensitiveBytes = new TextEncoder().encode(canary);
    listener?: (method: string, params: unknown) => void;
    async request(): Promise<unknown> { ordinaryStarted(); await finish; return "ordinary-complete"; }
    async close(): Promise<void> {}
    onNotification(listener: (method: string, params: unknown) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
    async requestSensitiveProviderResult(): Promise<Uint8Array | null> {
      this.listener?.("provider/log", canary);
      await expect(reverse("ezcorp/api.request", { secret: canary })).rejects.toMatchObject({ code: "sensitive_method" });
      return this.sensitiveBytes;
    }
  }
  const execution = new ProviderExecution();
  const runner: Runner = { ...unusedRunnerMethods, start: async (_input, callback) => { reverse = callback; return execution; }, cancel: async () => {} };
  const service = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
  const call = (path: string, params = {}) => rawRunnerCall(socketPath, path, `Bearer ${token}`, JSON.stringify({ workerId: "provider", ...params }));
  try {
    const context = { workerId: "provider", invocationId: "invocation", releaseId: "release", principalId: "host", scopeId: "scope", token: "capability", deadline: Date.now() + 30_000 };
    await call("/v4/start", { artifactDigest: "a".repeat(64), context, limits: executionLimits });
    const ordinary = call("/v4/request", { method: "ordinary", params: {} });
    await started;
    expect(await call("/v4/sensitive-request", { params: {} })).toContain("sensitive_busy");
    finishOrdinary();
    expect(JSON.parse(await ordinary)).toEqual({ result: "ordinary-complete" });

    const reverseCall = reverse("host/read", {});
    expect(await call("/v4/sensitive-request", { params: {} })).toContain("sensitive_busy");
    const { events: [event] } = JSON.parse(await call("/v4/events"));
    await call("/v4/reply", { id: event.id, result: "host-complete" });
    expect(await reverseCall).toBe("host-complete");

    execution.listener?.("provider/log", "queued-before-classification");
    expect(await call("/v4/sensitive-request", { params: {} })).toBe(canary);
    expect(execution.sensitiveBytes).toEqual(new Uint8Array(execution.sensitiveBytes.byteLength));
    execution.listener?.("provider/log", canary);
    await expect(reverse("ezcorp/api.request", { secret: canary })).rejects.toMatchObject({ code: "sensitive_method" });
    expect(await call("/v4/request", { method: "ordinary", params: {} })).toContain("Sensitive provider");
    const eventsResponse = call("/v4/events");
    await call("/v4/reply", { id: event.id, result: canary });
    await call("/v4/cancel", { id: "provider" });
    expect(JSON.parse(await eventsResponse)).toEqual({ events: [] });
  } finally {
    finishOrdinary();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
