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
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";

mock.module("../../../../src/db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

import { ExtensionProcess } from "../../../../src/extensions/subprocess";
import { restoreModuleMocks } from "../../../../src/__tests__/helpers/mock-cleanup";
import { buildHarnessEnv, makeFsRpcHandler } from "../_harness/pipeline-harness";
import type { JsonRpcRequest, JsonRpcResponse } from "../../../../src/extensions/types";

const ENTRYPOINT = join(import.meta.dir, "index.ts");

interface HostState {
  kv: Map<string, unknown>;
  fsRoot: string;
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function handleStorage(state: HostState, p: Record<string, unknown>): unknown {
  const action = p.action as string;
  const key = p.key as string;
  if (action === "get") {
    return state.kv.has(key)
      ? { value: state.kv.get(key), exists: true }
      : { value: null, exists: false };
  }
  if (action === "set") {
    state.kv.set(key, JSON.parse(JSON.stringify(p.value)));
    return { ok: true, sizeBytes: 0 };
  }
  if (action === "delete") return { deleted: state.kv.delete(key) };
  if (action === "list") {
    const prefix = (p.prefix as string) ?? "";
    return { keys: [...state.kv.keys()].filter((k) => k.startsWith(prefix)) };
  }
  return { ok: true };
}

describe("sample-loop — real subprocess", () => {
  let proc: ExtensionProcess | undefined;
  let state: HostState;
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
    state = { kv: new Map(), fsRoot: projectRoot };
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
    const fsHandler = makeFsRpcHandler(projectRoot);
    const p = new ExtensionProcess(extId, ENTRYPOINT, env, {
      persistent: true,
      callTimeoutMs: 15_000,
    });
    p.setRequestHandler(async (req): Promise<JsonRpcResponse> => {
      const params = (req.params ?? {}) as Record<string, unknown>;
      if (req.method === "ezcorp/storage") return ok(req.id, handleStorage(state, params));
      if (req.method === "ezcorp/llm-complete") {
        return ok(req.id, {
          content: "A concise summary.",
          blocks: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          model: "m",
        });
      }
      if (req.method === "ezcorp/invoke") {
        // The loop's recentMessages → runtime.conversations.getMessages.
        const tool = (params as { tool?: string }).tool;
        if (tool === "runtime.conversations.getMessages") {
          return ok(req.id, {
            messages: [
              { id: "m1", role: "user", content: "hello" },
              { id: "m2", role: "assistant", content: "hi" },
            ],
            projectId: "p1",
          });
        }
        if (tool === "runtime.settings.getMine") return ok(req.id, { enabled: true });
        return ok(req.id, {});
      }
      const fsRes = fsHandler(req);
      if (fsRes) return fsRes;
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no: ${req.method}` } };
    });
    return p;
  }

  test("run:complete → run persisted (per-run + index keys) + artifact mirrored", async () => {
    proc = spawnWired();
    proc.ensureRunning();
    // Force the channel up before the notification (sendNotification drops
    // frames until the subprocess is spawned + reading).
    await new Promise((r) => setTimeout(r, 150));
    proc.sendNotification("ezcorp/event/run:complete", { conversationId: "conv-9" });

    // Poll the storage KV the host captured for the persisted run.
    let indexKey: string | undefined;
    for (let i = 0; i < 60; i++) {
      indexKey = [...state.kv.keys()].find((k) => k === "loop:summarize:index");
      if (indexKey && Array.isArray(state.kv.get(indexKey)) && (state.kv.get(indexKey) as string[]).length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
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
    let wrote = false;
    for (let i = 0; i < 40; i++) {
      if (existsSync(summariesDir)) {
        const f = `${summariesDir}/${ids![0]}.md`;
        if (existsSync(f)) {
          expect(readFileSync(f, "utf8")).toContain("A concise summary.");
          wrote = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(wrote).toBe(true);
  });
});
