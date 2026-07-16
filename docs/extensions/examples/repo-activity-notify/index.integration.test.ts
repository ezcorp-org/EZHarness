/**
 * repo-activity-notify — REAL subprocess integration test (the trust probe).
 *
 * Spawns the reference example through the real `ExtensionProcess` transport
 * under the production sandbox-preload, seeds a REAL throwaway git repo, and
 * drives the manual trigger twice to exercise the `check` gate BOTH ways:
 *
 *   1. first run  → check reads a NEW HEAD (cursor unset) → proceed → act
 *      appends a one-line notice (real `ezcorp/append-message`) + mirrors an
 *      artifact via host-mediated `ezcorp/fs.*`; the run persists `done`.
 *   2. second run → check reads the SAME HEAD (cursor now advanced) →
 *      `proceed:false` → a first-class skip (`no_new_commits`); NO new run,
 *      NO second append.
 *
 * This is the example's authoritative coverage of the check firewall running
 * deterministic `git` under the shell grant — in-process mocks lie for the
 * fs/RPC/spawn paths (project lesson), so only a real subprocess proves it.
 * Explicit start + explicit conversation wiring (settings): the dispatcher
 * never spawns a non-bundled loop for you.
 *
 * Isolated file: `mock.module("../../../../src/db/queries/extensions")` must
 * run BEFORE the subprocess module is imported.
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
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";

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
  appends: Record<string, unknown>[];
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function handleStorage(state: HostState, p: Record<string, unknown>): unknown {
  const action = p.action as string;
  const key = p.key as string;
  if (action === "get") {
    return state.kv.has(key) ? { value: state.kv.get(key), exists: true } : { value: null, exists: false };
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

/** Seed a real throwaway git repo with a single commit; return its HEAD subject. */
async function seedRepo(repo: string): Promise<void> {
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", "-C", repo, ...args], {
      stdout: "pipe",
      stderr: "pipe",
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

describe("repo-activity-notify — real subprocess", () => {
  let proc: ExtensionProcess | undefined;
  let state: HostState;
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    projectRoot = join(tmpdir(), `ran-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(projectRoot, ".ezcorp", "extension-data"), { recursive: true });
    // Keep EZCORP_PROJECT_ROOT UNSET (setting it trips the bwrap wrap that
    // can't run in this container). The loop resolves the repo from the
    // configured `repoPath` setting; the artifact dir falls back to cwd.
    originalCwd = process.cwd();
    process.chdir(projectRoot);
    await seedRepo(projectRoot);
    state = { kv: new Map(), appends: [] };
  });

  afterEach(() => {
    proc?.kill();
    proc = undefined;
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function spawnWired(): ExtensionProcess {
    const extId = "repo-activity-notify-" + Math.random().toString(36).slice(2, 8);
    // Grant shell (the git-cursor check) + filesystem (artifact mirror).
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
      if (req.method === "ezcorp/append-message") {
        state.appends.push(params);
        return ok(req.id, { messageId: `m-${state.appends.length}`, toolCallIds: [] });
      }
      if (req.method === "ezcorp/invoke") {
        const tool = (params as { tool?: string }).tool;
        if (tool === "runtime.settings.getMine") {
          return ok(req.id, { enabled: true, conversationId: "conv-e2e", repoPath: projectRoot });
        }
        if (tool === "runtime.conversations.getMessages") {
          return ok(req.id, {
            messages: [{ id: "seed-msg", role: "user", content: "watch the repo" }],
            projectId: "p1",
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

  test("manual trigger: first run notifies on a new commit; second run skips (no new commits)", async () => {
    proc = spawnWired();
    proc.ensureRunning();
    await new Promise((r) => setTimeout(r, 200)); // let the channel come up

    // ── first manual run → check proceeds → act appends + mirrors ──
    const first = await proc.call("tools/call", {
      name: "check_repo_activity",
      arguments: {},
    });
    const firstText = ((first.result as { content?: { text?: string }[] })?.content?.[0]?.text) ?? "";
    const firstBody = JSON.parse(firstText) as { status?: string; skipped?: boolean; runId?: string };
    expect(firstBody.skipped).toBeUndefined();
    expect(firstBody.status).toBe("done");

    // The run persisted (per-run + index keys) with an appended notice.
    const ids = state.kv.get("loop:repo-activity-notify:index") as string[] | undefined;
    expect(Array.isArray(ids)).toBe(true);
    expect(ids!.length).toBe(1);
    const run = state.kv.get(`loop:repo-activity-notify:run:${ids![0]}`) as
      | { status: string; outcome?: { appended?: boolean; subject?: string } }
      | undefined;
    expect(run?.status).toBe("done");
    expect(run?.outcome?.appended).toBe(true);
    expect(run?.outcome?.subject).toBe("feat: seed the probe repo");

    // The cursor advanced to HEAD.
    const cursor = state.kv.get("loop:repo-activity-notify:cursor") as string | undefined;
    expect(typeof cursor).toBe("string");
    expect(cursor).toMatch(/^[0-9a-f]{40}$/);

    // The one-line notice was appended to the wired conversation.
    expect(state.appends.length).toBe(1);
    expect(state.appends[0]).toMatchObject({
      conversationId: "conv-e2e",
      parentMessageId: "seed-msg",
      role: "extension",
    });
    expect(String(state.appends[0]!.content)).toContain("new commit");

    // The artifact was mirrored under .ezcorp/extension-data/.
    const file = join(projectRoot, ".ezcorp", "extension-data", "repo-activity-notify", "notices", `${ids![0]}.md`);
    let body: string | undefined;
    for (let i = 0; i < 60; i++) {
      if (existsSync(file)) {
        body = readFileSync(file, "utf8");
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(body).toBeDefined();
    expect(body!).toContain("new commit");

    // ── second manual run → check declines (no new commits) → skip ──
    const second = await proc.call("tools/call", {
      name: "check_repo_activity",
      arguments: {},
    });
    const secondText = ((second.result as { content?: { text?: string }[] })?.content?.[0]?.text) ?? "";
    const secondBody = JSON.parse(secondText) as { skipped?: boolean; reason?: string };
    expect(secondBody.skipped).toBe(true);
    expect(secondBody.reason).toBe("no_new_commits");

    // No second run, no second append — the check gate held.
    const idsAfter = state.kv.get("loop:repo-activity-notify:index") as string[] | undefined;
    expect(idsAfter!.length).toBe(1);
    expect(state.appends.length).toBe(1);
  });
});
