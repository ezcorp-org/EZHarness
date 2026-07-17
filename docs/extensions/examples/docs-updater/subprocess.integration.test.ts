/**
 * docs-updater — REAL subprocess smoke (transport proof).
 *
 * Spawns the example through the real `ExtensionProcess` transport under the
 * production sandbox-preload, seeds a REAL throwaway git repo, and drives the
 * manual trigger to prove the leg in-process mocks cannot: the deterministic
 * `git`-cursor check (real `git` under the shell grant) → the deferred agent
 * dispatch (the real `ezcorp/spawn-assignment` reverse RPC) → the deferred run
 * persisted to the host storage RPC. It STOPS before the agent completes, so
 * no `gh` / network is ever touched — the approve/decline/finalize flow is
 * proven deterministically by `index.integration.test.ts` against the real
 * primitive with an injected offline `gh`.
 *
 * Isolated file: `mock.module("../../../../src/db/queries/extensions")` must
 * run BEFORE the subprocess module is imported.
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

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
  spawns: Record<string, unknown>[];
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function handleStorage(state: HostState, p: Record<string, unknown>): unknown {
  const action = p.action as string;
  const key = p.key as string;
  if (action === "get") return state.kv.has(key) ? { value: state.kv.get(key), exists: true } : { value: null, exists: false };
  if (action === "set") { state.kv.set(key, JSON.parse(JSON.stringify(p.value))); return { ok: true, sizeBytes: 0 }; }
  if (action === "delete") return { deleted: state.kv.delete(key) };
  if (action === "list") return { keys: [...state.kv.keys()].filter((k) => k.startsWith((p.prefix as string) ?? "")) };
  return { ok: true };
}

async function seedRepo(repo: string): Promise<void> {
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", "-C", repo, ...args], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    await p.exited;
  };
  await git("init", "-q");
  await git("config", "user.email", "probe@example.test");
  await git("config", "user.name", "Probe");
  writeFileSync(join(repo, "README.md"), "# probe\n");
  await git("add", "README.md");
  await git("commit", "-q", "-m", "feat: seed the probe repo");
}

describe("docs-updater — real subprocess", () => {
  let proc: ExtensionProcess | undefined;
  let state: HostState;
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    projectRoot = join(tmpdir(), `du-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(projectRoot, ".ezcorp", "extension-data"), { recursive: true });
    // Keep EZCORP_PROJECT_ROOT UNSET (setting it trips the bwrap wrap that
    // can't run in this container). The loop resolves the repo from the
    // configured `repo_path` setting.
    originalCwd = process.cwd();
    process.chdir(projectRoot);
    await seedRepo(projectRoot);
    state = { kv: new Map(), spawns: [] };
  });

  afterEach(() => {
    proc?.kill();
    proc = undefined;
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function spawnWired(): ExtensionProcess {
    const extId = "docs-updater-" + Math.random().toString(36).slice(2, 8);
    const env = buildHarnessEnv(extId, { shell: true, filesystem: true });
    const fsHandler = makeFsRpcHandler(projectRoot);
    const p = new ExtensionProcess(extId, ENTRYPOINT, env, {
      persistent: true,
      shellAllowed: true,
      callTimeoutMs: 20_000,
    });
    p.setRequestHandler(async (req): Promise<JsonRpcResponse> => {
      const params = (req.params ?? {}) as Record<string, unknown>;
      if (req.method === "ezcorp/storage") return ok(req.id, handleStorage(state, params));
      if (req.method === "ezcorp/spawn-assignment") {
        state.spawns.push(params);
        return ok(req.id, {
          v: 1,
          subConversationId: "sub-e2e",
          agentRunId: "agent-run-e2e",
          taskId: "task-e2e",
          assignmentId: "assign-e2e",
        });
      }
      if (req.method === "ezcorp/invoke") {
        const tool = (params as { tool?: string }).tool;
        if (tool === "runtime.settings.getMine") {
          return ok(req.id, {
            enabled: true,
            repo_path: projectRoot,
            agent_name: "coder",
            write_paths: "README.md,docs/",
            auto_merge: false,
          });
        }
        return ok(req.id, {});
      }
      const fsRes = fsHandler(req);
      if (fsRes) return fsRes;
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no: ${req.method}` } };
    });
    return p;
  }

  test("manual trigger: check proceeds → spawns the agent → deferred run persists", async () => {
    proc = spawnWired();
    proc.ensureRunning();
    await new Promise((r) => setTimeout(r, 200));

    const first = await proc.call("tools/call", { name: "run_docs_update", arguments: {} });
    const body = JSON.parse(((first.result as { content?: { text?: string }[] })?.content?.[0]?.text) ?? "{}") as {
      status?: string;
      skipped?: boolean;
      runId?: string;
    };
    expect(body.skipped).toBeUndefined();
    expect(body.status).toBe("drafting");
    expect(body.runId).toBe("agent-run-e2e");

    // The real spawn RPC fired with the preset docs prompt.
    expect(state.spawns.length).toBe(1);
    expect(String((state.spawns[0] as { task?: string }).task)).toContain("update the project documentation");

    // The deferred run persisted (per-run + index keys) at `drafting`.
    const ids = state.kv.get("loop:docs-updater:index") as string[] | undefined;
    expect(ids).toEqual(["agent-run-e2e"]);
    const run = state.kv.get("loop:docs-updater:run:agent-run-e2e") as { status: string } | undefined;
    expect(run?.status).toBe("drafting");

    // The cursor advanced to HEAD (at-most-once).
    const cursor = state.kv.get("loop:docs-updater:cursor") as string | undefined;
    expect(cursor).toMatch(/^[0-9a-f]{40}$/);

    // ── second run → check declines (no new commits) → skip ──
    const second = await proc.call("tools/call", { name: "run_docs_update", arguments: {} });
    const secondBody = JSON.parse(((second.result as { content?: { text?: string }[] })?.content?.[0]?.text) ?? "{}") as {
      skipped?: boolean;
      reason?: string;
    };
    expect(secondBody.skipped).toBe(true);
    expect(secondBody.reason).toBe("no_new_commits");
    // No second spawn, still one run.
    expect(state.spawns.length).toBe(1);
    expect((state.kv.get("loop:docs-updater:index") as string[]).length).toBe(1);
  });
});
