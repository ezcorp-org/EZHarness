/**
 * NOTE (Phase 53.6): This file stubs the registry's `getProcess` to return
 * an object with `isRunning: true` hard-coded — the real spawn chain is
 * covered by `bundled-boot-spawn-real-process.test.ts`. Any change to
 * `bootSpawnFlaggedBundledExtensions` MUST keep that third test green.
 *
 * Phase 53 fix-loop coverage — `bootSpawnFlaggedBundledExtensions`.
 *
 * UAT for Phase 53.5 caught two silently-broken event-only extensions:
 *   - memory-extractor (no tools, no manual triggers; `run:complete`
 *     never delivered because subprocess never spawned).
 *   - lessons-distiller (post-Phase-53.3; the legacy host-side listener
 *     was deleted but the bundled handler only fires when the
 *     subprocess happens to be running, which only happened on manual
 *     `!EZ:distill`).
 *
 * The fix: a `bootSpawn: true` flag on `BundledExtension` entries plus
 * a new `bootSpawnFlaggedBundledExtensions` helper that calls
 * `registry.getProcess(extId)` + injected `ensureSubprocessRpcWired`
 * for every flagged entry. This file is the unit-level guard:
 *
 *   1. lessons-distiller is boot-spawned.
 *   2. memory-extractor is boot-spawned.
 *   3. Other bundled extensions WITHOUT `bootSpawn` are NOT spawned
 *      at boot (regression guard — we don't want to suddenly auto-
 *      spawn manual-trigger extensions).
 *   4. A spawn failure for one entry does NOT prevent another flagged
 *      entry from booting (try/catch'd correctly).
 *   5. RPC wiring is invoked alongside spawn (otherwise reverse-RPC
 *      methods like `ezcorp/memory` would error "Method not found"
 *      when memory-extractor's handler runs).
 *   6. A disabled DB row is skipped (operator opt-out is respected).
 *   7. A missing DB row is skipped + logged (degraded but does not
 *      throw — the next boot retries).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionProcess } from "../extensions/subprocess";
import type { ExtensionPermissions } from "../extensions/types";

// ── DB mock — extension store keyed by manifest name ────────────────

interface StoredExtension {
  id: string;
  name: string;
  enabled: boolean;
  manifest?: unknown;
  installPath?: string;
  isBundled?: boolean;
  grantedPermissions?: ExtensionPermissions;
}

let store: Map<string, StoredExtension>;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  updateExtension: async () => null,
  listExtensions: async () => Array.from(store.values()),
}));

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  store = new Map();
});

// ── Lazy import after mocks ─────────────────────────────────────────

const { bootSpawnFlaggedBundledExtensions } = await import("../extensions/bundled");

// ── Registry stub — captures `getProcess` calls ─────────────────────

interface SpawnCall {
  extensionId: string;
}

interface ProcStub {
  extensionId: string;
  isRunning: boolean;
  ensureRunningCalls: number;
  ensureRunning(): void;
}

function makeRegistry(opts: {
  failOn?: Set<string>;
} = {}): {
  spawnCalls: SpawnCall[];
  procStubs: Map<string, ProcStub>;
  registry: ExtensionRegistry;
} {
  const spawnCalls: SpawnCall[] = [];
  const procStubs = new Map<string, ProcStub>();
  const registry = {
    async getProcess(extensionId: string): Promise<ExtensionProcess> {
      spawnCalls.push({ extensionId });
      if (opts.failOn?.has(extensionId)) {
        throw new Error(`spawn refused for ${extensionId}`);
      }
      // Minimal ExtensionProcess stub — `extensionId` is read by the
      // wireRpc callback, `ensureRunning` is invoked by the helper to
      // actually spawn the subprocess (Phase 53.6 fix). The dispatcher
      // path uses sendNotification + isRunning, which the
      // run-complete-dispatch integration test and the real-process
      // regression test exercise separately. Cast through `unknown`
      // because ExtensionProcess has private fields we don't simulate.
      const proc: ProcStub = {
        extensionId,
        isRunning: true,
        ensureRunningCalls: 0,
        ensureRunning() { this.ensureRunningCalls++; },
      };
      procStubs.set(extensionId, proc);
      return proc as unknown as ExtensionProcess;
    },
  } as unknown as ExtensionRegistry;
  return { spawnCalls, procStubs, registry };
}

function makeWireRpc() {
  const calls: Array<{ extensionId: string }> = [];
  const fn = async (extensionId: string, _proc: ExtensionProcess) => {
    calls.push({ extensionId });
  };
  return { calls, fn };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("bootSpawnFlaggedBundledExtensions", () => {
  test("spawns lessons-distiller when its DB row is enabled", async () => {
    // Populate BOTH flagged rows so the test isolates "lessons-distiller
    // got spawned" from the orthogonal "memory-extractor row missing"
    // signal. Each row is checked independently in the helper.
    store.set("lessons-distiller", {
      id: "ext-lessons",
      name: "lessons-distiller",
      enabled: true,
    });
    store.set("memory-extractor", {
      id: "ext-memory",
      name: "memory-extractor",
      enabled: true,
    });
    // ping-loop + github-projects are the other `bootSpawn: true` bundled
    // entries. Populate their rows too so `failed[]` stays empty (a missing
    // row would otherwise record them as failed, drowning the
    // lessons-distiller signal).
    store.set("ping-loop", {
      id: "ext-ping",
      name: "ping-loop",
      enabled: true,
    });
    store.set("github-projects", {
      id: "ext-gh",
      name: "github-projects",
      enabled: true,
    });

    const { spawnCalls, registry } = makeRegistry();
    const { calls: wireCalls, fn: wireRpc } = makeWireRpc();

    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    expect(spawnCalls.map((c) => c.extensionId)).toContain("ext-lessons");
    expect(wireCalls.map((c) => c.extensionId)).toContain("ext-lessons");
    expect(result.spawned).toContain("lessons-distiller");
    expect(result.failed).toEqual([]);
  });

  test("spawns memory-extractor when its DB row is enabled", async () => {
    store.set("lessons-distiller", {
      id: "ext-lessons",
      name: "lessons-distiller",
      enabled: true,
    });
    store.set("memory-extractor", {
      id: "ext-memory",
      name: "memory-extractor",
      enabled: true,
    });

    // Other `bootSpawn: true` bundled entries — populate so `failed[]` stays
    // empty (mirrors the lessons-distiller test above).
    store.set("ping-loop", {
      id: "ext-ping",
      name: "ping-loop",
      enabled: true,
    });
    store.set("github-projects", {
      id: "ext-gh",
      name: "github-projects",
      enabled: true,
    });

    const { spawnCalls, registry } = makeRegistry();
    const { calls: wireCalls, fn: wireRpc } = makeWireRpc();

    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    expect(spawnCalls.map((c) => c.extensionId)).toContain("ext-memory");
    expect(wireCalls.map((c) => c.extensionId)).toContain("ext-memory");
    expect(result.spawned).toContain("memory-extractor");
    expect(result.failed).toEqual([]);
  });

  test("spawns BOTH flagged extensions when both rows exist", async () => {
    store.set("lessons-distiller", {
      id: "ext-lessons",
      name: "lessons-distiller",
      enabled: true,
    });
    store.set("memory-extractor", {
      id: "ext-memory",
      name: "memory-extractor",
      enabled: true,
    });

    const { spawnCalls, registry } = makeRegistry();
    const { fn: wireRpc } = makeWireRpc();

    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    const ids = spawnCalls.map((c) => c.extensionId).sort();
    expect(ids).toEqual(["ext-lessons", "ext-memory"]);
    expect(result.spawned.sort()).toEqual([
      "lessons-distiller",
      "memory-extractor",
    ]);
  });

  test("does NOT spawn bundled extensions WITHOUT bootSpawn (regression guard)", async () => {
    // Populate every bundled extension's DB row, including the
    // manual-trigger / on-mention-wired ones that MUST stay lazy.
    const allBundled = [
      "lessons-distiller",
      "memory-extractor",
      "scratchpad",
      "task-tracking",
      "orchestration",
      "ask-user",
      "project-analyzer",
      "markdown-utils",
      "code-review-delegator",
      "github-stats",
      "multi-agent-orchestrator",
      "research-agent",
      "file-refactor",
      "log-analyzer",
      "todo-tracker",
      "ai-kit",
      "web-search",
      "openai-image-gen-2",
      "claude-design",
      "kokoro-tts",
    ];
    for (const name of allBundled) {
      store.set(name, { id: `ext-${name}`, name, enabled: true });
    }

    const { spawnCalls, registry } = makeRegistry();
    const { fn: wireRpc } = makeWireRpc();

    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    // Only the two flagged extensions should have been spawned.
    const spawnedIds = spawnCalls.map((c) => c.extensionId).sort();
    expect(spawnedIds).toEqual(["ext-lessons-distiller", "ext-memory-extractor"]);
    expect(result.spawned.sort()).toEqual([
      "lessons-distiller",
      "memory-extractor",
    ]);
    // Specifically: scratchpad / task-tracking / orchestration / ai-kit
    // must NOT be in the spawn list. They have explicit manual triggers
    // or wire-on-first-use semantics; auto-spawning them at boot would
    // change behaviour for every install.
    for (const lazyName of ["scratchpad", "task-tracking", "orchestration", "ai-kit"]) {
      expect(result.spawned).not.toContain(lazyName);
    }
  });

  test("a spawn failure for one entry does not block others", async () => {
    store.set("lessons-distiller", {
      id: "ext-lessons",
      name: "lessons-distiller",
      enabled: true,
    });
    store.set("memory-extractor", {
      id: "ext-memory",
      name: "memory-extractor",
      enabled: true,
    });

    // ping-loop + github-projects are the other `bootSpawn: true` entries;
    // give them clean enabled rows + passing spawns so this test isolates the
    // lessons-distiller failure from the orthogonal entries.
    store.set("ping-loop", {
      id: "ext-ping",
      name: "ping-loop",
      enabled: true,
    });
    store.set("github-projects", {
      id: "ext-gh",
      name: "github-projects",
      enabled: true,
    });

    const { spawnCalls, registry } = makeRegistry({
      failOn: new Set(["ext-lessons"]),
    });
    const { calls: wireCalls, fn: wireRpc } = makeWireRpc();

    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    // All flagged spawns were attempted; one failed.
    expect(spawnCalls.map((c) => c.extensionId).sort()).toEqual([
      "ext-gh",
      "ext-lessons",
      "ext-memory",
      "ext-ping",
    ]);
    // RPC wiring ran for the surviving spawns.
    expect(wireCalls.map((c) => c.extensionId).sort()).toEqual([
      "ext-gh",
      "ext-memory",
      "ext-ping",
    ]);
    expect(result.spawned.sort()).toEqual([
      "github-projects",
      "memory-extractor",
      "ping-loop",
    ]);
    expect(result.failed).toEqual(["lessons-distiller"]);
  });

  test("disabled DB row is skipped (no spawn, no failure)", async () => {
    store.set("lessons-distiller", {
      id: "ext-lessons",
      name: "lessons-distiller",
      enabled: false, // operator-disabled
    });
    store.set("memory-extractor", {
      id: "ext-memory",
      name: "memory-extractor",
      enabled: true,
    });
    // Other `bootSpawn: true` entries — enabled, so they spawn alongside
    // memory-extractor. Keeps `failed[]` empty (a missing row would
    // register as a failure and break the operator-opt-out assertion).
    store.set("ping-loop", {
      id: "ext-ping",
      name: "ping-loop",
      enabled: true,
    });
    store.set("github-projects", {
      id: "ext-gh",
      name: "github-projects",
      enabled: true,
    });

    const { spawnCalls, registry } = makeRegistry();
    const { fn: wireRpc } = makeWireRpc();

    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    expect(spawnCalls.map((c) => c.extensionId).sort()).toEqual([
      "ext-gh",
      "ext-memory",
      "ext-ping",
    ]);
    expect(result.spawned.sort()).toEqual([
      "github-projects",
      "memory-extractor",
      "ping-loop",
    ]);
    // Disabled is not a failure — operator opt-out is respected.
    // Only the missing/spawn-error paths populate `failed[]`. A
    // disabled row produces no entry on either list.
    expect(result.failed).toEqual([]);
    expect(result.spawned).not.toContain("lessons-distiller");
  });

  test("missing DB row is recorded in failed[] (install must have failed earlier)", async () => {
    // No flagged extension has a DB row — `ensureBundledExtensions`
    // must have errored on install. Boot-spawn degrades gracefully.
    // Every `bootSpawn: true` entry (lessons-distiller, memory-extractor,
    // ping-loop, github-projects) lands in failed[].
    const { spawnCalls, registry } = makeRegistry();
    const { fn: wireRpc } = makeWireRpc();

    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    expect(spawnCalls).toEqual([]);
    expect(result.spawned).toEqual([]);
    expect(result.failed.sort()).toEqual([
      "github-projects",
      "lessons-distiller",
      "memory-extractor",
      "ping-loop",
    ]);
  });

  test("RPC wiring is invoked AFTER spawn for each successful entry", async () => {
    // Asserts the ordering invariant: getProcess must complete before
    // ensureSubprocessRpcWired runs (the latter receives the proc handle
    // returned by the former).
    store.set("lessons-distiller", {
      id: "ext-lessons",
      name: "lessons-distiller",
      enabled: true,
    });

    const order: string[] = [];
    const registry = {
      async getProcess(extensionId: string): Promise<ExtensionProcess> {
        order.push(`spawn:${extensionId}`);
        return {
          extensionId,
          isRunning: true,
          ensureRunning() { order.push(`ensureRunning:${extensionId}`); },
        } as unknown as ExtensionProcess;
      },
    } as unknown as ExtensionRegistry;
    const wireRpc = async (extensionId: string, _proc: ExtensionProcess) => {
      order.push(`wire:${extensionId}`);
    };

    await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    // Order invariant: getProcess() (constructs the wrapper) MUST run
    // before ensureRunning() (actually spawns the subprocess), which
    // MUST run before wireRpc() (installs reverse-RPC handlers).
    // Spawn-then-wire is intentional — see bundled.ts JSDoc.
    expect(order).toEqual([
      "spawn:ext-lessons",
      "ensureRunning:ext-lessons",
      "wire:ext-lessons",
    ]);
  });

  // ── Phase 53.6 — explicit `ensureRunning` coverage ──────────────────
  //
  // The pre-existing tests above exercise the helper through a stub
  // registry whose `getProcess` returns `{ isRunning: true }`. That
  // accidentally masked a production bug for two phases: the helper
  // never actually called `proc.ensureRunning()`, so in production
  // (where `getProcess` only constructs the wrapper) `proc.proc`
  // stayed `null`, `isRunning` was `false`, and the dispatcher's
  // `getProcessIfRunning` silently dropped every event.
  //
  // The real-process regression test in
  // `bundled-boot-spawn-real-process.test.ts` covers the end-to-end
  // chain. The test below is the unit-level guard: assert that the
  // helper invokes `ensureRunning()` exactly once per successful entry
  // (idempotent contract on the proc side, but the helper should call
  // it deterministically — not skip it on retry, not call it twice).

  test("calls proc.ensureRunning() exactly once per successful entry (Phase 53.6 fix)", async () => {
    store.set("lessons-distiller", {
      id: "ext-lessons",
      name: "lessons-distiller",
      enabled: true,
    });
    store.set("memory-extractor", {
      id: "ext-memory",
      name: "memory-extractor",
      enabled: true,
    });

    const { procStubs, registry } = makeRegistry();
    const { fn: wireRpc } = makeWireRpc();

    await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    // Both flagged extensions must have ensureRunning called exactly
    // once. Calling it twice would be wasteful (it's idempotent — but
    // a second call would mean the helper double-spawns); calling it
    // zero times is the regression we're guarding against.
    expect(procStubs.get("ext-lessons")?.ensureRunningCalls).toBe(1);
    expect(procStubs.get("ext-memory")?.ensureRunningCalls).toBe(1);
  });

  test("does NOT call ensureRunning() when getProcess throws (Phase 53.6 fix)", async () => {
    // If getProcess fails, the proc stub is never returned, so
    // ensureRunning can't run. The try/catch around the spawn-then-wire
    // block should swallow the throw without touching the (nonexistent)
    // proc handle. Belt-and-suspenders against a future refactor that
    // moves ensureRunning out of the try block.
    store.set("lessons-distiller", {
      id: "ext-lessons",
      name: "lessons-distiller",
      enabled: true,
    });

    const { procStubs, registry } = makeRegistry({
      failOn: new Set(["ext-lessons"]),
    });
    const { fn: wireRpc } = makeWireRpc();

    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    // No proc stub recorded for the failing entry (getProcess threw
    // before the stub was constructed).
    expect(procStubs.get("ext-lessons")).toBeUndefined();
    expect(result.failed).toContain("lessons-distiller");
  });

  // ── Phase 53.7 — persistent:true regression guard ───────────────────
  //
  // Commit `70f1d5c` set `persistent: true` on both bundled extensions'
  // manifests so the subprocess wrapper doesn't idle-out the
  // boot-spawned process after 5 minutes (which would silently re-
  // introduce the dropped-event bug). Without `persistent: true` the
  // ExtensionProcess would shut down on its idle timer between
  // `run:complete` events, the dispatcher's `getProcessIfRunning` would
  // start returning null again, and we'd be back to the silent-drop
  // scenario this whole milestone exists to fix. Lock the flag in.
  test("lessons-distiller + memory-extractor manifests declare persistent:true (regression guard for 70f1d5c)", async () => {
    const distillerManifest = (await import(
      "../../extensions/lessons-distiller/ezcorp.config.ts"
    )).default;
    const extractorManifest = (await import(
      "../../extensions/memory-extractor/ezcorp.config.ts"
    )).default;
    expect((distillerManifest as { persistent?: boolean }).persistent).toBe(true);
    expect((extractorManifest as { persistent?: boolean }).persistent).toBe(true);
  });

  test("a thrown ensureRunning is recorded in failed[] (Phase 53.6)", async () => {
    // Symmetric to the getProcess-throws case above: if the wrapper is
    // constructed but `ensureRunning()` itself throws (e.g. spawn ENOENT
    // on the entrypoint), the helper's try/catch must classify the
    // entry as failed[] — NOT spawned[]. Without this guard a future
    // refactor that moves ensureRunning out of the try block would
    // silently mark a non-running proc as spawned.
    store.set("lessons-distiller", {
      id: "ext-lessons",
      name: "lessons-distiller",
      enabled: true,
    });

    const registry = {
      async getProcess(_extensionId: string): Promise<ExtensionProcess> {
        return {
          isRunning: false,
          ensureRunning() { throw new Error("spawn ENOENT"); },
        } as unknown as ExtensionProcess;
      },
    } as unknown as ExtensionRegistry;
    const { fn: wireRpc } = makeWireRpc();

    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    expect(result.failed).toContain("lessons-distiller");
    expect(result.spawned).not.toContain("lessons-distiller");
  });
});
