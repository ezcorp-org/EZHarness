/**
 * E2E test: exercises the REAL server pipeline for todo-tracker.
 *
 * Mirrors the canonical `docs/extensions/examples/auto-note/e2e-server-pipeline.test.ts`
 * pattern. Spawns todo-tracker through `ExtensionProcess` (from
 * `src/extensions/subprocess.ts`) — the same class the server uses in
 * `ExtensionRegistry.getProcess` — so bugs that only surface in the full
 * server-pipeline path (sandbox preload, JSON-RPC framing, host-mediated
 * fs reverse-RPC, env allowlist) are reproducible here.
 *
 * todo-tracker declares `permissions.filesystem: ["$CWD"]` and walks the
 * tree via the SDK's host-mediated `fsList` / `fsRead` (the pre-migration
 * `Bun.$` shell-out is gone — manifest `shell: false`). This test therefore
 * spawns with `EZCORP_FS_ALLOWED=1` and wires the `ezcorp/fs.*` reverse-RPC
 * handler (via the shared `_harness` helper) — parity with what
 * registry.ts + ToolExecutor grant at production install time.
 *
 * Isolated into its own file because `mock.module("../../../../src/db/queries/extensions")`
 * would otherwise contaminate the shared module cache for the rest of the
 * todo-tracker tests.
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

// ── DB stubs ────────────────────────────────────────────────────
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
import { buildHarnessEnv, wireFsHandler } from "../_harness/pipeline-harness";

const TODO_TRACKER_ENTRYPOINT = join(import.meta.dir, "index.ts");
const TEST_TMP_ROOT = join(tmpdir(), `todo-tracker-e2e-pipeline-${Date.now()}`);

// Filesystem grant + host-mediated `ezcorp/fs.*` wiring (scoped to tmpdir,
// which contains the per-test cwd the scanner walks). Mirrors registry.ts +
// ToolExecutor; see the shared `_harness` helper.
function makeProc(): ExtensionProcess {
  const extId = "todo-tracker-test-" + Math.random().toString(36).slice(2, 8);
  const env = buildHarnessEnv(extId, { filesystem: true });
  const proc = new ExtensionProcess(extId, TODO_TRACKER_ENTRYPOINT, env, {
    persistent: true,
    callTimeoutMs: 15_000,
  });
  wireFsHandler(proc, { fsRoot: tmpdir() });
  return proc;
}

describe("E2E: todo-tracker real ExtensionProcess (server pipeline)", () => {
  let cwd: string;
  let originalCwd: string;
  const procs: ExtensionProcess[] = [];

  beforeEach(() => {
    cwd = join(TEST_TMP_ROOT, `root-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(cwd, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(cwd);
    incrementCalls = 0;
    resetCalls = 0;
    disableCalls = 0;
    simulatedConsecutiveFailures = 0;
  });

  afterEach(() => {
    for (const p of procs.splice(0)) {
      try { p.kill(); } catch { /* already dead */ }
    }
    try { process.chdir(originalCwd); } catch { /* best-effort */ }
  });

  afterAll(() => {
    try { rmSync(TEST_TMP_ROOT, { recursive: true }); } catch { /* best-effort */ }
  });

  test("scan-todos on empty tree reports 'No TODO' through full RPC stack", async () => {
    const proc = makeProc();
    procs.push(proc);
    const r = await proc.callTool("scan-todos", {});
    expect(r.isError).toBe(false);
    const first = r.content[0];
    if (!first || first.type !== "text") throw new Error("expected text content");
    expect(first.text).toContain("No TODO");
  }, 30_000);

  test("scan-todos over seeded files returns markers (host-mediated fsList/fsRead flow)", async () => {
    writeFileSync(join(cwd, "one.ts"), "// TODO(priority:high): finish integration\nexport const a = 1;\n");
    writeFileSync(join(cwd, "two.ts"), "// FIXME: edge case\nconst b = 2;\n");
    writeFileSync(join(cwd, "three.js"), "// HACK: temporary workaround\n");

    const proc = makeProc();
    procs.push(proc);
    const r = await proc.callTool("scan-todos", {});
    expect(r.isError).toBe(false);
    const first = r.content[0];
    if (!first || first.type !== "text") throw new Error("expected text content");
    expect(first.text).toContain("finish integration");
    expect(first.text).toContain("edge case");
    expect(first.text).toContain("temporary workaround");
  }, 30_000);

  test("priority filter flows through JSON-RPC args end-to-end", async () => {
    writeFileSync(join(cwd, "a.ts"), "// TODO(priority:high): critical one\n// TODO: low-priority chore\n");
    const proc = makeProc();
    procs.push(proc);

    const r = await proc.callTool("scan-todos", { priority: "high" });
    expect(r.isError).toBe(false);
    const first = r.content[0];
    if (!first || first.type !== "text") throw new Error("expected text content");
    expect(first.text).toContain("critical one");
    expect(first.text).not.toContain("low-priority chore");
  }, 30_000);

  test("3 sequential scan-todos calls on same persistent process — resetFailures counter rises", async () => {
    writeFileSync(join(cwd, "a.ts"), "// TODO: persistent-call\n");
    const proc = makeProc();
    procs.push(proc);

    for (let i = 0; i < 3; i++) {
      const r = await proc.callTool("scan-todos", {});
      expect(r.isError).toBe(false);
      const first = r.content[0];
      if (!first || first.type !== "text") throw new Error("expected text content");
      expect(first.text).toContain("persistent-call");
    }
    expect(proc.isRunning).toBe(true);
    expect(resetCalls).toBeGreaterThanOrEqual(3);
    expect(incrementCalls).toBe(0);
  }, 45_000);

  test("unknown tool returns JSON-RPC error as isError:true; process recovers", async () => {
    const proc = makeProc();
    procs.push(proc);
    const bad = await proc.callTool("nonexistent", {});
    expect(bad.isError).toBe(true);

    const ok = await proc.callTool("scan-todos", {});
    expect(ok.isError).toBe(false);
    expect(proc.isRunning).toBe(true);
  }, 30_000);
});
