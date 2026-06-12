/**
 * Phase 5 — Ceiling-clamp POSITIVE integration through
 * `ensureBundledExtensions`. Closes auditor critical #2 (the negative
 * path is exercised by `bundled-ceiling.test.ts`'s "no clamp on real
 * manifests" sweep; this file proves the POSITIVE clamp emit + audit
 * path actually wires through `bundled.ts` — important because future
 * refactors could otherwise silently drop the audit emission).
 *
 * Approach (Option A from the brief): `mock.module` narrows
 * `getCeiling("scratchpad")` to `{ grantedAt: {} }` (empty grant)
 * AT MODULE TOP LEVEL, before any consumer of `bundled-ceiling`
 * resolves its import bindings. Bun's `mock.module` only propagates
 * cleanly when registered before first import — mid-test re-mocks
 * cause hangs on already-bound ESM imports inside `bundled.ts`.
 *
 * Every other bundled name routes through the REAL ceiling so the
 * install sweep's day-1 (a) gate stays green for the rest of the
 * 20 bundled extensions.
 *
 * The real `BUNDLED_EXTENSIONS[scratchpad].permissions` declares
 * `{ storage: true }` — so the install path SHOULD trip the clamp,
 * emit `BUNDLED_CEILING_CLAMP`, and persist an empty grant.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";

// ── audit + db mocks (same shape as bundled-phase5-integration.test.ts) ──

interface CapturedAudit {
  userId: string | null;
  action: string;
  target: string | undefined;
  metadata: Record<string, unknown> | undefined;
}

const auditEntries: CapturedAudit[] = [];

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    userId: string | null,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
  ) => {
    auditEntries.push({ userId, action, target, metadata });
    return `audit-${auditEntries.length}`;
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

interface StoredExtension {
  id: string;
  name: string;
  manifest: unknown;
  installPath: string;
  enabled: boolean;
  consecutiveFailures?: number;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
}

let store: Map<string, StoredExtension>;
let nextId = 0;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  createExtension: async (data: Omit<StoredExtension, "id">) => {
    const id = `ext-${++nextId}`;
    const row = { id, ...data } as StoredExtension;
    store.set(data.name, row);
    return row;
  },
  listExtensions: async () => Array.from(store.values()),
  updateExtension: async (id: string, patch: Partial<StoredExtension>) => {
    for (const row of store.values()) {
      if (row.id === id) {
        Object.assign(row, patch);
        return row;
      }
    }
    return null;
  },
  deleteExtension: async (id: string) => {
    for (const [k, v] of store) if (v.id === id) store.delete(k);
  },
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

// ── ceiling override — TOP LEVEL so bundled.ts's import resolves to it ──
//
// We don't pull in the real ceiling here (that would defeat the
// override). Instead the mock factory uses a hand-built table that
// mirrors `BUNDLED_CEILING` for every extension EXCEPT scratchpad,
// which is set to the empty grant. Hand-mirroring is the simplest
// way to avoid the cyclic-import gotcha (`real.getCeiling` would
// require `bundled-ceiling` to be loaded, and that's the very module
// we're replacing).
//
// The list MUST stay in sync with `bundled.ts:BUNDLED_EXTENSIONS`.
// If a future PR adds a bundled extension and forgets to update both
// places, this test's day-1 sweep (`every install must succeed`)
// will fire as the new entry has no ceiling row. That's the intended
// failure mode.

mock.module("../extensions/bundled-ceiling", () => {
  const NARROW: Record<string, ExtensionPermissions> = {
    scratchpad: { grantedAt: {} },
    "task-tracking": {
      storage: true,
      taskEvents: true,
      agentConfig: "read",
      spawnAgents: { maxPerHour: 200, maxConcurrent: 10 },
      eventSubscriptions: ["task:assignment_update"],
      grantedAt: {},
    },
    orchestration: {
      agentConfig: "read",
      spawnAgents: { maxPerHour: 500, maxConcurrent: 25 },
      eventSubscriptions: ["task:assignment_update"],
      grantedAt: {},
    },
    "ask-user": { eventSubscriptions: ["ask-user:answer"], grantedAt: {} },
    "project-analyzer": { filesystem: ["$CWD"], shell: true, grantedAt: {} },
    "markdown-utils": { grantedAt: {} },
    "code-review-delegator": { grantedAt: {} },
    "github-stats": {
      network: ["api.github.com"],
      env: ["GITHUB_TOKEN"],
      grantedAt: {},
    },
    "multi-agent-orchestrator": { grantedAt: {} },
    "research-agent": { grantedAt: {} },
    "file-refactor": { filesystem: ["$CWD"], grantedAt: {} },
    "log-analyzer": { filesystem: ["$CWD"], grantedAt: {} },
    "todo-tracker": { filesystem: ["$CWD"], shell: true, grantedAt: {} },
    "task-stack": { filesystem: ["$CWD"], grantedAt: {} },
    "ai-kit": {
      network: ["localhost", "127.0.0.1"],
      filesystem: ["$CWD"],
      env: ["EZCORP_BASE_URL", "EZCORP_API_KEY", "EZCORP_SESSION_COOKIE"],
      grantedAt: {},
    },
    "web-search": {
      network: [
        "r.jina.ai",
        "s.jina.ai",
        "api.tavily.com",
        "api.search.brave.com",
        "api.exa.ai",
        "serpapi.com",
        "lite.duckduckgo.com",
        "html.duckduckgo.com",
        "duckduckgo.com",
        "searxng",
        "localhost",
        "127.0.0.1",
      ],
      env: [
        "TAVILY_API_KEY",
        "BRAVE_API_KEY",
        "EXA_API_KEY",
        "SERPAPI_API_KEY",
        "JINA_API_KEY",
        "SEARXNG_BASE_URL",
      ],
      grantedAt: {},
    },
    "openai-image-gen-2": {
      network: ["api.openai.com", "chatgpt.com"],
      env: ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN"],
      filesystem: ["$CWD"],
      grantedAt: {},
    },
    "property-intelligence-agent": { filesystem: ["$CWD"], grantedAt: {} },
    "claude-design": {
      filesystem: ["$CWD"],
      storage: true,
      eventSubscriptions: [
        "claude-design:knob-change",
        "claude-design:brief-answer",
      ],
      network: ["cdn.jsdelivr.net"],
      grantedAt: {},
    },
    excel: { grantedAt: {} },
    "kokoro-tts": {
      eventSubscriptions: ["kokoro-tts:speak", "kokoro-tts:save"],
      appendMessages: { excludedDefault: true },
      grantedAt: {},
    },
  };

  const getCeiling = (name: string): ExtensionPermissions | null =>
    NARROW[name] ?? null;

  // Inline, deterministic clamp: deep-equality on canonical JSON. For
  // the production helper we'd reuse `intersectPermissions`, but the
  // test only needs the EMIT contract — that the install path sees
  // a `clamped: true` for scratchpad. Keep this self-contained to
  // avoid the cyclic-import problem that hangs Bun's resolver.
  const clampToBundledCeiling = (
    name: string,
    requested: ExtensionPermissions,
  ): { effective: ExtensionPermissions; clamped: boolean } => {
    const ceiling = getCeiling(name);
    if (!ceiling) return { effective: requested, clamped: false };
    // For scratchpad (the only entry we narrow), the ceiling has no
    // permission keys — every requested permission gets dropped.
    // For all other entries the NARROW table mirrors the real
    // BUNDLED_CEILING, so the legitimate manifest grants pass
    // through unchanged.
    if (name === "scratchpad") {
      const clamped = JSON.stringify(requested) !== JSON.stringify({ grantedAt: requested.grantedAt ?? {} });
      return { effective: { grantedAt: {} }, clamped };
    }
    // Pass-through for every other bundled name.
    return { effective: requested, clamped: false };
  };

  return {
    BUNDLED_CEILING: NARROW,
    getCeiling,
    clampToBundledCeiling,
  };
});

// `restoreModuleMocks()` re-registers the real `bundled-ceiling` /
// `bundled-lock` modules from preload's snapshot — those paths were
// added to `MODULE_PATHS` in helpers/mock-cleanup.ts specifically
// because this file is the first test in the codebase to mock them
// and Bun's mock.module otherwise leaks across files (locking the
// narrowed-ceiling factory into every subsequent test that imports
// `bundled-ceiling`).
afterAll(() => restoreModuleMocks());

const { ensureBundledExtensions } = await import("../extensions/bundled");
const { EXT_AUDIT_ACTIONS } = await import("../extensions/audit-actions");

beforeEach(() => {
  store = new Map();
  nextId = 0;
  auditEntries.length = 0;
});

describe("M2 — narrowed scratchpad ceiling drives the production clamp + audit path", () => {
  test("scratchpad's storage:true install request is clamped to {} and emits BUNDLED_CEILING_CLAMP", async () => {
    await ensureBundledExtensions();

    const scratchpad = store.get("scratchpad");
    expect(scratchpad).toBeDefined();
    // Persisted grant must be the clamped (empty) shape — no storage.
    expect(scratchpad!.grantedPermissions.storage).toBeUndefined();

    // Audit row must exist with the right action + metadata fields.
    const clampRows = auditEntries.filter(
      (r) =>
        r.action === EXT_AUDIT_ACTIONS.BUNDLED_CEILING_CLAMP &&
        r.target === scratchpad!.id,
    );
    expect(clampRows.length).toBe(1);
    const meta = clampRows[0]!.metadata!;
    expect(meta.permission).toBe("ceiling-clamp");
    expect(meta.actor).toBe("system");
    expect(meta.extensionName).toBe("scratchpad");
    expect(meta.requested).toEqual(
      expect.objectContaining({ storage: true }),
    );
    expect(meta.effective).toBeDefined();
    // The effective grant must NOT include storage (clamped to {}).
    expect((meta.effective as ExtensionPermissions).storage).toBeUndefined();
    // Reason text references the extension name.
    expect((meta.reason as string).toLowerCase()).toContain("scratchpad");
    // Ceiling object captured in metadata for forensic chain.
    expect(meta.ceiling).toBeDefined();
  });

  test("non-scratchpad bundled extensions are NOT clamped (NARROW table mirrors real ceiling)", async () => {
    await ensureBundledExtensions();

    // Pick a non-scratchpad extension that DOES request perms — e.g.
    // task-tracking has storage + spawnAgents + eventSubscriptions.
    const taskTracking = store.get("task-tracking");
    expect(taskTracking).toBeDefined();
    expect(taskTracking!.grantedPermissions.storage).toBe(true);
    expect(taskTracking!.grantedPermissions.spawnAgents).toBeDefined();

    // No clamp audit rows for task-tracking.
    const clampRows = auditEntries.filter(
      (r) =>
        r.action === EXT_AUDIT_ACTIONS.BUNDLED_CEILING_CLAMP &&
        r.target === taskTracking!.id,
    );
    expect(clampRows).toEqual([]);
  });
});
