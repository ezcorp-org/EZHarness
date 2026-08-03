import { test, expect, describe } from "bun:test";
import { guardScope, MANAGE_JOBS_SCOPE, RESPOND_SCOPE, YOLO_SCOPE, type RbacCheck } from "./rbac";

describe("scope names", () => {
  test("declare the two triage scopes", () => {
    expect(RESPOND_SCOPE).toBe("respond-gate");
    expect(YOLO_SCOPE).toBe("yolo");
  });

  test("declare the config-plane scope, distinct from both triage scopes", () => {
    // MANAGE_JOBS_SCOPE was previously asserted NOWHERE. Redefining it to
    // "respond-gate" collapsed the config plane into run triage and no test
    // noticed.
    expect(MANAGE_JOBS_SCOPE).toBe("manage-jobs");
    expect(new Set([RESPOND_SCOPE, YOLO_SCOPE, MANAGE_JOBS_SCOPE]).size).toBe(3);
  });
});

// ── INVARIANT #18 — least privilege across the triage verbs ─────────────
//
// The three scopes are SEPARATE authorities: answering a parked run
// (`respond-gate`), clearing every remaining gate of a run (`yolo`), and
// shaping which runs future pushes create (`manage-jobs`). Holding one must
// never confer another.
//
// The existing manage-jobs deny tests in index.test.ts drive a
// deny-EVERYTHING fake (`_setRbacCheckForTests(async () => false)`), so they
// prove the guard fails closed — they cannot distinguish "denied because the
// user lacks manage-jobs" from "denied because the fake denies all". A scope
// collapse is invisible to them. These tests grant exactly ONE scope, so a
// collapse turns a deny into an allow.

/** An `RbacCheck` granting exactly one scope and nothing else. */
const grantOnly =
  (held: string): RbacCheck =>
  async (scope) =>
    scope === held;

describe("scope separation", () => {
  test("approve-gate does not imply manage-jobs", async () => {
    // A user granted ONLY the run-triage scope must not reach the config plane.
    const denied = await guardScope(grantOnly(RESPOND_SCOPE), MANAGE_JOBS_SCOPE, "manage jobs");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error).toContain(MANAGE_JOBS_SCOPE);

    // Non-vacuity guard — this is what the deny-everything fakes cannot do:
    // the SAME holder IS allowed its own scope, so the deny above is genuine
    // separation and not a deny-all artifact.
    const allowed = await guardScope(grantOnly(RESPOND_SCOPE), RESPOND_SCOPE, "respond to a gate");
    expect(allowed.ok).toBe(true);
  });

  test("no scope implies any other — full pairwise matrix", async () => {
    // Compared BY NAME, not by value: if two constants collapsed onto the same
    // string, a value-compare expectation would collapse with them and pass.
    const scopes = [
      ["RESPOND_SCOPE", RESPOND_SCOPE],
      ["YOLO_SCOPE", YOLO_SCOPE],
      ["MANAGE_JOBS_SCOPE", MANAGE_JOBS_SCOPE],
    ] as const;

    for (const [heldName, held] of scopes) {
      for (const [wantedName, wanted] of scopes) {
        const guard = await guardScope(grantOnly(held), wanted, "act");
        const label = `holds ${heldName} → wants ${wantedName}: `;
        expect(label + guard.ok).toBe(label + (heldName === wantedName));
      }
    }
  });
});

describe("guardScope", () => {
  test("allows when the check grants the scope", async () => {
    const seen: string[] = [];
    const guard = await guardScope(
      async (scope) => {
        seen.push(scope);
        return true;
      },
      RESPOND_SCOPE,
      "respond to a gate",
    );
    expect(guard.ok).toBe(true);
    expect(seen).toEqual([RESPOND_SCOPE]);
  });

  test("refuses (403-style) with a clear message when the scope is not held", async () => {
    const guard = await guardScope(async () => false, YOLO_SCOPE, "run the yolo autopilot");
    expect(guard.ok).toBe(false);
    if (guard.ok) throw new Error("unreachable");
    expect(guard.error).toContain("refused");
    expect(guard.error).toContain(YOLO_SCOPE);
    expect(guard.error).toContain("run the yolo autopilot");
  });

  test("fails CLOSED (deny) when the check THROWS (unresolved / ownerless provenance)", async () => {
    const guard = await guardScope(
      async () => {
        throw new Error("provenance unresolved");
      },
      RESPOND_SCOPE,
      "respond to a gate",
    );
    expect(guard.ok).toBe(false);
    if (guard.ok) throw new Error("unreachable");
    expect(guard.error).toContain(RESPOND_SCOPE);
  });
});
