/**
 * Phase D — `assertCriticalExtensions` error / defense-in-depth
 * branches (isolated).
 *
 * The non-isolated `assert-critical-extensions.test.ts` lets the REAL
 * `loadManifestFresh` run against the real on-disk extension dirs, so
 * the three catch blocks below never fire there. This file injects
 * failures into each dependency in turn to cover them:
 *
 *   1. `loadManifestFresh` throws (disk unreadable) ⇒ ERROR "manifest
 *      unreadable", reported `unremediated`, NOT re-enabled,
 *      `updateExtension` never called.
 *   2. `getExtensionByName` throws (DB lookup fails) ⇒ ERROR "lookup
 *      failed", reported `unremediated`, no crash, loop continues.
 *   3. `updateExtension` throws during remediation (re-enable fails)
 *      ⇒ that ext stays `unremediated`, error logged, loop continues
 *      for the other critical extensions.
 *
 * `mock.module`s `../extensions/loader`, `../db/queries/extensions`
 * and `../logger`; all three are in mock-cleanup's MODULE_PATHS so
 * `restoreModuleMocks()` re-registers the real modules in afterAll
 * (file-scoped — cannot pollute the non-isolated suite).
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

interface Row {
  id: string;
  name: string;
  enabled: boolean;
}

let rows: Map<string, Row>;
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
const auditEntries: Array<{ action: string }> = [];

/** Per-test failure switches (reset in beforeEach). */
let lookupShouldThrow: ((name: string) => boolean) | null = null;
let updateShouldThrow: ((id: string) => boolean) | null = null;
let manifestShouldThrow = false;

interface LogCall {
  level: "error" | "warn";
  msg: string;
}
const logCalls: LogCall[] = [];

// The real logger writes error/warn lines as JSON to process.stderr
// (src/logger.ts). Capture stderr rather than mock.module("../logger")
// — Bun's loader-cache ordering makes a logger module-mock unreliable
// here (the SUT binds `logger.child()` at its own module-load time,
// before this file's mock could win), and stderr-capture pins the
// EXACT emitted message string, which is what nit #1 is about.
let stderrSpy: ReturnType<typeof spyOn> | null = null;

function captureStderr(): void {
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(
    ((chunk: string | Uint8Array): boolean => {
      const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      for (const rawLine of s.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as {
            level?: string;
            msg?: string;
            subsystem?: string;
          };
          if (
            (parsed.level === "error" || parsed.level === "warn") &&
            typeof parsed.msg === "string" &&
            parsed.subsystem === "startup/assert-critical-extensions"
          ) {
            logCalls.push({ level: parsed.level, msg: parsed.msg });
          }
        } catch {
          // Non-JSON stderr noise — ignore.
        }
      }
      return true;
    }) as typeof process.stderr.write,
  );
}

mock.module("../extensions/loader", () => ({
  loadManifestFresh: async () => {
    if (manifestShouldThrow) throw new Error("ENOENT: disk unreadable");
    // Within-ceiling perms so the non-failing path can remediate.
    return {
      schemaVersion: 2,
      name: "stub",
      version: "0.0.1",
      description: "stub",
      author: { name: "EZCorp" },
      permissions: { grantedAt: {} },
    };
  },
}));

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => {
    if (lookupShouldThrow?.(name)) {
      throw new Error("DB lookup failed: connection reset");
    }
    return rows.get(name) ?? null;
  },
  updateExtension: async (id: string, patch: Record<string, unknown>) => {
    if (updateShouldThrow?.(id)) {
      throw new Error("DB write failed: deadlock");
    }
    updateCalls.push({ id, patch });
    for (const r of rows.values()) {
      if (r.id === id) {
        Object.assign(r, patch);
        return r;
      }
    }
    return null;
  },
}));

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (_u: string | null, action: string) => {
    auditEntries.push({ action });
    return "a";
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

const { assertCriticalExtensions } = await import(
  "../startup/assert-critical-extensions"
);
const { getCriticalBundledExtensions } = await import("../extensions/bundled");

afterAll(() => restoreModuleMocks());

const CRITICAL = getCriticalBundledExtensions().map((c) => c.name);

beforeEach(() => {
  rows = new Map();
  updateCalls.length = 0;
  auditEntries.length = 0;
  logCalls.length = 0;
  lookupShouldThrow = null;
  updateShouldThrow = null;
  manifestShouldThrow = false;
  for (const name of CRITICAL) {
    rows.set(name, { id: `id-${name}`, name, enabled: true });
  }
  captureStderr();
});

afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = null;
});

