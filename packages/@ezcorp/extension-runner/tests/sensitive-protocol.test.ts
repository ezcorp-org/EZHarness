import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { bindSensitiveRequestContext, FramedExecution, MAX_SENSITIVE_RESULT_BYTES, requestSensitiveProviderResult, SENSITIVE_PROVIDER_METHOD, type ReverseRpc } from "../src/protocol";

const children = new Set<ChildProcessWithoutNullStreams>();

function worker(program: string, maximumBytes = 64 * 1024, timeoutMs = 250, reverse: ReverseRpc = async () => null): FramedExecution {
  const child = spawn(process.execPath, ["-e", program], { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  child.once("close", () => children.delete(child));
  return new FramedExecution("sensitive-worker", child, reverse, async () => { child.kill("SIGKILL"); }, maximumBytes, timeoutMs);
}

afterEach(() => { for (const child of children) child.kill("SIGKILL"); children.clear(); });

test("sensitive provider responses use their classified envelope and ordinary methods stay unchanged", async () => {
  const secret = "provider-secret-canary";
  const execution = worker(`process.stdin.on("data", chunk => { for (const line of chunk.toString().trim().split("\\n")) { const request = JSON.parse(line); if (request.method === "ordinary") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })); else console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", encoding: "base64", data: Buffer.from(${JSON.stringify(secret)}).toString("base64") } })); } });`);
  try {
    expect(await execution.request("ordinary", {})).toEqual({ ok: true });
    const bytes = await requestSensitiveProviderResult(execution, { name: "OPENAI_API_KEY" });
    expect(bytes && new TextDecoder().decode(bytes)).toBe(secret);
    bytes?.fill(0);
    await expect(execution.request(SENSITIVE_PROVIDER_METHOD, {})).rejects.toThrow("credential broker");
  } finally { await execution.close(); }
});

test("missing provider credentials use an explicit bounded envelope", async () => {
  const execution = worker(`process.stdin.once("data", chunk => { const request = JSON.parse(chunk); console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", missing: true } })); });`);
  try { expect(await requestSensitiveProviderResult(execution, {})).toBeNull(); }
  finally { await execution.close(); }
});

test("sensitive notifications never reach ordinary listeners before or after the result", async () => {
  const canary = "sensitive-notification-canary";
  const execution = worker(`process.stdin.on("data", chunk => { const request = JSON.parse(chunk); const notification = { jsonrpc: "2.0", method: "provider/log", params: ${JSON.stringify(canary)} }; process.stdout.write([notification, { jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", encoding: "base64", data: Buffer.from(${JSON.stringify(canary)}).toString("base64") } }, notification].map(frame => JSON.stringify(frame) + "\\n").join("")); });`);
  const notifications: unknown[] = [];
  execution.onNotification((method, params) => { notifications.push({ method, params }); });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const bytes = await requestSensitiveProviderResult(execution, {});
      expect(bytes && new TextDecoder().decode(bytes)).toBe(canary);
      bytes?.fill(0);
    }
    expect(notifications).toEqual([]);
  } finally { await execution.close(); }
});

test("sensitive reverse RPC never reaches ordinary host callbacks", async () => {
  const calls: unknown[] = [];
  const execution = worker(`process.stdin.on("data", chunk => { for (const line of chunk.toString().trim().split("\\n")) { const request = JSON.parse(line); if (!request.sensitive) continue; const call = { jsonrpc: "2.0", id: "reverse-" + request.id, method: "ezcorp/api.request", params: { secret: "reverse-rpc-canary" } }; process.stdout.write([call, { jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", missing: true } }, { ...call, id: call.id + "-after" }].map(frame => JSON.stringify(frame) + "\\n").join("")); } });`, 64 * 1024, 1000, async (method, params) => { calls.push({ method, params }); return null; });
  try {
    expect(await requestSensitiveProviderResult(execution, {})).toBeNull();
    expect(await requestSensitiveProviderResult(execution, {})).toBeNull();
    expect(calls).toEqual([]);
  } finally { await execution.close(); }
});

