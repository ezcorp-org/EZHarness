// @ezcorp-host-integration
const fixtureImportMeta = { dir: import.meta.dir, dirname: import.meta.dir, url: import.meta.url };
/**
 * sample-loop — REAL subprocess integration test.
 *
 * Spawns the reference example through the real `ExtensionProcess`
 * transport under the production sandbox-preload, fires a `run:complete`
 * event, and asserts the full primitive path end-to-end: the loop runs,
 * persists a run record via `ezcorp/storage` (per-run + index keys), calls
 * the host-brokered LLM (`ezcorp/llm-complete`), and mirrors the summary
 * to an artifact via host-mediated `ezcorp/fs.*`. In-process mocks lie for
 * these fs/RPC/trigger paths (project lesson), so this is the example's
 * authoritative integration coverage — "docs examples must run".
 *
 * Isolated file: `mock.module("../../../../src/db/queries/extensions")`
 * must run BEFORE the subprocess module is imported.
 */
import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  afterAll,
  mock,
} from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, rmSync, readFileSync } from "fs";

mock.module("../../../../src/db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

import { ExtensionProcess } from "../../../../src/extensions/subprocess";
import { restoreModuleMocks } from "@ezcorp/sdk/test";
import { buildHarnessEnv } from "@ezcorp/sdk/test";
import { sampleLoopHost } from "../../../../src/__tests__/helpers/sample-loop-harness";

const ENTRYPOINT = join(fixtureImportMeta.dir, "index.ts");

describe("sample-loop — real subprocess", () => {
  let proc: ExtensionProcess | undefined;
  let state: ReturnType<typeof sampleLoopHost>;
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `sample-loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    // The artifact mirror resolves under the subprocess cwd (the loop's
    // `loopDataDir` falls back to `process.cwd()` when EZCORP_PROJECT_ROOT
    // is unset — which we keep unset on purpose: setting it would trip the
    // bwrap outer-jail wrap, which can't run in this container). The
    // subprocess inherits the parent cwd, so chdir the parent here.
    mkdirSync(join(projectRoot, ".ezcorp", "extension-data"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(projectRoot);
    state = sampleLoopHost(projectRoot, "A concise summary.", "m", [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "hi" },
    ]);
  });

  afterEach(() => {
    proc?.kill();
    proc = undefined;
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function spawnWired(): ExtensionProcess {
    const extId = "sample-loop-" + Math.random().toString(36).slice(2, 8);
    // Grant fs (artifact mirror) — but DO NOT set EZCORP_PROJECT_ROOT
    // (that triggers the bwrap wrap). The loop resolves the data dir from
    // the inherited cwd instead.
    const env = buildHarnessEnv(extId, { filesystem: true });
    const p = new ExtensionProcess(extId, ENTRYPOINT, env, {
      persistent: true,
      callTimeoutMs: 15_000,
    });
    p.setRequestHandler(state.handleRequest);
    return p;
  }

  test("host completion waits for both index and artifact writes, in either order", async () => {
    for (const order of ["index-first", "artifact-first"] as const) {
      const root = join(projectRoot, order);
      const host = sampleLoopHost(root, "A concise summary.", "m", []);
      const runId = "run-1";
      const file = join(root, ".ezcorp", "extension-data", "summarize", "summaries", `${runId}.md`);
      mkdirSync(join(root, ".ezcorp", "extension-data", "summarize", "summaries"), { recursive: true });
      const writes = {
        index: { jsonrpc: "2.0" as const, id: 1, method: "ezcorp/storage", params: { action: "set", key: "loop:summarize:index", value: [runId] } },
        artifact: { jsonrpc: "2.0" as const, id: 2, method: "ezcorp/fs.write", params: { path: file, content: "A concise summary." } },
      };
      const first = order === "index-first" ? writes.index : writes.artifact;
      const second = order === "index-first" ? writes.artifact : writes.index;
      let complete = false;
      void host.whenComplete.then(() => { complete = true; });
      expect((await host.handleRequest(first)).error).toBeUndefined();
      await Promise.resolve();
      expect(complete).toBe(false);
      expect((await host.handleRequest(second)).error).toBeUndefined();
      await host.whenComplete;
      expect(complete).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("A concise summary.");
    }
  });

  test("run:complete → run persisted (per-run + index keys) + artifact mirrored", async () => {
    proc = spawnWired();
    // This no-tool extension answers from its started channel; the loop was
    // registered immediately before that channel started.
    expect((await proc.call("tools/list")).error).toEqual({ code: -32601, message: "Method not found: tools/list" });
    expect(await proc.sendNotification("ezcorp/event/run:complete", { conversationId: "conv-9" })).toBe(true);
    await state.whenComplete;

    const ids = state.kv.get("loop:summarize:index") as string[] | undefined;
    expect(Array.isArray(ids)).toBe(true);
    expect(ids!.length).toBe(1);
    // Per-run key (not a packed blob).
    const run = state.kv.get(`loop:summarize:run:${ids![0]}`) as
      | { status: string; outcome?: { summary?: string } }
      | undefined;
    expect(run?.status).toBe("done");
    expect(run?.outcome?.summary).toBe("A concise summary.");

    // Artifact mirrored under .ezcorp/extension-data/summarize/summaries/.
    const summariesDir = join(projectRoot, ".ezcorp", "extension-data", "summarize", "summaries");
    const file = `${summariesDir}/${ids![0]}.md`;
    expect(readFileSync(file, "utf8")).toContain("A concise summary.");
  });
});
