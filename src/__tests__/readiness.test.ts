import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { getReadiness, setReadiness, resetReadiness, setReadinessDiagnostic, recordReadinessWarning } from "../readiness";

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

describe("named readiness diagnostics (W4H-26)", () => {
  afterEach(() => { resetReadiness(); setReadinessDiagnostic("builtinRunnerPackages", undefined); });

  test("a named diagnostic appears in the readiness detail and survives the next readiness write (W4H-26)", () => {
    setReadinessDiagnostic("builtinRunnerPackages", { state: "failed", error: "Error: runner unconfigured" });
    expect(getReadiness().detail).toEqual({ diagnostics: { builtinRunnerPackages: { state: "failed", error: "Error: runner unconfigured" } } });
    setReadiness({ state: "ready", detail: { factory: { tenantId: "t" } } });
    expect(getReadiness()).toMatchObject({ state: "ready", detail: { factory: { tenantId: "t" }, diagnostics: { builtinRunnerPackages: { state: "failed" } } } });
  });

  test("without a diagnostic the readiness is exactly what was set, and clearing one removes it", () => {
    setReadiness({ state: "degraded", reason: "r", detail: "text detail" });
    expect(getReadiness().detail).toBe("text detail");
    setReadinessDiagnostic("builtinRunnerPackages", { state: "staged" });
    expect(getReadiness().detail).toEqual({ value: "text detail", diagnostics: { builtinRunnerPackages: { state: "staged" } } });
    setReadinessDiagnostic("builtinRunnerPackages", undefined);
    expect(getReadiness().detail).toBe("text detail");
  });
});

describe("readiness warnings (W4H-32)", () => {
  const digest = "a".repeat(64);

  test("a warning is non-blocking: readiness keeps its state, and one entry per code and digest counts its occurrences", () => {
    setReadiness({ state: "ready" });
    recordReadinessWarning({ code: "runner_artifact_rehydrated", artifactDigest: digest });
    recordReadinessWarning({ code: "runner_artifact_rehydrated", artifactDigest: digest });
    recordReadinessWarning({ code: "runner_artifact_rehydrated", artifactDigest: "b".repeat(64) });
    const readiness = getReadiness();
    expect(readiness.state).toBe("ready");
    expect(readiness.warnings).toEqual([
      { code: "runner_artifact_rehydrated", artifactDigest: digest, count: 2 },
      { code: "runner_artifact_rehydrated", artifactDigest: "b".repeat(64), count: 1 },
    ]);
    expect(JSON.stringify(readiness.warnings)).not.toContain("message");
  });

  test("warnings survive the next readiness write and ride beside the named diagnostics", () => {
    recordReadinessWarning({ code: "runner_artifact_rehydrated", artifactDigest: digest });
    setReadinessDiagnostic("builtinRunnerPackages", { state: "staged" });
    setReadiness({ state: "degraded", reason: "r" });
    expect(getReadiness()).toMatchObject({ state: "degraded", detail: { diagnostics: { builtinRunnerPackages: { state: "staged" } } }, warnings: [{ code: "runner_artifact_rehydrated", artifactDigest: digest, count: 1 }] });
    setReadinessDiagnostic("builtinRunnerPackages", undefined);
  });

  test("without a warning the document has no warnings field, and a reset clears them with the process's readiness", () => {
    expect(getReadiness()).not.toHaveProperty("warnings");
    recordReadinessWarning({ code: "runner_artifact_rehydrated", artifactDigest: digest });
    resetReadiness();
    expect(getReadiness()).not.toHaveProperty("warnings");
  });
});
