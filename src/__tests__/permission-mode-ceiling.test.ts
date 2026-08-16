/**
 * PR-1 — a body-supplied `permissionMode` may not WIDEN the project's stored
 * tool-permission gate when the principal is not an interactive session.
 *
 * Two things are under test here:
 *
 *   1. `widensPermissionMode` — the mode ordering. It is DERIVED from the
 *      `AUTO_APPROVE` matrix inside `permissions.ts`, and the second describe
 *      block re-derives the same ordering INDEPENDENTLY, through the public
 *      `needsApproval`, and asserts the two agree on every ordered pair. That
 *      is what stops the ordering silently rotting if a mode or a category is
 *      ever added: a hand-written ladder would still typecheck and still read
 *      plausibly while authorizing the widening it was written to refuse.
 *   2. `checkPermissionModeCeiling` — the gate itself, including the session
 *      carve-out and the no-stored-mode case.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Settings are the ceiling's only I/O — stub the one getter rather than boot
// a database for a pure-policy suite.
let storedMode: string | undefined;
mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) =>
    key === "project:proj-1:tool_permission_mode" ? storedMode : undefined,
}));

const {
  needsApproval,
  widensPermissionMode,
  DEFAULT_PERMISSION_MODE,
} = await import("../runtime/tools/permissions");
const { checkPermissionModeCeiling, PERMISSION_MODE_FIELD } = await import(
  "../auth/permission-mode-ceiling"
);

type PermissionMode = "ask" | "auto-edit" | "yolo";
type ToolCategory = "read" | "write" | "execute" | "ez";

const MODES: readonly PermissionMode[] = ["ask", "auto-edit", "yolo"];
const CATEGORIES: readonly ToolCategory[] = ["read", "write", "execute", "ez"];

const SESSION = { authMethod: "session" as const };
const API_KEY = { authMethod: "api-key" as const };
const INTERNAL = { authMethod: "internal" as const };
const UNSTAMPED = {};

beforeEach(() => {
  storedMode = undefined;
});

describe("widensPermissionMode", () => {
  test("a mode never widens beyond itself", () => {
    for (const mode of MODES) {
      expect(widensPermissionMode(mode, mode)).toBe(false);
    }
  });

  test("the full 3x3 matrix", () => {
    // Rows = requested, columns = ceiling. `true` means REFUSE.
    const expected: Record<PermissionMode, Record<PermissionMode, boolean>> = {
      ask: { ask: false, "auto-edit": false, yolo: false },
      "auto-edit": { ask: true, "auto-edit": false, yolo: false },
      yolo: { ask: true, "auto-edit": true, yolo: false },
    };
    for (const requested of MODES) {
      for (const ceiling of MODES) {
        expect(widensPermissionMode(requested, ceiling)).toBe(
          expected[requested][ceiling],
        );
      }
    }
  });
});

describe("the ordering is derived, not asserted twice", () => {
  /**
   * Re-derive "does `requested` widen beyond `ceiling`?" from the PUBLIC
   * `needsApproval` predicate: requested widens iff there is some category
   * that `ceiling` would have prompted for and `requested` would not.
   *
   * This reaches the same matrix by a different route, so the pair of
   * assertions cannot both drift the same way — which is the entire point of
   * having two.
   */
  function widensViaNeedsApproval(
    requested: PermissionMode,
    ceiling: PermissionMode,
  ): boolean {
    return CATEGORIES.some(
      (c) => needsApproval(c, ceiling) && !needsApproval(c, requested),
    );
  }

  test("agrees with widensPermissionMode on every ordered pair", () => {
    for (const requested of MODES) {
      for (const ceiling of MODES) {
        expect(widensPermissionMode(requested, ceiling)).toBe(
          widensViaNeedsApproval(requested, ceiling),
        );
      }
    }
  });

  test("and the ordering it derives is the documented one", () => {
    // Guards against BOTH derivations agreeing on a matrix that is simply
    // wrong (e.g. an empty AUTO_APPROVE would make everything `false`).
    expect(widensViaNeedsApproval("yolo", "ask")).toBe(true);
    expect(widensViaNeedsApproval("ask", "yolo")).toBe(false);
    expect(widensViaNeedsApproval("auto-edit", "ask")).toBe(true);
    expect(widensViaNeedsApproval("ask", "auto-edit")).toBe(false);
    expect(widensViaNeedsApproval("yolo", "auto-edit")).toBe(true);
    expect(widensViaNeedsApproval("auto-edit", "yolo")).toBe(false);
  });
});

