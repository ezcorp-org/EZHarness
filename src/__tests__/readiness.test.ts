import { test, expect, describe, beforeEach } from "bun:test";
import { getReadiness, setReadiness, resetReadiness } from "../readiness";

beforeEach(() => {
  resetReadiness();
});

describe("readiness state module", () => {
  test("initial state is booting with a since timestamp", () => {
    const r = getReadiness();
    expect(r.state).toBe("booting");
    expect(r.reason).toBeUndefined();
    expect(r.detail).toBeUndefined();
    expect(typeof r.since).toBe("string");
    expect(new Date(r.since).toString()).not.toBe("Invalid Date");
  });

  test("setReadiness updates state and stamps a fresh since timestamp", async () => {
    const before = getReadiness().since;
    // Bun's timer resolution is ms; sleep 2ms to guarantee a different ISO string.
    await new Promise((r) => setTimeout(r, 2));
    setReadiness({ state: "ready" });
    const after = getReadiness();
    expect(after.state).toBe("ready");
    expect(after.since).not.toBe(before);
    expect(new Date(after.since).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  test("setReadiness preserves explicit since when provided", () => {
    const explicit = "2026-01-01T00:00:00.000Z";
    setReadiness({ state: "ready", since: explicit });
    expect(getReadiness().since).toBe(explicit);
  });

  test("degraded state carries reason and detail", () => {
    setReadiness({
      state: "degraded",
      reason: "migration-blocked",
      detail: { imageSha: "abc", recovery: ["step one"] },
    });
    const r = getReadiness();
    expect(r.state).toBe("degraded");
    expect(r.reason).toBe("migration-blocked");
    expect((r.detail as any).imageSha).toBe("abc");
    expect((r.detail as any).recovery).toEqual(["step one"]);
  });

  test("resetReadiness clears reason/detail back to booting", () => {
    setReadiness({ state: "degraded", reason: "migration-failed", detail: { err: "boom" } });
    resetReadiness();
    const r = getReadiness();
    expect(r.state).toBe("booting");
    expect(r.reason).toBeUndefined();
    expect(r.detail).toBeUndefined();
  });

  test("state is a singleton — multiple getReadiness() calls return consistent snapshots", () => {
    setReadiness({ state: "ready" });
    const a = getReadiness();
    const b = getReadiness();
    expect(a.state).toBe(b.state);
    expect(a.since).toBe(b.since);
  });
});