test("ordinary requests cannot receive responses from a process that has handled secrets", async () => {
  const execution = worker(`process.stdin.on("data", chunk => { const request = JSON.parse(chunk); console.log(JSON.stringify(request.sensitive ? { jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", missing: true } } : { jsonrpc: "2.0", id: request.id, result: "post-secret-ordinary-canary" })); });`);
  try {
    expect(await requestSensitiveProviderResult(execution, {})).toBeNull();
    await expect(execution.request("ordinary", {})).rejects.toThrow("Sensitive provider");
  } finally { await execution.close(); }
});

test("sensitive classification waits for ordinary requests to finish", async () => {
  const execution = worker(`let held; process.stdin.on("data", chunk => { for (const line of chunk.toString().trim().split("\\n")) { const request = JSON.parse(line); if (request.method === "hold") { held = request.id; console.log(JSON.stringify({ jsonrpc: "2.0", method: "holding" })); } else if (request.method === "release") { console.log(JSON.stringify({ jsonrpc: "2.0", id: held, result: "complete" })); console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null })); } else console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", missing: true } })); } });`, 64 * 1024, 1000);
  const holding = new Promise<void>(resolve => { execution.onNotification(method => { if (method === "holding") resolve(); }); });
  const ordinary = execution.request("hold", {});
  try {
    await holding;
    const denied = await requestSensitiveProviderResult(execution, {}).catch(error => error);
    await execution.request("release", {});
    expect(await ordinary).toBe("complete");
    expect(denied).toMatchObject({ code: "sensitive_busy" });
    expect(await requestSensitiveProviderResult(execution, {})).toBeNull();
  } finally { await execution.close(); }
});

test("sensitive classification waits for an admitted reverse RPC to finish", async () => {
  let started!: () => void;
  const reverseStarted = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const reverseFinished = new Promise<void>(resolve => { finish = resolve; });
  const execution = worker(`process.stdin.on("data", chunk => { for (const line of chunk.toString().trim().split("\\n")) { const request = JSON.parse(line); if (request.method === "ordinary") { console.log(JSON.stringify({ jsonrpc: "2.0", id: "reverse", method: "host/read", params: {} })); console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null })); } else if (request.sensitive) console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", missing: true } })); else console.log(JSON.stringify({ jsonrpc: "2.0", method: "reverse-complete" })); } });`, 64 * 1024, 1000, async () => { started(); await reverseFinished; return null; });
  const replied = new Promise<void>(resolve => { execution.onNotification(method => { if (method === "reverse-complete") resolve(); }); });
  try {
    await execution.request("ordinary", {});
    await reverseStarted;
    await expect(requestSensitiveProviderResult(execution, {})).rejects.toMatchObject({ code: "sensitive_busy" });
    finish();
    await replied;
    expect(await requestSensitiveProviderResult(execution, {})).toBeNull();
  } finally { finish(); await execution.close(); }
});

test("sensitive requests receive fresh bounded provider invocation contexts", () => {
  const base = { invocationId: "base", workerId: "provider", releaseId: "release", principalId: "host", scopeId: "scope", token: "token", deadline: Date.now() + 60_000 };
  const prepare = bindSensitiveRequestContext(base, 1000);
  const first = prepare({ name: "OPENAI_API_KEY" }) as { context: typeof base; name: string };
  const second = prepare({ name: "GITHUB_TOKEN" }) as { context: typeof base; name: string };
  expect(first.name).toBe("OPENAI_API_KEY");
  expect(first.context).toMatchObject({ workerId: base.workerId, releaseId: base.releaseId, principalId: base.principalId, scopeId: base.scopeId, token: base.token });
  expect(first.context.invocationId).not.toBe(base.invocationId);
  expect(second.context.invocationId).not.toBe(first.context.invocationId);
  expect(first.context.deadline).toBeLessThanOrEqual(base.deadline);
  expect(() => prepare(null)).toThrow("object");
});

