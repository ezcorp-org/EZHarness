import { test, expect, describe } from "bun:test";
import { guardScope, RESPOND_SCOPE, YOLO_SCOPE } from "./rbac";

describe("scope names", () => {
  test("declare the two triage scopes", () => {
    expect(RESPOND_SCOPE).toBe("respond-gate");
    expect(YOLO_SCOPE).toBe("yolo");
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