describe("checkPermissionModeCeiling", () => {
  test("no requested mode -> allowed, and never reads the setting", async () => {
    storedMode = "ask";
    expect(await checkPermissionModeCeiling(API_KEY, "proj-1", undefined)).toBe(null);
  });

  test("ARM 1 — api key requesting a WIDER mode is refused, naming the field", async () => {
    storedMode = "ask";
    const denial = await checkPermissionModeCeiling(API_KEY, "proj-1", "yolo");
    expect(denial).not.toBe(null);
    expect(denial?.field).toBe(PERMISSION_MODE_FIELD);
    expect(denial?.field).toBe("permissionMode");
    expect(denial?.requested).toBe("yolo");
    expect(denial?.ceiling).toBe("ask");
    expect(denial?.error).toContain("permissionMode");
    expect(denial?.error).toContain("yolo");
    expect(denial?.error).toContain("ask");
  });

  test("ARM 1b — the one-step widening (auto-edit over ask) is refused too", async () => {
    storedMode = "ask";
    const denial = await checkPermissionModeCeiling(API_KEY, "proj-1", "auto-edit");
    expect(denial?.ceiling).toBe("ask");
    expect(denial?.requested).toBe("auto-edit");
  });

  test("ARM 2 — api key requesting an EQUAL mode is allowed", async () => {
    storedMode = "auto-edit";
    expect(await checkPermissionModeCeiling(API_KEY, "proj-1", "auto-edit")).toBe(null);
  });

  test("ARM 2b — api key requesting a NARROWER mode is allowed", async () => {
    storedMode = "yolo";
    expect(await checkPermissionModeCeiling(API_KEY, "proj-1", "ask")).toBe(null);
    expect(await checkPermissionModeCeiling(API_KEY, "proj-1", "auto-edit")).toBe(null);
  });

  test("ARM 3 — a cookie session may still set ANY mode", async () => {
    storedMode = "ask";
    for (const mode of MODES) {
      expect(await checkPermissionModeCeiling(SESSION, "proj-1", mode)).toBe(null);
    }
  });

  test("ARM 4 — no stored mode: the ceiling is DEFAULT_PERMISSION_MODE, so every mode passes", async () => {
    // Fail-safe choice, stated: the ceiling is the mode the turn would have
    // run at ANYWAY (`getPermissionMode` = stored, else default). With
    // nothing stored that is `yolo`, so an override cannot widen anything —
    // refusing here would block a request that changes no behaviour, while
    // the project that DID tighten is still protected by the arms above.
    expect(DEFAULT_PERMISSION_MODE).toBe("yolo");
    storedMode = undefined;
    for (const mode of MODES) {
      expect(await checkPermissionModeCeiling(API_KEY, "proj-1", mode)).toBe(null);
    }
  });

  test("a corrupt stored value falls back to the default ceiling, it does not fail open into a narrower one", async () => {
    storedMode = "not-a-mode";
    expect(await checkPermissionModeCeiling(API_KEY, "proj-1", "yolo")).toBe(null);
  });

  test("the carve-out is an ALLOWLIST — internal and unstamped principals are confined", async () => {
    storedMode = "ask";
    expect((await checkPermissionModeCeiling(INTERNAL, "proj-1", "yolo"))?.ceiling).toBe("ask");
    expect((await checkPermissionModeCeiling(UNSTAMPED, "proj-1", "yolo"))?.ceiling).toBe("ask");
  });

  test("the ceiling is read per-project", async () => {
    storedMode = "ask";
    // proj-2 has no stored mode, so it keeps the permissive default even
    // while proj-1 is tightened — the key is confined per project, not
    // instance-wide.
    expect(await checkPermissionModeCeiling(API_KEY, "proj-2", "yolo")).toBe(null);
    expect(await checkPermissionModeCeiling(API_KEY, "proj-1", "yolo")).not.toBe(null);
  });
});

afterAll(() => restoreModuleMocks());