describe("assertCriticalExtensions — error / defense-in-depth branches", () => {
  test("loadManifestFresh throws (disk unreadable) ⇒ unremediated, NOT re-enabled, no updateExtension", async () => {
    // Disable a critical ext so remediation is attempted; force the
    // on-disk manifest read to fail.
    rows.get("ask-user")!.enabled = false;
    manifestShouldThrow = true;

    const r = await assertCriticalExtensions();

    expect(r.violations).toContain("ask-user");
    expect(r.unremediated).toContain("ask-user");
    expect(r.remediated).not.toContain("ask-user");
    // Disable stands — no re-enable attempted.
    expect(rows.get("ask-user")!.enabled).toBe(false);
    expect(
      updateCalls.some((c) => c.id === "id-ask-user"),
    ).toBe(false);
    // No auto-reapproval audit row for the failed-read extension.
    expect(auditEntries.length).toBe(0);
    // ERROR pins the "manifest unreadable" wording.
    expect(
      logCalls.some(
        (l) =>
          l.level === "error" &&
          l.msg.includes("ask-user") &&
          l.msg.includes("on-disk manifest unreadable") &&
          l.msg.includes("NOT auto-re-enabled"),
      ),
    ).toBe(true);
  }, 20_000);

  test("getExtensionByName throws (DB lookup fails) ⇒ unremediated, ERROR 'lookup failed', no crash, loop continues", async () => {
    // ask-user lookup throws; task-tracking lookup is fine and enabled.
    lookupShouldThrow = (name) => name === "ask-user";

    const r = await assertCriticalExtensions();

    expect(r.unremediated).toContain("ask-user");
    // Lookup failure is NOT a "violation" (we never learned its state).
    expect(r.violations).not.toContain("ask-user");
    // The loop kept going: task-tracking was still checked, no-op.
    expect(r.checked).toContain("task-tracking");
    expect(r.violations).not.toContain("task-tracking");
    // No throw escaped (we got a result object).
    expect(Array.isArray(r.unremediated)).toBe(true);
    // The SUT logs the static "lookup failed" message at error level;
    // the extension name lives in the structured `extra`, not `msg`.
    expect(
      logCalls.some(
        (l) =>
          l.level === "error" &&
          l.msg.includes("lookup failed") &&
          l.msg.includes("cannot assert invariant"),
      ),
    ).toBe(true);
  }, 20_000);

  test("updateExtension throws during remediation (re-enable fails) ⇒ stays unremediated, error logged, loop continues for other exts", async () => {
    // Both critical exts disabled + within ceiling ⇒ both reach the
    // remediation `updateExtension` call. Only ask-user's write throws;
    // task-tracking must still be remediated (loop continues).
    rows.get("ask-user")!.enabled = false;
    rows.get("task-tracking")!.enabled = false;
    updateShouldThrow = (id) => id === "id-ask-user";

    const r = await assertCriticalExtensions();

    expect(r.violations).toContain("ask-user");
    expect(r.violations).toContain("task-tracking");
    // ask-user re-enable failed ⇒ unremediated, still disabled.
    expect(r.unremediated).toContain("ask-user");
    expect(r.remediated).not.toContain("ask-user");
    expect(rows.get("ask-user")!.enabled).toBe(false);
    // Loop continued: task-tracking WAS remediated.
    expect(r.remediated).toContain("task-tracking");
    expect(rows.get("task-tracking")!.enabled).toBe(true);
    expect(
      logCalls.some(
        (l) =>
          l.level === "error" &&
          l.msg.includes("ask-user") &&
          l.msg.includes("re-enable failed"),
      ),
    ).toBe(true);
  }, 20_000);

  test("per-extension consequence wording: task-tracking is NOT 'ask the user' (code-reviewer nit #1)", async () => {
    // task-tracking disabled ⇒ ERROR must use the task-tracking
    // consequence, not the copy-pasted ask-user clause.
    rows.get("task-tracking")!.enabled = false;
    // Within-ceiling so it remediates after logging the ERROR.

    await assertCriticalExtensions();

    const ttError = logCalls.find(
      (l) =>
        l.level === "error" &&
        l.msg.includes("task-tracking") &&
        l.msg.includes("disabled"),
    );
    expect(ttError).toBeDefined();
    // Corrected, task-tracking-specific consequence.
    expect(ttError!.msg).toContain(
      "agents cannot self-structure recovery / track multi-step work",
    );
    // The wrong copy-pasted clause must be gone for task-tracking.
    expect(ttError!.msg).not.toContain("ask the user");
  }, 20_000);

  test("per-extension consequence wording: ask-user keeps its specific clause", async () => {
    rows.get("ask-user")!.enabled = false;

    await assertCriticalExtensions();

    const auError = logCalls.find(
      (l) =>
        l.level === "error" &&
        l.msg.includes("ask-user") &&
        l.msg.includes("disabled"),
    );
    expect(auError).toBeDefined();
    expect(auError!.msg).toContain(
      "agents cannot ask the user for clarification",
    );
  }, 20_000);

  test("missing critical extension uses per-extension consequence wording", async () => {
    rows.delete("task-tracking");

    await assertCriticalExtensions();

    const ttError = logCalls.find(
      (l) =>
        l.level === "error" &&
        l.msg.includes("task-tracking") &&
        l.msg.includes("not installed"),
    );
    expect(ttError).toBeDefined();
    expect(ttError!.msg).toContain(
      "agents cannot self-structure recovery / track multi-step work",
    );
    expect(ttError!.msg).not.toContain("ask the user");
  }, 20_000);
});
