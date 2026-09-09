/**
 * Phase D — startup invariant `assertCriticalExtensions`.
 *
 * Root-cause fix #3 backstop: after `ensureBundledExtensions()`, every
 * `critical` bundled extension MUST be enabled, else a stuck agent has
 * no escape hatch.
 *
 *   - all critical enabled ⇒ no-op (no remediation, no ERROR-level
 *     state change).
 *   - a critical extension disabled + on-disk perms within ceiling ⇒
 *     one-time re-enabled + audit row.
 *   - a critical extension disabled + perms exceed ceiling ⇒ stays
 *     disabled (security floor), flagged unremediated.
 *   - a critical extension MISSING ⇒ violation + unremediated.
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

interface Row {
  id: string;
  name: string;
  enabled: boolean;
  source: string;
  disabledByUser?: boolean;
}
const auditEntries: Array<{ action: string; target?: string }> = [];
let rows: Map<string, Row>;
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => rows.get(name) ?? null,
  updateExtension: async (id: string, patch: Record<string, unknown>) => {
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
  insertAuditEntry: async (
    _u: string | null,
    action: string,
    target?: string,
  ) => {
    auditEntries.push({ action, target });
    return "a";
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

const { assertCriticalExtensions } = await import(
  "../startup/assert-critical-extensions"
);
const { getCriticalBundledExtensions } = await import("../extensions/bundled");
// The SAME source the SUT reads its clause from, so the assertion below
// pins the log line to the shared text rather than restating it.
const { consequenceFor } = await import("../extensions/critical-consequence");

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  rows = new Map();
  auditEntries.length = 0;
  updateCalls.length = 0;
});

const CRITICAL = getCriticalBundledExtensions().map((c) => c.name);

function seedAll(enabled: boolean): void {
  for (const name of CRITICAL) {
    rows.set(name, { id: `id-${name}`, name, enabled, source: "release-v4" });
  }
}

describe("getCriticalBundledExtensions", () => {
  test("returns ask-user + task-tracking", () => {
    expect(CRITICAL).toContain("ask-user");
    expect(CRITICAL).toContain("task-tracking");
  });
});

describe("assertCriticalExtensions", () => {
  test("all critical enabled ⇒ no-op (no violations, no remediation)", async () => {
    seedAll(true);
    const r = await assertCriticalExtensions();
    expect(r.violations).toEqual([]);
    expect(r.remediated).toEqual([]);
    expect(updateCalls.length).toBe(0);
    expect(r.checked.sort()).toEqual([...CRITICAL].sort());
  }, 20_000);

  test("disabled critical stays disabled pending human approval even within a legacy ceiling", async () => {
    seedAll(true);
    // Disable ask-user (its real on-disk perms are within ceiling).
    rows.get("ask-user")!.enabled = false;

    const r = await assertCriticalExtensions();

    expect(r.violations).toContain("ask-user");
    expect(r.remediated).toEqual([]);
    expect(r.unremediated).toContain("ask-user");
    expect(rows.get("ask-user")!.enabled).toBe(false);
    expect(
      updateCalls.some(
        (c) => c.id === "id-ask-user" && c.patch.enabled === true,
      ),
    ).toBe(false);
    expect(
      auditEntries.some(
        (a) =>
          a.action === "ext:bundled:critical-auto-reapproved" &&
          a.target === "id-ask-user",
      ),
    ).toBe(false);
  }, 20_000);

  test("missing critical extension ⇒ violation + unremediated, no crash", async () => {
    seedAll(true);
    rows.delete("task-tracking");
    const r = await assertCriticalExtensions();
    expect(r.violations).toContain("task-tracking");
    expect(r.unremediated).toContain("task-tracking");
    // ask-user untouched (was enabled).
    expect(rows.get("ask-user")!.enabled).toBe(true);
  }, 20_000);

  // The ceiling-EXCEEDS branch is covered in the isolated file
  // `assert-critical-extensions-ceiling-exceeds.test.ts` (it must
  // `mock.module` bundled-ceiling, which can't be safely scoped within
  // this multi-test file).
});

// ── The user's own off switch ─────────────────────────────────────────
//
// A critical extension is allowed to be off when the USER turned it off —
// they may run their own replacement for the capability. Re-enabling it
// here would undo that choice on every boot, which is the same bug the
// `disabled_by_user` column fixes in `ensureBundledExtensions`.
//
// It is reported under `userDisabled` rather than `violations` so a caller
// cannot mistake a decision for a fault; the ERROR + remediation still
// belong to every other route to a disabled critical extension.

/**
 * Capture the module's own WARN lines off stderr.
 *
 * The user-opt-out branch REPLACES an ERROR + a remediation with a single
 * log line, and the module header calls that line load-bearing: a silently
 * absent `ask-user` presents as an agent that loops instead of asking, and
 * this is the only thing that connects the two for an operator. Deleting
 * the `log.warn` is therefore a real regression, and without this capture
 * every test here still passes.
 *
 * stderr rather than a logger module-mock, for the reason
 * `assert-bundled-not-stranded.test.ts` documents: the SUT binds
 * `logger.child()` at its own module-load time, before a mock could win.
 */
