/**
 * sample-loop — "TRY IT" smoke test / hands-on demo.
 *
 * A REPEATABLE way to watch the Loop SDK primitive work end-to-end. Run:
 *
 *     bun test ./docs/extensions/examples/sample-loop/try-loop.test.ts
 *
 * It spawns the reference `sample-loop` extension through the REAL
 * `ExtensionProcess` transport (production sandbox-preload), fires a
 * `run:complete` event as if a chat just finished, and then prints a
 * human-readable trace of what `defineLoop` did:
 *   1. the event fires the loop's `act`,
 *   2. the host-brokered LLM produces a one-line summary,
 *   3. the primitive persists a run record (per-run + index keys, NOT a
 *      packed blob) via `ezcorp/storage`,
 *   4. the `log.artifact` mirror writes the summary to a git-legible
 *      `.ezcorp/extension-data/summarize/summaries/<runId>.md`.
 *
 * It also ASSERTS each step, so it doubles as a real regression test. The
 * console trace is the "demo"; the `expect`s are the test. Deterministic —
 * the host harness returns fixed messages + summary, so re-runs are stable.
 *
 * (The terser CI cousin is `index.integration.test.ts`; this file is the
 * one to eyeball when you want to SEE the loop run.)
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
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

// What the (mocked) host LLM returns — pick something readable so the trace
// looks like a real summary.
const FAKE_SUMMARY =
  "The user asked how to rotate API keys; the assistant walked through the dashboard flow and the 24h grace window.";
// The conversation the (mocked) host hands back for the finished chat.
const FAKE_MESSAGES = [
  { id: "m1", role: "user", content: "How do I rotate my API keys without downtime?" },
  { id: "m2", role: "assistant", content: "Open Settings → Keys, click Rotate; the old key keeps working for 24h." },
  { id: "m3", role: "user", content: "Perfect, thanks." },
];

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

describe("sample-loop — TRY IT (hands-on demo)", () => {
  let proc: ExtensionProcess | undefined;
  let state: HostState;
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `try-loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
    const env = buildHarnessEnv(extId, { filesystem: true });
    const fsHandler = makeFsRpcHandler(projectRoot);
    const p = new ExtensionProcess(extId, ENTRYPOINT, env, { persistent: true, callTimeoutMs: 15_000 });
    p.setRequestHandler(async (req): Promise<JsonRpcResponse> => {
      const params = (req.params ?? {}) as Record<string, unknown>;
      if (req.method === "ezcorp/storage") return ok(req.id, handleStorage(state, params));
      if (req.method === "ezcorp/llm-complete") {
        return ok(req.id, {
          content: FAKE_SUMMARY,
          blocks: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "stop",
          model: "demo-model",
        });
      }
      if (req.method === "ezcorp/invoke") {
        const tool = (params as { tool?: string }).tool;
        if (tool === "runtime.conversations.getMessages") {
          return ok(req.id, { messages: FAKE_MESSAGES, projectId: "p1" });
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

  test("a finished chat fires the loop → summary run persisted + artifact mirrored", async () => {
    const log = (...a: unknown[]) => console.log("   ", ...a);
    console.log("\n┌─ TRY THE LOOP ───────────────────────────────────────────");
    log("sample-loop: on every run:complete, summarize the chat in one line.");

    proc = spawnWired();
    proc.ensureRunning();
    await new Promise((r) => setTimeout(r, 150)); // let the channel come up

    const conversationId = "conv-demo-1";
    log(`▶  firing  ezcorp/event/run:complete  { conversationId: "${conversationId}" }`);
    proc.sendNotification("ezcorp/event/run:complete", { conversationId });

    // Wait for the primitive to persist the run.
    for (let i = 0; i < 80; i++) {
      const idx = state.kv.get("loop:summarize:index") as string[] | undefined;
      if (Array.isArray(idx) && idx.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const ids = state.kv.get("loop:summarize:index") as string[] | undefined;
    expect(Array.isArray(ids)).toBe(true);
    expect(ids!.length).toBe(1);
    const runId = ids![0];

    // Per-run key — NOT a single packed blob (the §5 race-fix substrate).
    const run = state.kv.get(`loop:summarize:run:${runId}`) as
      | { id: string; status: string; outcome?: { summary?: string }; events?: unknown[] }
      | undefined;
    expect(run?.status).toBe("done");
    expect(run?.outcome?.summary).toBe(FAKE_SUMMARY);

    log("");
    log("✓  RUN PERSISTED (Storage, per-run key)");
    log(`     key      loop:summarize:run:${runId}`);
    log(`     index    loop:summarize:index = [${runId}]`);
    log(`     status   ${run?.status}`);
    log(`     events   ${run?.events?.length ?? 0}`);
    log(`     summary  "${run?.outcome?.summary}"`);

    // Artifact mirror.
    const file = join(projectRoot, ".ezcorp", "extension-data", "summarize", "summaries", `${runId}.md`);
    let body: string | undefined;
    for (let i = 0; i < 60; i++) {
      if (existsSync(file)) {
        body = readFileSync(file, "utf8");
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(body).toBeDefined();
    expect(body!).toContain(FAKE_SUMMARY);

    log("");
    log("✓  ARTIFACT MIRRORED (.ezcorp/extension-data — git-legible)");
    log(`     .ezcorp/extension-data/summarize/summaries/${runId}.md`);
    for (const line of body!.split("\n")) log(`     │ ${line}`);
    console.log("   ✅ loop works end-to-end.");
    console.log("└──────────────────────────────────────────────────────────\n");
  });
});
