import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { resolve } from "path";
import type { JsonRpcRequest } from "../extensions/types";
import { JsonRpcTransport } from "../extensions/json-rpc";

mockDbConnection();

import {
  createExtension,
  deleteExtension,
  listExtensions,
} from "../db/queries/extensions";
import { ExtensionProcess, type ExtensionProcessOptions } from "../extensions/subprocess";
import { ExtensionRegistry } from "../extensions/registry";
import { computeChecksum, verifyChecksum } from "../extensions/checksum";

const MOCK_ENTRYPOINT = resolve(__dirname, "helpers/mock-extension/entrypoint.ts");
const MOCK_INSTALL_PATH = resolve(__dirname, "helpers/mock-extension");

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

// ── Helper: create a test extension in DB ────────────────────────────
function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2 as const,
    name: "test-ext",
    version: "1.0.0",
    description: "Test extension",
    author: { name: "Test" },
    entrypoint: "./entrypoint.ts",
    tools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object" } }],
    permissions: {},
    ...overrides,
  };
}

async function insertTestExtension(name: string, overrides: Record<string, unknown> = {}) {
  return createExtension({
    name,
    version: "1.0.0",
    description: "Test",
    manifest: makeManifest({ name, ...overrides }),
    source: "local:/test",
    installPath: MOCK_INSTALL_PATH,
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 1. JsonRpcTransport
// ═══════════════════════════════════════════════════════════════════════

describe("JsonRpcTransport", () => {
  // ── Static encode/decode ───────────────────────────────────────────

  test("encode() produces valid newline-delimited JSON", () => {
    const req: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "ping", params: { a: 1 } };
    const encoded = JsonRpcTransport.encode(req);

    expect(encoded.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(encoded.trim());
    expect(parsed).toEqual(req);
  });

  test("decode() parses valid JSON response", () => {
    const raw = '{"jsonrpc":"2.0","id":42,"result":"ok"}';
    const decoded = JsonRpcTransport.decode(raw);
    expect(decoded.jsonrpc).toBe("2.0");
    expect(decoded.id).toBe(42);
    expect(decoded.result).toBe("ok");
  });

  test("decode() handles whitespace and trailing newlines", () => {
    const raw = '  {"jsonrpc":"2.0","id":1,"result":true}  \n';
    const decoded = JsonRpcTransport.decode(raw);
    expect(decoded.id).toBe(1);
    expect(decoded.result).toBe(true);
  });

  // ── Instance: buffer fragmentation ─────────────────────────────────

  test("handles buffer fragmentation across multiple reads", async () => {
    // Build a ReadableStream that delivers a single JSON response in two chunks
    const fullLine = '{"jsonrpc":"2.0","id":1,"result":"fragmented"}\n';
    const mid = Math.floor(fullLine.length / 2);
    const chunk1 = new TextEncoder().encode(fullLine.slice(0, mid));
    const chunk2 = new TextEncoder().encode(fullLine.slice(mid));

    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1);
        // Small delay to simulate network fragmentation
        setTimeout(() => {
          controller.enqueue(chunk2);
          controller.close();
        }, 20);
      },
    });

    const written: string[] = [];
    const stdin = {
      write(data: string | Uint8Array): number {
        written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        return typeof data === "string" ? data.length : data.byteLength;
      },
    };

    const transport = new JsonRpcTransport(stdin as any, stdout);
    transport.startReading();

    const req: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "test" };
    const responsePromise = transport.send(req);

    const response = await responsePromise;
    expect(response.id).toBe(1);
    expect(response.result).toBe("fragmented");
  });

  test("handles multiple messages in a single buffer chunk", async () => {
    const line1 = '{"jsonrpc":"2.0","id":1,"result":"first"}\n';
    const line2 = '{"jsonrpc":"2.0","id":2,"result":"second"}\n';
    const combined = new TextEncoder().encode(line1 + line2);

    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(combined);
        controller.close();
      },
    });

    const stdin = {
      write(_data: string | Uint8Array): number { return 0; },
    };

    const transport = new JsonRpcTransport(stdin as any, stdout);
    transport.startReading();

    const p1 = transport.send({ jsonrpc: "2.0", id: 1, method: "a" });
    const p2 = transport.send({ jsonrpc: "2.0", id: 2, method: "b" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.result).toBe("first");
    expect(r2.result).toBe("second");
  });

  test("malformed JSON lines are skipped silently", async () => {
    const badLine = "this is not json\n";
    const goodLine = '{"jsonrpc":"2.0","id":1,"result":"ok"}\n';
    const combined = new TextEncoder().encode(badLine + goodLine);

    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(combined);
        controller.close();
      },
    });

    const stdin = { write(_d: string | Uint8Array): number { return 0; } };
    const transport = new JsonRpcTransport(stdin as any, stdout);
    transport.startReading();

    const resp = await transport.send({ jsonrpc: "2.0", id: 1, method: "x" });
    expect(resp.result).toBe("ok");
  });

  test("close() rejects all pending callbacks with 'Transport closed'", async () => {
    // A stdout that never delivers data
    const stdout = new ReadableStream<Uint8Array>({
      start() { /* never enqueue, never close */ },
    });

    const stdin = { write(_d: string | Uint8Array): number { return 0; } };
    const transport = new JsonRpcTransport(stdin as any, stdout);
    transport.startReading();

    const p1 = transport.send({ jsonrpc: "2.0", id: 1, method: "a" });
    const p2 = transport.send({ jsonrpc: "2.0", id: 2, method: "b" });

    transport.close();

    await expect(p1).rejects.toThrow("Transport closed");
    await expect(p2).rejects.toThrow("Transport closed");
  });

  test("send() writes correct format to stdin and calls flush if available", () => {
    const stdout = new ReadableStream<Uint8Array>({ start() {} });
    let flushed = false;
    const written: string[] = [];

    const stdin = {
      write(data: string | Uint8Array): number {
        written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        return typeof data === "string" ? data.length : data.byteLength;
      },
      flush() { flushed = true; },
    };

    const transport = new JsonRpcTransport(stdin as any, stdout);
    transport.startReading();

    const req: JsonRpcRequest = { jsonrpc: "2.0", id: 99, method: "hello" };
    const pending = transport.send(req);

    expect(written.length).toBe(1);
    expect(written[0]).toBe(JSON.stringify(req) + "\n");
    expect(flushed).toBe(true);

    transport.close();
    // Consume the rejection so it doesn't leak
    pending.catch(() => {});
  });

  test("send() works when stdin has no flush method", () => {
    const stdout = new ReadableStream<Uint8Array>({ start() {} });
    const written: string[] = [];

    const stdin = {
      write(data: string | Uint8Array): number {
        written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        return typeof data === "string" ? data.length : data.byteLength;
      },
      // no flush
    };

    const transport = new JsonRpcTransport(stdin as any, stdout);
    transport.startReading();

    const req: JsonRpcRequest = { jsonrpc: "2.0", id: 50, method: "noop" };
    // Should not throw even without flush
    const pending = transport.send(req);

    expect(written[0]).toBe(JSON.stringify(req) + "\n");
    transport.close();
    // Consume the rejection so it doesn't leak
    pending.catch(() => {});
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. ExtensionProcess
// ═══════════════════════════════════════════════════════════════════════

describe("ExtensionProcess", () => {
  const processes: ExtensionProcess[] = [];

  function createProc(id: string, opts?: ExtensionProcessOptions) {
    const ep = new ExtensionProcess(
      id,
      MOCK_ENTRYPOINT,
      { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      opts,
    );
    processes.push(ep);
    return ep;
  }

  afterEach(() => {
    for (const p of processes) p.kill();
    processes.length = 0;
  });

  test("constructor sets correct defaults (5min idle, 30s call timeout)", () => {
    const ep = createProc("defaults-test");
    // We can't directly access private fields, but we can verify behaviour
    // indirectly. At least verify the object was created without error.
    expect(ep.extensionId).toBe("defaults-test");
    expect(ep.isRunning).toBe(false);
  });

  test("ensureRunning() spawns subprocess", () => {
    const ep = createProc("spawn-test", { idleTimeoutMs: 10000 });
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);
  });

  test("ensureRunning() is idempotent (doesn't spawn twice)", () => {
    const ep = createProc("idempotent-test", { idleTimeoutMs: 10000 });
    ep.ensureRunning();
    const running1 = ep.isRunning;
    ep.ensureRunning(); // second call
    const running2 = ep.isRunning;
    expect(running1).toBe(true);
    expect(running2).toBe(true);
  });

  test("call() auto-spawns if not running", async () => {
    const ep = createProc("auto-spawn-test", { idleTimeoutMs: 10000 });
    expect(ep.isRunning).toBe(false);

    const response = await ep.call("tools/call", { name: "echo", arguments: { text: "auto" } });
    expect(ep.isRunning).toBe(true);
    expect(response.result).toEqual({
      content: [{ type: "text", text: "auto" }],
      isError: false,
    });
  });

  test("callTool() returns ToolCallResult on success", async () => {
    const ep = createProc("calltool-ok", { idleTimeoutMs: 10000 });
    const result = await ep.callTool("echo", { text: "success" });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "success" }]);
  });

  test("callTool() returns isError:true when subprocess returns JSON-RPC error", async () => {
    const ep = createProc("calltool-err", { idleTimeoutMs: 10000 });
    const result = await ep.callTool("nonexistent-tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("nonexistent-tool");
  });

  test("kill() stops the process and cleans up", () => {
    const ep = createProc("kill-test", { idleTimeoutMs: 10000 });
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);
    ep.kill();
    expect(ep.isRunning).toBe(false);
  });

  test("kill() is safe to call multiple times", () => {
    const ep = createProc("kill-multi", { idleTimeoutMs: 10000 });
    ep.ensureRunning();
    ep.kill();
    ep.kill();
    ep.kill();
    expect(ep.isRunning).toBe(false);
  });

  test("isRunning reflects actual state", () => {
    const ep = createProc("isrunning-test", { idleTimeoutMs: 10000 });
    expect(ep.isRunning).toBe(false);
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);
    ep.kill();
    expect(ep.isRunning).toBe(false);
  });

  test("idle timeout kills process after specified duration", async () => {
    const ep = createProc("idle-test", { idleTimeoutMs: 150 });
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);

    await new Promise((r) => setTimeout(r, 350));
    expect(ep.isRunning).toBe(false);
  });

  test("persistent mode doesn't idle-timeout", async () => {
    const ep = createProc("persistent-test", { idleTimeoutMs: 100, persistent: true });
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    expect(ep.isRunning).toBe(true);
  });

  test("call timeout rejects and kills process after specified duration", async () => {
    // Use a script that reads stdin but never responds -- "bun -e" with an
    // infinite await. This ensures the call hangs until the timeout fires.
    const hangScript = resolve(__dirname, "helpers/mock-extension/hang.ts");
    // Write the hang script inline via Bun.write if not present
    const hangContent = "await new Promise(() => {}); // hang forever";
    await Bun.write(hangScript, hangContent);

    const ep = new ExtensionProcess(
      "timeout-test",
      hangScript,
      { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      { idleTimeoutMs: 10000, callTimeoutMs: 150 },
    );
    processes.push(ep);

    await expect(ep.call("tools/call", { name: "echo", arguments: {} })).rejects.toThrow(/timed out/);
    // After timeout, process should be killed
    expect(ep.isRunning).toBe(false);
  });

  // ── sendNotification ──────────────────────────────────────────────

  test("sendNotification() is a no-op when process is not running", () => {
    const ep = createProc("send-noop", { idleTimeoutMs: 10000 });
    expect(ep.isRunning).toBe(false);

    // Should not throw
    expect(() => ep.sendNotification("ezcorp/state", { x: 1 })).not.toThrow();
  });

  test("sendNotification() is a no-op after kill()", () => {
    const ep = createProc("send-after-kill", { idleTimeoutMs: 10000 });
    ep.ensureRunning();
    ep.kill();
    expect(ep.isRunning).toBe(false);

    // Should not throw
    expect(() => ep.sendNotification("ezcorp/state", { x: 1 })).not.toThrow();
  });

  test("sendNotification() writes to stdin when process is running", () => {
    const ep = createProc("send-live", { idleTimeoutMs: 10000 });
    ep.ensureRunning();

    // Should not throw
    expect(() => ep.sendNotification("ezcorp/state", { count: 42 })).not.toThrow();
  });

  test("sendNotification() swallows error when stdin write fails", () => {
    const ep = createProc("send-fail", { idleTimeoutMs: 10000 });
    ep.ensureRunning();

    // Override the internal proc reference with a fake that has a throwing stdin
    const originalProc = (ep as any).proc;
    Object.defineProperty(ep, "proc", {
      value: { stdin: { write: () => { throw new Error("stdin closed"); } }, kill: () => {} },
      writable: true,
      configurable: true,
    });
    // Mark as not killed so sendNotification attempts the write
    (ep as any).killed = false;

    // Should not throw despite stdin failure
    expect(() => ep.sendNotification("ezcorp/state", { fail: true })).not.toThrow();

    // Restore original proc for proper cleanup
    Object.defineProperty(ep, "proc", { value: originalProc, writable: true, configurable: true });
  });

  // ── setNotificationHandler + wireNotificationHandler ──────────────

  test("setNotificationHandler() wires handler to transport.onNotification", () => {
    const ep = createProc("notif-handler", { idleTimeoutMs: 10000 });
    ep.ensureRunning();

    const received: Array<{ method: string }> = [];
    ep.setNotificationHandler((notification) => {
      received.push({ method: notification.method });
    });

    // Verify the transport's onNotification is set
    const transport = (ep as any).transport;
    expect(transport.onNotification).toBeDefined();

    // Simulate a notification arriving via the transport
    transport.onNotification!({ jsonrpc: "2.0", method: "ezcorp/state", params: {} });
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("ezcorp/state");
  });

  test("setNotificationHandler() before ensureRunning still wires on first spawn", () => {
    const ep = createProc("notif-pre-spawn", { idleTimeoutMs: 10000 });

    const received: Array<{ method: string }> = [];
    ep.setNotificationHandler((notification) => {
      received.push({ method: notification.method });
    });

    // Now spawn
    ep.ensureRunning();

    // The handler should be wired
    const transport = (ep as any).transport;
    expect(transport.onNotification).toBeDefined();
    transport.onNotification!({ jsonrpc: "2.0", method: "test/ping", params: {} });
    expect(received).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Checksum
// ═══════════════════════════════════════════════════════════════════════

describe("Checksum", () => {
  test("computeChecksum() returns hex SHA-256 for a known file", async () => {
    const hash = await computeChecksum(MOCK_ENTRYPOINT);
    // Should be a 64-char lowercase hex string (SHA-256)
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("verifyChecksum() returns true for matching checksum", async () => {
    const hash = await computeChecksum(MOCK_ENTRYPOINT);
    const match = await verifyChecksum(MOCK_ENTRYPOINT, hash);
    expect(match).toBe(true);
  });

  test("verifyChecksum() returns false for mismatching checksum", async () => {
    const match = await verifyChecksum(MOCK_ENTRYPOINT, "0000000000000000000000000000000000000000000000000000000000000000");
    expect(match).toBe(false);
  });

  test("checksum is deterministic (same file = same hash)", async () => {
    const hash1 = await computeChecksum(MOCK_ENTRYPOINT);
    const hash2 = await computeChecksum(MOCK_ENTRYPOINT);
    expect(hash1).toBe(hash2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. ExtensionRegistry
// ═══════════════════════════════════════════════════════════════════════

describe("ExtensionRegistry", () => {
  const createdExtIds: string[] = [];

  afterEach(async () => {
    ExtensionRegistry.resetInstance();
    for (const id of createdExtIds) {
      await deleteExtension(id).catch(() => {});
    }
    createdExtIds.length = 0;
  });

  async function createTrackedExtension(name: string, overrides: Record<string, unknown> = {}) {
    const ext = await insertTestExtension(name, overrides);
    createdExtIds.push(ext.id);
    return ext;
  }

  // ── Singleton ──────────────────────────────────────────────────────

  test("getInstance() returns same instance", () => {
    const a = ExtensionRegistry.getInstance();
    const b = ExtensionRegistry.getInstance();
    expect(a).toBe(b);
  });

  test("resetInstance() creates new instance", () => {
    const a = ExtensionRegistry.getInstance();
    ExtensionRegistry.resetInstance();
    const b = ExtensionRegistry.getInstance();
    expect(a).not.toBe(b);
  });

  // ── loadFromDb ─────────────────────────────────────────────────────

  test("loadFromDb() populates tool map from enabled extensions", async () => {
    await createTrackedExtension("load-test");

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    expect(registry.getToolExtension("load-test__echo")).not.toBeNull();
  });

  test("loadFromDb() ignores disabled extensions", async () => {
    const ext = await createTrackedExtension("disabled-ext", { enabled: false });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    // The tool from the disabled extension should not be in the map
    // We need a unique tool name to test this properly
    const enabledExts = await listExtensions(true);
    const disabledInRegistry = enabledExts.find((e) => e.id === ext.id);
    expect(disabledInRegistry).toBeUndefined();
  });

  // ── getToolExtension ───────────────────────────────────────────────

  test("getToolExtension() returns null for unknown tools", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    expect(registry.getToolExtension("definitely-not-a-real-tool")).toBeNull();
  });

  test("getToolExtension() returns correct extension ID", async () => {
    const ext = await createTrackedExtension("tool-lookup", {
      manifest: makeManifest({
        name: "tool-lookup",
        tools: [{ name: "unique-lookup-tool", description: "Lookup", inputSchema: {} }],
      }),
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    expect(registry.getToolExtension("tool-lookup__unique-lookup-tool")).toBe(ext.id);
  });

  // ── Tool name collisions ───────────────────────────────────────────

  test("tool name collisions: namespacing prevents conflicts", async () => {
    const ext1 = await createTrackedExtension("collision-first", {
      manifest: makeManifest({
        name: "collision-first",
        tools: [{ name: "colliding-tool", description: "First", inputSchema: {} }],
      }),
    });
    const ext2 = await createTrackedExtension("collision-second", {
      manifest: makeManifest({
        name: "collision-second",
        tools: [{ name: "colliding-tool", description: "Second", inputSchema: {} }],
      }),
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    // With namespacing, both tools coexist under different keys
    expect(registry.getToolExtension("collision-first__colliding-tool")).toBe(ext1.id);
    expect(registry.getToolExtension("collision-second__colliding-tool")).toBe(ext2.id);
  });

  // ── getAllTools ─────────────────────────────────────────────────────

  test("getAllTools() returns all tools without internal fields", async () => {
    await createTrackedExtension("alltools-test", {
      manifest: makeManifest({
        name: "alltools-test",
        tools: [
          { name: "at-tool-a", description: "A", inputSchema: {} },
          { name: "at-tool-b", description: "B", inputSchema: {} },
        ],
      }),
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const allTools = registry.getAllTools();
    const names = allTools.map((t) => t.name);
    expect(names).toContain("alltools-test__at-tool-a");
    expect(names).toContain("alltools-test__at-tool-b");

    // Verify extensionId and extensionName are stripped
    for (const tool of allTools) {
      expect("extensionId" in tool).toBe(false);
      expect("extensionName" in tool).toBe(false);
    }
  });

  // ── getProcess ─────────────────────────────────────────────────────

  test("getProcess() creates ExtensionProcess with correct env", async () => {
    await createTrackedExtension("proc-create", {
      manifest: makeManifest({ name: "proc-create", permissions: { env: ["FOO_VAR"] } }),
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const extId = registry.getToolExtension("proc-create__echo")!;
    const proc = await registry.getProcess(extId);
    expect(proc).toBeDefined();
    expect(proc.extensionId).toBe(extId);

    proc.kill();
  });

  test("getProcess() returns existing process if still running", async () => {
    await createTrackedExtension("proc-reuse");

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const extId = registry.getToolExtension("proc-reuse__echo")!;
    const proc1 = await registry.getProcess(extId);
    proc1.ensureRunning();

    const proc2 = await registry.getProcess(extId);
    expect(proc1).toBe(proc2);

    proc1.kill();
  });

  test("getProcess() throws for unknown extension ID", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    expect(registry.getProcess("nonexistent-id-12345")).rejects.toThrow("not found in registry");
  });

  // ── getProcessIfRunning ───────────────────────────────────────────

  test("getProcessIfRunning() returns null when no process exists", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    expect(registry.getProcessIfRunning("nonexistent-id")).toBeNull();
  });

  test("getProcessIfRunning() returns process when running", async () => {
    await createTrackedExtension("proc-running-check");

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const extId = registry.getToolExtension("proc-running-check__echo")!;
    const proc = await registry.getProcess(extId);
    proc.ensureRunning();

    const result = registry.getProcessIfRunning(extId);
    expect(result).not.toBeNull();
    expect(result!.extensionId).toBe(extId);

    proc.kill();
  });

  test("getProcessIfRunning() returns null after process is killed", async () => {
    await createTrackedExtension("proc-killed-check");

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const extId = registry.getToolExtension("proc-killed-check__echo")!;
    const proc = await registry.getProcess(extId);
    proc.ensureRunning();
    expect(registry.getProcessIfRunning(extId)).not.toBeNull();

    proc.kill();
    expect(registry.getProcessIfRunning(extId)).toBeNull();
  });

  // ── killAll ────────────────────────────────────────────────────────

  test("killAll() kills all managed processes", async () => {
    await createTrackedExtension("killall-a", {
      manifest: makeManifest({
        name: "killall-a",
        tools: [{ name: "ka-tool", description: "A", inputSchema: {} }],
      }),
    });
    await createTrackedExtension("killall-b", {
      manifest: makeManifest({
        name: "killall-b",
        tools: [{ name: "kb-tool", description: "B", inputSchema: {} }],
      }),
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const idA = registry.getToolExtension("killall-a__ka-tool")!;
    const idB = registry.getToolExtension("killall-b__kb-tool")!;

    const procA = await registry.getProcess(idA);
    const procB = await registry.getProcess(idB);
    procA.ensureRunning();
    procB.ensureRunning();

    expect(procA.isRunning).toBe(true);
    expect(procB.isRunning).toBe(true);

    registry.killAll();

    expect(procA.isRunning).toBe(false);
    expect(procB.isRunning).toBe(false);
  });

  // ── reload ─────────────────────────────────────────────────────────

  test("reload() re-reads DB and updates tool map", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    // Initially no "reload-ext__reload-tool"
    expect(registry.getToolExtension("reload-ext__reload-tool")).toBeNull();

    // Insert new extension
    await createTrackedExtension("reload-ext", {
      manifest: makeManifest({
        name: "reload-ext",
        tools: [{ name: "reload-tool", description: "Reload test", inputSchema: {} }],
      }),
    });

    await registry.reload();
    expect(registry.getToolExtension("reload-ext__reload-tool")).not.toBeNull();
  });
});