function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(
    ((chunk: string | Uint8Array): boolean => {
      const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      for (const raw of s.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        try {
          const p = JSON.parse(line) as { level?: string; msg?: string; subsystem?: string };
          if (
            p.level === "warn" &&
            typeof p.msg === "string" &&
            p.subsystem === "startup/assert-critical-extensions"
          ) {
            lines.push(p.msg);
          }
        } catch {
          /* non-JSON stderr noise */
        }
      }
      return true;
    }) as typeof process.stderr.write,
  );
  return { lines, restore: () => spy.mockRestore() };
}

describe("assertCriticalExtensions — user opt-out", () => {
  test("logs ONE warning naming what the loop loses", async () => {
    seedAll(true);
    Object.assign(rows.get("ask-user")!, { enabled: false, disabledByUser: true });

    const cap = captureWarnings();
    try {
      await assertCriticalExtensions();
    } finally {
      cap.restore();
    }

    const mine = cap.lines.filter((l) => l.includes("ask-user"));
    expect(mine).toHaveLength(1);
    // The consequence clause comes from the shared source both this module
    // and the Extensions page's confirm dialog read.
    expect(mine[0]).toContain(consequenceFor("ask-user"));
    expect(mine[0]).toContain("disabled by the user");
  }, 20_000);

  test("a user-disabled critical extension is left alone", async () => {
    seedAll(true);
    Object.assign(rows.get("ask-user")!, { enabled: false, disabledByUser: true });

    const r = await assertCriticalExtensions();

    expect(rows.get("ask-user")!.enabled).toBe(false);
    expect(updateCalls).toEqual([]);
    expect(r.userDisabled).toContain("ask-user");
    // Not a violation, and not remediated — those arrays drive the
    // operator-facing escalation and this is not an incident.
    expect(r.violations).not.toContain("ask-user");
    expect(r.remediated).not.toContain("ask-user");
    expect(r.unremediated).not.toContain("ask-user");
  }, 20_000);

  test("no auto-reapproval audit row for a user opt-out", async () => {
    // The audit trail records a SYSTEM decision to re-enable. Nothing was
    // re-enabled, so writing one would misattribute the user's choice.
    seedAll(true);
    Object.assign(rows.get("task-tracking")!, { enabled: false, disabledByUser: true });

    await assertCriticalExtensions();

    expect(auditEntries).toEqual([]);
  }, 20_000);

  test("the opt-out is per row, not a blanket amnesty", async () => {
    // One critical extension off by choice must not suppress remediation
    // of another that is off for a real reason.
    seedAll(true);
    Object.assign(rows.get("ask-user")!, { enabled: false, disabledByUser: true });
    rows.get("task-tracking")!.enabled = false;

    const r = await assertCriticalExtensions();

    expect(rows.get("ask-user")!.enabled).toBe(false);
    expect(rows.get("task-tracking")!.enabled).toBe(false);
    expect(r.userDisabled).toEqual(["ask-user"]);
    expect(r.unremediated).toContain("task-tracking");
  }, 20_000);
});
