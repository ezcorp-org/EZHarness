/**
 * REVIEW HARNESS — real-subprocess end-to-end run of the bundled
 * `lessons-distiller` extension.
 *
 * Every existing distiller test swaps the module-level `runtimeApi` seam
 * (`_setRuntimeApiForTests`), so the real wire path — defineLoop's
 * `run:complete` registration, the reverse-RPC frames, the settings
 * fetch, the LLM call, `ctx.lessons.write` — is never exercised.
 *
 * This test spawns `extensions/lessons-distiller/index.ts` as a REAL
 * subprocess (same transport the host uses) and answers its reverse-RPC
 * from an in-process host mimic, recording every frame. It asserts the
 * auto-distill path actually reaches `ezcorp/lessons` with the parsed
 * lesson.
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

import { ExtensionProcess } from "../extensions/subprocess";
import type { JsonRpcResponse } from "../extensions/types";

const ENTRYPOINT = join(
  import.meta.dir,
  "..",
  "..",
  "extensions",
  "lessons-distiller",
  "index.ts",
);

const CONV_ID = "conv-distill-1";
const PROJECT_ID = "proj-1";

interface HostState {
  kv: Map<string, unknown>;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  settings: Record<string, unknown>;
  gate: { shouldDistill: boolean; reason?: string };
  llmContent: string;
  written: Array<Record<string, unknown>>;
}

function makeEnv(extensionId: string): Record<string, string> {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  mkdirSync(extTmpDir, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    TMPDIR: extTmpDir,
  };
}

function ok(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id as JsonRpcResponse["id"], result };
}

function handleStorage(state: HostState, params: Record<string, unknown>): unknown {
  const action = params.action as string;
  const key = params.key as string;
  switch (action) {
    case "get":
      return state.kv.has(key)
        ? { value: state.kv.get(key), exists: true }
        : { value: null, exists: false };
    case "set":
      state.kv.set(key, JSON.parse(JSON.stringify(params.value)));
      return { ok: true, sizeBytes: 0 };
    case "delete":
      return { deleted: state.kv.delete(key) };
    case "list": {
      const prefix = (params.prefix as string) ?? "";
      return { keys: [...state.kv.keys()].filter((k) => k.startsWith(prefix)) };
    }
    default:
      return { ok: true };
  }
}

function wireHost(proc: ExtensionProcess, state: HostState): void {
  proc.setRequestHandler(async (req): Promise<JsonRpcResponse> => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    state.calls.push({ method: req.method, params });

    if (req.method === "ezcorp/storage") return ok(req.id, handleStorage(state, params));

    if (req.method === "ezcorp/invoke") {
      const tool = params.tool as string;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (tool === "runtime.settings.getMine") return ok(req.id, state.settings);
      if (tool === "runtime.conversations.getMessages") {
        if (args.conversationId !== CONV_ID) {
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32604, message: "conversationId must match current conversation" },
          };
        }
        return ok(req.id, {
          messages: [
            { id: "m1", role: "user", content: "no, use bun not npm here" },
            { id: "m2", role: "assistant", content: "understood — switching to bun" },
          ],
          projectId: PROJECT_ID,
        });
      }
      if (tool === "runtime.lessons.triggerGate") return ok(req.id, state.gate);
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `no invoke handler: ${tool}` },
      };
    }

    if (req.method === "ezcorp/llm-complete") {
      return ok(req.id, {
        content: state.llmContent,
        blocks: [],
        usage: { input: 10, output: 20 },
        finishReason: "stop",
        model: "gemini-2.0-flash-lite",
      });
    }

    if (req.method === "ezcorp/lessons") {
      const action = params.action as string;
      if (action === "write") {
        const input = params.input as Record<string, unknown>;
        state.written.push(input);
        return ok(req.id, {
          lesson: {
            id: `lesson-${state.written.length}`,
            slug: input.slug,
            title: input.title,
            body: input.body,
            visibility: "user",
            frontmatter: input.frontmatter ?? null,
          },
          created: true,
        });
      }
      return ok(req.id, { ok: true });
    }

    // Anything else (fs writes for the artifact mirror, loop events, …)
    // answers permissively so a miss doesn't look like a distiller bug.
    return ok(req.id, { ok: true });
  });
}

async function start(state: HostState): Promise<ExtensionProcess> {
  const extId = "lessons-distiller-e2e-" + Math.random().toString(36).slice(2, 8);
  const proc = new ExtensionProcess(extId, ENTRYPOINT, makeEnv(extId), {
    persistent: true,
    callTimeoutMs: 15_000,
  });
  wireHost(proc, state);
  proc.ensureRunning();
  // Force the channel up so the following notification lands on a
  // reading stdin (mirrors the loop integration test's warm-up).
  await proc.callTool("distill_now", { conversationId: "" }).catch(() => undefined);
  return proc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const GOOD_LESSON = JSON.stringify({
  slug: "prefer-bun-over-npm",
  title: "Use bun, not npm, in this project",
  body: "The project standardises on bun. Reach for `bun install` / `bun run`.",
  frontmatter: { trigger: ["package manager choice"], applies_to: ["tool:bun"], confidence: "high" },
});

describe("lessons-distiller — real subprocess auto-distill", () => {
  let proc: ExtensionProcess | undefined;
  let state: HostState;

  beforeEach(() => {
    state = {
      kv: new Map(),
      calls: [],
      settings: { enabled: true, provider: "google", model: "" },
      gate: { shouldDistill: true, reason: "trigger-fired" },
      llmContent: GOOD_LESSON,
      written: [],
    };
  });

  afterEach(() => {
    proc?.kill();
    proc = undefined;
  });

  test("run:complete on a successful chat run writes a lesson", async () => {
    proc = await start(state);
    proc.sendNotification("ezcorp/event/run:complete", {
      conversationId: CONV_ID,
      run: { id: "run-1", agentName: "chat", status: "success" },
    });

    await waitFor(() => state.written.length > 0, 8000);

    expect(state.written.length).toBe(1);
    expect(state.written[0]).toMatchObject({
      slug: "prefer-bun-over-npm",
      projectId: PROJECT_ID,
      visibility: "user",
    });

    // The LLM call must carry the distiller's system prompt + the
    // formatted conversation slice.
    const llmCall = state.calls.find((c) => c.method === "ezcorp/llm-complete");
    expect(llmCall).toBeDefined();
    expect(String(llmCall?.params.systemPrompt)).toContain("lessons-keeper");
    expect(JSON.stringify(llmCall?.params.messages)).toContain("no, use bun not npm here");

    // FINDING (artifact mirror): `defineDistillLoop`'s `log.artifact`
    // claims to mirror the lesson to
    // `.ezcorp/extension-data/distill/lessons/<slug>.md`, but the SDK's
    // `fsWrite` throws client-side (`EZCORP_FS_ALLOWED !== "1"` — the
    // distiller has no `filesystem` grant) and `runTerminalLog`
    // swallows it. No fs RPC is ever attempted.
    await waitFor(() => state.calls.some((c) => c.method.startsWith("ezcorp/fs")), 1500);
    expect(state.calls.filter((c) => c.method.startsWith("ezcorp/fs"))).toEqual([]);

    // FINDING (redundant reads): the auto path fetches the SAME
    // conversation twice over RPC — `distillRunComplete` for the
    // projectId, then `distill` again for the LLM slice — and does it
    // BEFORE the trigger gate is consulted.
    const invokeTools = state.calls
      .filter((c) => c.method === "ezcorp/invoke")
      .map((c) => c.params.tool);
    expect(invokeTools).toEqual([
      "runtime.settings.getMine",
      "runtime.conversations.getMessages",
      "runtime.conversations.getMessages",
      "runtime.lessons.triggerGate",
    ]);
  }, 20_000);

  test("gate says no → no LLM call, no write", async () => {
    state.gate = { shouldDistill: false, reason: "no-signal" };
    proc = await start(state);
    proc.sendNotification("ezcorp/event/run:complete", {
      conversationId: CONV_ID,
      run: { id: "run-2", agentName: "chat", status: "success" },
    });

    await waitFor(() => state.calls.some((c) => c.method === "ezcorp/lessons"), 3000);
    expect(state.written.length).toBe(0);
    expect(state.calls.find((c) => c.method === "ezcorp/llm-complete")).toBeUndefined();
  }, 20_000);

  test("every subsequent turn on the same conversation pays another LLM call", async () => {
    proc = await start(state);
    for (const runId of ["run-a", "run-b", "run-c"]) {
      proc.sendNotification("ezcorp/event/run:complete", {
        conversationId: CONV_ID,
        run: { id: runId, agentName: "chat", status: "success" },
      });
      // Serialise the fires so the count is deterministic.
      await waitFor(
        () => state.calls.filter((c) => c.method === "ezcorp/llm-complete").length >= 1,
        4000,
      );
      await new Promise((r) => setTimeout(r, 200));
    }
    const llmCalls = state.calls.filter((c) => c.method === "ezcorp/llm-complete").length;
    expect(llmCalls).toBe(3);
    expect(state.written.length).toBe(3);
  }, 30_000);

  test("non-chat and failed runs never distill", async () => {
    proc = await start(state);
    proc.sendNotification("ezcorp/event/run:complete", {
      conversationId: CONV_ID,
      run: { id: "run-x", agentName: "researcher", status: "success" },
    });
    proc.sendNotification("ezcorp/event/run:complete", {
      conversationId: CONV_ID,
      run: { id: "run-y", agentName: "chat", status: "error" },
    });
    await waitFor(() => state.written.length > 0, 2500);
    expect(state.written.length).toBe(0);
  }, 20_000);

  test("LLM returning EMPTY declines cleanly (no write, no crash)", async () => {
    state.llmContent = "EMPTY";
    proc = await start(state);
    proc.sendNotification("ezcorp/event/run:complete", {
      conversationId: CONV_ID,
      run: { id: "run-e", agentName: "chat", status: "success" },
    });
    await waitFor(
      () => state.calls.some((c) => c.method === "ezcorp/llm-complete"),
      6000,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(state.written.length).toBe(0);
    // The subprocess must still be alive and serving tools.
    const res = await proc.callTool("distill_now", { conversationId: "" });
    expect(res.isError).toBe(true);
  }, 20_000);

  test("settings.enabled=false suppresses auto-distill", async () => {
    state.settings = { enabled: false, provider: "google", model: "" };
    proc = await start(state);
    proc.sendNotification("ezcorp/event/run:complete", {
      conversationId: CONV_ID,
      run: { id: "run-3", agentName: "chat", status: "success" },
    });

    await waitFor(() => state.written.length > 0, 3000);
    expect(state.written.length).toBe(0);
    expect(state.calls.find((c) => c.method === "ezcorp/llm-complete")).toBeUndefined();
  }, 20_000);
});
