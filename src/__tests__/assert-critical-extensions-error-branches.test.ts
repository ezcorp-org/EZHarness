import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const rows = new Map<string, { name: string; enabled: boolean; source: string }>();
const writes = mock(async () => { throw new Error("Startup cannot grant approval"); });
const readManifest = mock(async () => { throw new Error("Unreadable source"); });
const logs: Array<{ level: string; message: string; details?: unknown }> = [];
let failingName: string | null = null;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => {
    if (name === failingName) throw new Error("Database unavailable");
    return rows.get(name) ?? null;
  },
  updateExtension: writes,
}));
mock.module("../extensions/loader", () => ({ loadManifestFresh: readManifest }));
mock.module("../logger", () => ({ logger: { child: () => ({
  warn: (message: string, details: unknown) => logs.push({ level: "warn", message, details }),
  error: (message: string, details: unknown) => logs.push({ level: "error", message, details }),
}) } }));
const { assertCriticalExtensions } = await import("../startup/assert-critical-extensions");
const { getCriticalBundledExtensions } = await import("../extensions/bundled");
const { consequenceFor } = await import("../extensions/critical-consequence");

beforeEach(() => {
  rows.clear();
  logs.length = 0;
  failingName = null;
  writes.mockClear();
  readManifest.mockClear();
  for (const { name } of getCriticalBundledExtensions()) {
    rows.set(name, { name, enabled: true, source: "release-v4" });
  }
});
afterAll(() => restoreModuleMocks());

describe("critical startup diagnostics without automatic approval", () => {
  test("unreadable source is never evaluated or automatically enabled", async () => {
    rows.get("ask-user")!.enabled = false;
    const result = await assertCriticalExtensions();
    expect(result.unremediated).toEqual(["ask-user"]);
    expect(result.remediated).toEqual([]);
    expect(rows.get("ask-user")!.enabled).toBe(false);
    expect(readManifest).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  test("database failure is reported while other checks continue", async () => {
    failingName = "ask-user";
    const result = await assertCriticalExtensions();
    expect(result.unremediated).toEqual(["ask-user"]);
    expect(result.violations).toEqual(["ask-user"]);
    expect(result.checked).toContain("task-tracking");
    expect(logs).toEqual([{
      level: "error", message: "Critical extension status unavailable",
      details: { name: "ask-user", error: "Error: Database unavailable" },
    }]);
  });

  test("failed write dependency cannot restore either disabled extension", async () => {
    rows.get("ask-user")!.enabled = false;
    rows.get("task-tracking")!.enabled = false;
    const result = await assertCriticalExtensions();
    expect(result.unremediated).toEqual(expect.arrayContaining(["ask-user", "task-tracking"]));
    expect(result.remediated).toEqual([]);
    expect(rows.get("ask-user")!.enabled).toBe(false);
    expect(rows.get("task-tracking")!.enabled).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });

  for (const name of ["ask-user", "task-tracking"]) {
    test(`${name} reports its own consequence`, async () => {
      rows.get(name)!.enabled = false;
      const result = await assertCriticalExtensions();
      expect(result.unremediated).toEqual([name]);
      expect(logs).toEqual([{
        level: "warn",
        message: `Critical extension ${name} awaits a verified, human-approved release: ${consequenceFor(name)}`,
        details: { name },
      }]);
    });
  }

  test("missing installation reports its consequence without creating a row", async () => {
    rows.delete("task-tracking");
    const result = await assertCriticalExtensions();
    expect(result.unremediated).toEqual(["task-tracking"]);
    expect(logs[0]?.message).toContain(consequenceFor("task-tracking"));
    expect(rows.has("task-tracking")).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });

  test("enabled legacy source does not count as an approved release", async () => {
    rows.get("ask-user")!.source = "bundled";
    const result = await assertCriticalExtensions();
    expect(result.unremediated).toEqual(["ask-user"]);
    expect(result.remediated).toEqual([]);
    expect(readManifest).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });
});