test("malformed and oversized sensitive frames fail closed without returning canaries", async () => {
  const canary = "malformed-provider-canary";
  const oversized = Buffer.alloc(MAX_SENSITIVE_RESULT_BYTES + 1, 65).toString("base64");
  const programs = [
    `process.stdin.once("data", () => process.stdout.write(${JSON.stringify(`${canary} not-json\n`)}));`,
    `process.stdin.once("data", chunk => { const request = JSON.parse(chunk); console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: ${JSON.stringify(canary)} })); });`,
    `process.stdin.once("data", chunk => { const request = JSON.parse(chunk); console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: ${JSON.stringify(canary)} } })); });`,
    `process.stdin.once("data", chunk => { const request = JSON.parse(chunk); console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", encoding: "base64", data: ${JSON.stringify(oversized)} } })); });`,
  ];
  for (const program of programs) {
    const execution = worker(program, 128 * 1024);
    const error = await requestSensitiveProviderResult(execution, {}).catch(reason => reason);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
    await execution.close();
  }
});

test("timeout, crash, stdout, and stderr failures never include provider bytes", async () => {
  const canary = "process-output-provider-canary";
  const programs = [
    `process.stdin.once("data", () => { process.stderr.write(${JSON.stringify(canary)}); setInterval(() => {}, 1000); });`,
    `process.stdin.once("data", () => { process.stderr.write(${JSON.stringify(canary)}); process.exit(7); });`,
    `process.stdin.once("data", () => { process.stdout.write(${JSON.stringify(`${canary}\n`)}); process.stderr.write(${JSON.stringify(canary)}); });`,
  ];
  for (const program of programs) {
    const execution = worker(program, 64 * 1024, 50);
    const error = await requestSensitiveProviderResult(execution, {}).catch(reason => reason);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
    await execution.close();
  }
});

test("sensitive timeouts wipe partial control and log buffers", async () => {
  const canary = "partial-frame-provider-canary";
  const child = spawn(process.execPath, ["-e", `process.stdin.once("data", () => { process.stdout.write(${JSON.stringify(canary)}); process.stderr.write(${JSON.stringify(canary)}); setInterval(() => {}, 1000); });`], { stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  child.once("close", () => children.delete(child));
  const retained: Buffer[] = [];
  child.stdout.on("data", chunk => retained.push(chunk));
  child.stderr.on("data", chunk => retained.push(chunk));
  const execution = new FramedExecution("sensitive-worker", child, async () => null, async () => { child.kill("SIGKILL"); }, 64 * 1024, 50);

  const error = await requestSensitiveProviderResult(execution, {}).catch(reason => reason);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(canary);
  expect(retained.length).toBe(2);
  expect(retained.every(chunk => chunk.every(byte => byte === 0))).toBe(true);
  expect((execution as unknown as { buffer: Buffer }).buffer.byteLength).toBe(0);
  await execution.close();
});

test("a provider process stays permanently redacted after a successful secret result", async () => {
  const canary = "post-response-stderr-canary";
  const execution = worker(`let calls = 0; process.stdin.on("data", chunk => { const request = JSON.parse(chunk); if (++calls === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, sensitive: { kind: "provider-credential", encoding: "base64", data: Buffer.from("first-secret").toString("base64") } })); else { process.stderr.write(${JSON.stringify(canary)}); process.exit(9); } });`);
  const bytes = await requestSensitiveProviderResult(execution, {});
  bytes?.fill(0);
  const error = await requestSensitiveProviderResult(execution, {}).catch(reason => reason);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(canary);
  expect(JSON.stringify(error)).not.toContain(canary);
  await execution.close();
});

test("unclassified executions and ordinary calls cannot enter the sensitive lane", async () => {
  const ordinary = { workerId: "worker", request: async () => "must-not-run", close: async () => {}, onNotification: () => () => {} };
  await expect(requestSensitiveProviderResult(ordinary, {})).rejects.toThrow("unavailable");
});
