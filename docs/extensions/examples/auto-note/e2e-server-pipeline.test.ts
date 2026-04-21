/**
 * E2E test: exercises the REAL server pipeline for auto-note.
 *
 * This test spawns auto-note through `ExtensionProcess` (from `src/extensions/subprocess.ts`)
 * — the same class the server uses in `ExtensionRegistry.getProcess` — so bugs that only
 * surface in the full server-pipeline path (sandbox preload, JSON-RPC framing with
 * notifications, mutex behaviour under retries, env allowlist) are reproducible here.
 *
 * Isolated into its own file because `mock.module("../../../../src/db/queries/extensions")`
 * would otherwise contaminate the shared module cache for the rest of the auto-note
 * tests (which import nothing from src/db).
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";

// ── DB stubs ────────────────────────────────────────────────────
// Must be declared BEFORE importing ExtensionProcess so the subprocess module
// picks up the mocked queries (`incrementFailures` / `resetFailures` /
// `disableExtension`) rather than hitting a real DB that isn't configured in
// this test harness.

let incrementCalls = 0;
let resetCalls = 0;
let disableCalls = 0;
let simulatedConsecutiveFailures = 0;

mock.module("../../../../src/db/queries/extensions", () => ({
  incrementFailures: async () => {
    incrementCalls++;
    simulatedConsecutiveFailures++;
    return simulatedConsecutiveFailures;
  },
  resetFailures: async () => {
    resetCalls++;
    simulatedConsecutiveFailures = 0;
  },
  disableExtension: async () => {
    disableCalls++;
  },
}));

// Import AFTER mock.module so the subprocess module resolves to our stub.
import { ExtensionProcess } from "../../../../src/extensions/subprocess";

// ── buildAllowedEnv() parity ────────────────────────────────────
// Mirrors registry.ts buildAllowedEnv() for a permissions-minimal extension.
// auto-note declares filesystem: ["$CWD"], shell: false, storage: true — no
// env permissions — so the allowlist is just PATH/HOME/NODE_ENV/TMPDIR.
function buildAllowedEnvLike(extensionId: string): Record<string, string> {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  mkdirSync(extTmpDir, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    TMPDIR: extTmpDir,
  };
}

const AUTO_NOTE_ENTRYPOINT = join(import.meta.dir, "index.ts");
const TEST_TMP_ROOT = join(tmpdir(), `auto-note-e2e-pipeline-${Date.now()}`);

// ── Helpers ─────────────────────────────────────────────────────
function makeProc(): ExtensionProcess {
  const extId = "auto-note-test-" + Math.random().toString(36).slice(2, 8);
  const env = buildAllowedEnvLike(extId);
  return new ExtensionProcess(extId, AUTO_NOTE_ENTRYPOINT, env, {
    persistent: true,
    callTimeoutMs: 15_000,
  });
}

describe("E2E: real ExtensionProcess (server pipeline)", () => {
  let cwd: string;
  let originalCwd: string;
  const procs: ExtensionProcess[] = [];

  beforeEach(() => {
    // Each test gets its own vault dir; auto-note's getVaultRoot() anchors on
    // findProjectRoot which walks up for a .git dir. Using a fresh cwd with
    // .git ensures the extension writes into OUR tmp area, not the repo.
    cwd = join(TEST_TMP_ROOT, `vault-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(cwd, ".git"), { recursive: true });
    originalCwd = process.cwd();
    // NOTE: ExtensionProcess does NOT set cwd on Bun.spawn — it inherits the
    // parent's cwd. So for auto-note to anchor on our test dir we must chdir.
    process.chdir(cwd);

    incrementCalls = 0;
    resetCalls = 0;
    disableCalls = 0;
    simulatedConsecutiveFailures = 0;
  });

  afterEach(async () => {
    for (const p of procs.splice(0)) {
      try { p.kill(); } catch {}
    }
    try { process.chdir(originalCwd); } catch {}
  });

  afterAll(() => {
    try { rmSync(TEST_TMP_ROOT, { recursive: true }); } catch {}
  });

  test("spawn via real ExtensionProcess handles 3 sequential capture calls (server-retry pattern)", async () => {
    const proc = makeProc();
    procs.push(proc);

    for (let i = 0; i < 3; i++) {
      const result = await proc.callTool("capture", { text: `retry-${i} test capture`, mode: "yolo" });
      expect(result.isError).toBe(false);
      expect(result.content[0]!.text).toContain("Done!");
    }

    expect(proc.isRunning).toBe(true);
    // Three successful calls → resetFailures called 3 times, increment never
    expect(resetCalls).toBeGreaterThanOrEqual(3);
    expect(incrementCalls).toBe(0);
    expect(simulatedConsecutiveFailures).toBe(0);
  }, 30_000);

  test("lifecycle notification followed by tool call does not close transport", async () => {
    const proc = makeProc();
    procs.push(proc);

    // Warm up the process via a harmless call
    const warm = await proc.callTool("vault-tree", {});
    expect(warm.isError).toBe(false);

    // Fire a lifecycle notification (no id — fire-and-forget)
    proc.sendNotification("lifecycle/run:start", {});

    // Small pause to let the subprocess process the notification
    await new Promise((r) => setTimeout(r, 50));

    const after = await proc.callTool("capture", { text: "post-lifecycle capture", mode: "yolo" });
    expect(after.isError).toBe(false);
    expect(after.content[0]!.text).toContain("Done!");
    expect(proc.isRunning).toBe(true);
  }, 30_000);

  test("panel state emitted by lifecycle does not desync subsequent tool call", async () => {
    const proc = makeProc();
    procs.push(proc);

    const notifs: { method: string; params: unknown }[] = [];
    proc.setNotificationHandler((n) => notifs.push({ method: n.method, params: n.params as unknown }));

    await proc.callTool("vault-tree", {}); // warm up + register handler

    proc.sendNotification("lifecycle/run:start", {});

    // Wait for the panel state notification to arrive
    const deadline = Date.now() + 2000;
    while (!notifs.find((n) => n.method === "ezcorp/state") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const stateNotif = notifs.find((n) => n.method === "ezcorp/state");
    expect(stateNotif).toBeDefined();

    // Immediately issue a tool call — must succeed, not timeout on a desynced stream
    const res = await proc.callTool("capture", { text: "after-panel-state", mode: "yolo" });
    expect(res.isError).toBe(false);
    expect(res.content[0]!.text).toContain("Done!");
  }, 30_000);

  test("persistent process handles 10 sequential captures without disconnection", async () => {
    const proc = makeProc();
    procs.push(proc);

    for (let i = 0; i < 10; i++) {
      const r = await proc.callTool("capture", { text: `sequential note ${i} #bulk`, mode: "yolo" });
      expect(r.isError).toBe(false);
      expect(r.content[0]!.text).toContain("Done!");
    }

    expect(proc.isRunning).toBe(true);
  }, 60_000);

  test("concurrent captures (Promise.all of 3) — mutex allows all to complete", async () => {
    const proc = makeProc();
    procs.push(proc);

    const results = await Promise.all([
      proc.callTool("capture", { text: "concurrent A #race", mode: "yolo" }),
      proc.callTool("capture", { text: "concurrent B #race", mode: "yolo" }),
      proc.callTool("capture", { text: "concurrent C #race", mode: "yolo" }),
    ]);

    for (const r of results) {
      expect(r.isError).toBe(false);
      expect(r.content[0]!.text).toContain("Done!");
    }
    expect(proc.isRunning).toBe(true);
  }, 30_000);

  test("malformed tool args do not kill the subprocess", async () => {
    const proc = makeProc();
    procs.push(proc);

    // Missing required `text` → extension returns a JSON-RPC error; callTool
    // wraps it as an isError result. The subprocess must stay alive.
    const bad = await proc.callTool("capture", { /* no text */ } as Record<string, unknown>);
    expect(bad.isError).toBe(true);

    // Next valid call still works
    const ok = await proc.callTool("capture", { text: "recovery note", mode: "yolo" });
    expect(ok.isError).toBe(false);
    expect(ok.content[0]!.text).toContain("Done!");
    expect(proc.isRunning).toBe(true);
  }, 30_000);

  test("lifecycle-emitted panel state is a valid JSON-RPC notification matching stateSchema", async () => {
    const proc = makeProc();
    procs.push(proc);

    const notifs: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    proc.setNotificationHandler((n) => notifs.push({ method: n.method, params: n.params }));

    await proc.callTool("vault-tree", {}); // warm the process and wire handler
    proc.sendNotification("lifecycle/run:start", {});

    // Wait for the notification
    const deadline = Date.now() + 2000;
    while (!notifs.find((n) => n.method === "ezcorp/state") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const stateNotif = notifs.find((n) => n.method === "ezcorp/state");
    expect(stateNotif).toBeDefined();
    // method already checked; validate params conforms to auto-note manifest.panel.stateSchema:
    //   { type: "object", properties: { title: string, components: array } }
    expect(stateNotif!.params).toBeDefined();
    const params = stateNotif!.params!;
    expect(typeof params).toBe("object");
    expect(typeof (params as Record<string, unknown>).title).toBe("string");
    expect(Array.isArray((params as Record<string, unknown>).components)).toBe(true);
  }, 30_000);
});
