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
 * lesson — and pins the wire COST SHAPE: one conversation read, the
 * trigger gate before the LLM call, and the finished run's scope
 * forwarded to the gate.
 *
 * The mimic answers the reverse-RPC, so it — not the real host — defines
 * gate behaviour here. Assert on the params the extension SENDS.
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
/** `run.startedAt` on the emitted `run:complete` payload — the
 *  dispatcher forwards `AgentRun` unsanitised, so the extension reads
 *  this straight off the wire and forwards it to the trigger gate. */
const RUN_STARTED_AT = 1_700_000_000_000;

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

    // Anything else (loop events, …) answers permissively so a miss
    // doesn't look like a distiller bug.
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
      run: { id: "run-1", agentName: "chat", status: "success", startedAt: RUN_STARTED_AT },
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

    // The distiller writes NO files — it holds no `filesystem` grant and
    // the lesson row in the DB is the source of truth. (The loop used to
    // declare a `log.artifact` mirror that silently never wrote; it is
    // gone.) Give a late fs frame time to show up before asserting none.
    await waitFor(() => state.calls.some((c) => c.method.startsWith("ezcorp/fs")), 1500);
    expect(state.calls.filter((c) => c.method.startsWith("ezcorp/fs"))).toEqual([]);

    // COST SHAPE: settings once (loop primitive), the conversation read
    // ONCE, then the gate. No second read, and nothing billable before
    // the gate has said yes.
    const invokeTools = state.calls
      .filter((c) => c.method === "ezcorp/invoke")
      .map((c) => c.params.tool);
    expect(invokeTools).toEqual([
      "runtime.settings.getMine",
      "runtime.conversations.getMessages",
      "runtime.lessons.triggerGate",
    ]);

    // …and the gate frame precedes the LLM frame on the wire.
    const gateAt = state.calls.findIndex(
      (c) => c.method === "ezcorp/invoke" && c.params.tool === "runtime.lessons.triggerGate",
    );
    const llmAt = state.calls.findIndex((c) => c.method === "ezcorp/llm-complete");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(llmAt).toBeGreaterThan(gateAt);

    // RUN SCOPE: the finished run's id + start time reach the gate, so
    // the host heuristics score that run rather than the whole
    // conversation.
    const gateCall = state.calls.find(
      (c) => c.method === "ezcorp/invoke" && c.params.tool === "runtime.lessons.triggerGate",
    );
    expect(gateCall?.params.arguments).toEqual({
      conversationId: CONV_ID,
      runId: "run-1",
      runStartedAtMs: RUN_STARTED_AT,
    });
  }, 20_000);

  test("gate says no → no LLM call, no write, one conversation read", async () => {
    state.gate = { shouldDistill: false, reason: "no-signal" };
    proc = await start(state);
    proc.sendNotification("ezcorp/event/run:complete", {
      conversationId: CONV_ID,
      run: { id: "run-2", agentName: "chat", status: "success", startedAt: RUN_STARTED_AT },
    });

    await waitFor(() => state.calls.some((c) => c.method === "ezcorp/lessons"), 3000);
    expect(state.written.length).toBe(0);
    expect(state.calls.find((c) => c.method === "ezcorp/llm-complete")).toBeUndefined();
    // A rejected fire is the common case — it must cost exactly ONE
    // message read, not two.
    expect(
      state.calls.filter(
        (c) => c.method === "ezcorp/invoke" && c.params.tool === "runtime.conversations.getMessages",
      ).length,
    ).toBe(1);
  }, 20_000);

  test("every subsequent turn distills under its OWN run scope", async () => {
    proc = await start(state);
    const runIds = ["run-a", "run-b", "run-c"];
    for (const [i, runId] of runIds.entries()) {
      proc.sendNotification("ezcorp/event/run:complete", {
        conversationId: CONV_ID,
        run: {
          id: runId,
          agentName: "chat",
          status: "success",
          startedAt: RUN_STARTED_AT + i * 1000,
        },
      });
      // Serialise the fires so the counts are deterministic.
      await waitFor(() => state.written.length >= i + 1, 6000);
    }

    const llmCalls = state.calls.filter((c) => c.method === "ezcorp/llm-complete").length;
    expect(llmCalls).toBe(3);
    expect(state.written.length).toBe(3);

    // Each fire scopes the gate to the run that just finished — the id
    // and start time differ per turn, which is what lets the host stop
    // re-scoring the whole conversation.
    const gateArgs = state.calls
      .filter((c) => c.method === "ezcorp/invoke" && c.params.tool === "runtime.lessons.triggerGate")
      .map((c) => c.params.arguments);
    expect(gateArgs.length).toBe(3);
    expect(
      [...gateArgs]
        .map((a) => (a as { runId?: string }).runId)
        .sort(),
    ).toEqual(runIds);
    expect(
      new Set(gateArgs.map((a) => (a as { runStartedAtMs?: number }).runStartedAtMs)).size,
    ).toBe(3);
    // Still one message read per fire, never two.
    expect(
      state.calls.filter(
        (c) => c.method === "ezcorp/invoke" && c.params.tool === "runtime.conversations.getMessages",
      ).length,
    ).toBe(3);
  }, 30_000);

  test("non-chat and failed runs never distill", async () => {
    proc = await start(state);
    proc.sendNotification("ezcorp/event/run:complete", {
      conversationId: CONV_ID,
      run: { id: "run-x", agentName: "researcher", status: "success", startedAt: RUN_STARTED_AT },
    });
    proc.sendNotification("ezcorp/event/run:complete", {
      conversationId: CONV_ID,
      run: { id: "run-y", agentName: "chat", status: "error", startedAt: RUN_STARTED_AT },
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
