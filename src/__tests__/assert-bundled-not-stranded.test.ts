/**
 * `assertBundledNotStranded` — the startup health signal for bundled
 * extensions left disabled-pending-re-approval.
 *
 * The state it reports is a SILENT TOTAL OUTAGE for the extension (its
 * tools register nowhere, so no agent can call them) that previously
 * announced itself as one buried `info` line per boot. `web-search` sat
 * that way for days on the live host.
 *
 * Contract:
 *   - Installed + `enabled=false` ⇒ stranded, and the aggregate WARN
 *     fires ONCE listing them.
 *   - All enabled ⇒ no warning at all (no boot-time spam).
 *   - It REPORTS, never remediates — a fail-closed S9 disable is awaiting
 *     human consent and auto-enabling would defeat the gate.
 *   - Missing row / lookup throw are classified, never fatal.
 *   - Env opt-out entries are out of scope (they're not "stranded").
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Captured log lines ──────────────────────────────────────────────
// The real logger writes warn lines as JSON to process.stderr. Capture
// stderr rather than mock.module("../logger") — Bun's loader-cache
// ordering makes a logger module-mock unreliable here (the SUT binds
// `logger.child()` at its own module-load time, before this file's mock
// could win), and stderr-capture pins the EXACT emitted string, which is
// what these assertions are about. Same reasoning + pattern as
// `assert-critical-extensions-error-branches.test.ts`.
interface LogLine {
  level: string;
  msg: string;
  stranded?: string[];
}
const lines: LogLine[] = [];
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
            stranded?: string[];
          };
          if (
            (parsed.level === "error" || parsed.level === "warn") &&
            typeof parsed.msg === "string" &&
            parsed.subsystem === "startup/assert-bundled-not-stranded"
          ) {
            lines.push({
              level: parsed.level,
              msg: parsed.msg,
              ...(parsed.stranded ? { stranded: parsed.stranded } : {}),
            });
          }
        } catch {
          // Non-JSON stderr noise — ignore.
        }
      }
      return true;
    }) as typeof process.stderr.write,
  );
}

// ── Bundled entry list + extension rows ─────────────────────────────
let entries: Array<{ name: string; path: string }>;
mock.module("../extensions/bundled", () => ({
  resolveBundledExtensions: () => entries,
}));

let rows: Map<string, { id: string; enabled: boolean } | null>;
let lookupThrowsFor: Set<string>;
const updateCalls: string[] = [];
mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => {
    if (lookupThrowsFor.has(name)) throw new Error("db down");
    return rows.get(name) ?? null;
  },
  updateExtension: async (id: string) => {
    updateCalls.push(id);
    return null;
  },
}));

afterAll(() => restoreModuleMocks());

afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = null;
});

beforeEach(() => {
  lines.length = 0;
  updateCalls.length = 0;
  captureStderr();
  entries = [
    { name: "web-search", path: "docs/extensions/examples/web-search" },
    { name: "scratchpad", path: "docs/extensions/examples/scratchpad" },
  ];
  rows = new Map([
    ["web-search", { id: "ext-ws", enabled: true }],
    ["scratchpad", { id: "ext-sp", enabled: true }],
  ]);
  lookupThrowsFor = new Set();
});

function warnings(): LogLine[] {
  return lines.filter((l) => l.level === "warn");
}

describe("assertBundledNotStranded", () => {
  test("all enabled → no stranded, and NO warning (no boot spam)", async () => {
    const { assertBundledNotStranded } = await import(
      "../startup/assert-bundled-not-stranded"
    );
    const r = await assertBundledNotStranded();

    expect(r.stranded).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(r.checked).toEqual(["web-search", "scratchpad"]);
    expect(warnings()).toEqual([]);
  });

  test("a disabled bundled row is reported as stranded", async () => {
    rows.set("web-search", { id: "ext-ws", enabled: false });
    const { assertBundledNotStranded } = await import(
      "../startup/assert-bundled-not-stranded"
    );
    const r = await assertBundledNotStranded();

    expect(r.stranded).toEqual(["web-search"]);
    const w = warnings();
    expect(w).toHaveLength(1);
    // The line must say what the operator LOSES and how to fix it —
    // that's the whole point vs the old buried info line.
    expect(w[0]!.msg).toContain("pending admin re-approval");
    expect(w[0]!.msg).toContain("reapprove-drift");
    expect(w[0]!.stranded).toEqual(["web-search"]);
  });

  test("reports but NEVER remediates — the S9 disable awaits human consent", async () => {
    rows.set("web-search", { id: "ext-ws", enabled: false });
    const { assertBundledNotStranded } = await import(
      "../startup/assert-bundled-not-stranded"
    );
    await assertBundledNotStranded();

    expect(updateCalls).toEqual([]);
    expect(rows.get("web-search")!.enabled).toBe(false);
  });

  test("several stranded extensions collapse into ONE aggregate line", async () => {
    rows.set("web-search", { id: "ext-ws", enabled: false });
    rows.set("scratchpad", { id: "ext-sp", enabled: false });
    const { assertBundledNotStranded } = await import(
      "../startup/assert-bundled-not-stranded"
    );
    const r = await assertBundledNotStranded();

    expect(r.stranded).toEqual(["web-search", "scratchpad"]);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.msg).toContain("2 bundled extension(s)");
  });

  test("a missing row is classified, not counted as stranded", async () => {
    rows.set("scratchpad", null);
    const { assertBundledNotStranded } = await import(
      "../startup/assert-bundled-not-stranded"
    );
    const r = await assertBundledNotStranded();

    expect(r.missing).toEqual(["scratchpad"]);
    expect(r.stranded).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  test("a lookup failure is non-fatal and lands in `unknown`", async () => {
    lookupThrowsFor.add("scratchpad");
    const { assertBundledNotStranded } = await import(
      "../startup/assert-bundled-not-stranded"
    );
    const r = await assertBundledNotStranded();

    expect(r.unknown).toEqual(["scratchpad"]);
    expect(r.stranded).toEqual([]);
    // The per-extension lookup warning fires, but not the aggregate one.
    const w = warnings();
    expect(w).toHaveLength(1);
    expect(w[0]!.msg).toContain("lookup failed");
  });

  test("env opt-out entries are out of scope entirely", async () => {
    // resolveBundledExtensions already filters them, so a disabled row
    // for a name that isn't in the resolved list must not be reported.
    entries = [{ name: "scratchpad", path: "docs/extensions/examples/scratchpad" }];
    rows.set("web-search", { id: "ext-ws", enabled: false });
    const { assertBundledNotStranded } = await import(
      "../startup/assert-bundled-not-stranded"
    );
    const r = await assertBundledNotStranded();

    expect(r.checked).toEqual(["scratchpad"]);
    expect(r.stranded).toEqual([]);
    expect(warnings()).toEqual([]);
  });
});
