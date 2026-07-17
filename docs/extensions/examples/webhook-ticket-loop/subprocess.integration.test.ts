/**
 * webhook-ticket-loop — REAL subprocess e2e (Loops EZ Mode Phase 4).
 *
 * Spawns the example through the real `ExtensionProcess` transport under the
 * production sandbox-preload, then pushes an `ezcorp/webhook-fire` notification
 * exactly as the WebhookDeliveryDaemon does after it claims a delivery. Proves
 * the leg in-process mocks cannot: the delimited UNTRUSTED `WebhookInput`
 * reaches the loop's `check` → `act`, the deterministic priority gate decides
 * proceed/skip, and the terminal run is persisted to the host storage RPC.
 *
 * No route/HTTP here — the accept + auth + persist path is covered by the
 * vitest route test; this file proves the SUBPROCESS half of the pipeline (the
 * daemon's `sendNotification` → the SDK webhook receiver → the loop).
 *
 * Isolated file: the extensions-query module is stubbed BEFORE the subprocess
 * module is imported.
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

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

/** Poll until `predicate()` is true or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

/** The `ezcorp/webhook-fire` wire frame the host daemon pushes after claiming a
 *  delivery — the delimited untrusted wrapper + per-fire metadata. */
function fireFrame(parsed: unknown, deliveryId: string, contentType = "application/json") {
  return {
    slug: "tickets",
    deliveryId,
    receivedAt: "2026-07-16T10:00:00.000Z",
    catchUp: false,
    input: {
      kind: "webhook",
      slug: "tickets",
      untrusted: true,
      contentType,
      body: typeof parsed === "string" ? parsed : JSON.stringify(parsed),
      parsed,
      deliveryId,
      receivedAt: "2026-07-16T10:00:00.000Z",
    },
  };
}

describe("webhook-ticket-loop — real subprocess", () => {
  let proc: ExtensionProcess | undefined;
  let state: HostState;
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `wh-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(projectRoot, ".ezcorp", "extension-data"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(projectRoot);
    state = { kv: new Map() };
  });

  afterEach(() => {
    proc?.kill();
    proc = undefined;
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function spawnWired(settings: Record<string, unknown>): ExtensionProcess {
    const extId = "webhook-ticket-loop-" + Math.random().toString(36).slice(2, 8);
    const env = buildHarnessEnv(extId, { filesystem: true });
    const fsHandler = makeFsRpcHandler(projectRoot);
    const p = new ExtensionProcess(extId, ENTRYPOINT, env, { persistent: true, callTimeoutMs: 20_000 });
    p.setRequestHandler(async (req): Promise<JsonRpcResponse> => {
      const params = (req.params ?? {}) as Record<string, unknown>;
      if (req.method === "ezcorp/storage") return ok(req.id, handleStorage(state, params));
      if (req.method === "ezcorp/invoke") {
        const tool = (params as { tool?: string }).tool;
        if (tool === "runtime.settings.getMine") return ok(req.id, settings);
        return ok(req.id, {});
      }
      const fsRes = fsHandler(req);
      if (fsRes) return fsRes;
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no: ${req.method}` } };
    });
    return p;
  }

  test("high-priority ticket: fire → check proceeds → act persists a terminal run", async () => {
    proc = spawnWired({ enabled: true, min_priority: "high" });
    proc.ensureRunning();
    await new Promise((r) => setTimeout(r, 200));

    proc.sendNotification("ezcorp/webhook-fire", fireFrame({ id: "T-100", priority: "high" }, "del-100"));

    // The delivery id is the run/fire id — wait for the terminal run to persist.
    const persisted = await waitFor(() => state.kv.has("loop:ticket-webhook:run:del-100"));
    expect(persisted).toBe(true);
    const run = state.kv.get("loop:ticket-webhook:run:del-100") as { status: string; outcome: unknown };
    expect(run.status).toBe("done");
    expect(run.outcome).toEqual({ ticketId: "T-100", priority: "high", deliveryId: "del-100" });
  });

  test("low-priority ticket: fire → check declines → NO run persisted (skip journaled)", async () => {
    proc = spawnWired({ enabled: true, min_priority: "high" });
    proc.ensureRunning();
    await new Promise((r) => setTimeout(r, 200));

    proc.sendNotification("ezcorp/webhook-fire", fireFrame({ id: "T-200", priority: "low" }, "del-200"));

    // Wait for the skip to be journaled (the deterministic gate declined).
    const skipped = await waitFor(() => {
      const skips = state.kv.get("loop:ticket-webhook:skips") as Array<{ reason: string }> | undefined;
      return Array.isArray(skips) && skips.some((s) => s.reason === "below_priority_threshold");
    });
    expect(skipped).toBe(true);
    // No terminal run was created for the declined fire.
    expect(state.kv.has("loop:ticket-webhook:run:del-200")).toBe(false);
  });
});
