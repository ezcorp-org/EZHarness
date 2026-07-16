import { test, expect, describe } from "bun:test";
import {
  PIPELINE_STEPS,
  M1_IMPLEMENTED_STEPS,
  DEFAULT_AUTO_FIX_LIMITS,
  defaultPipelineConfig,
  autoFixLimit,
  resolvePipelineConfig,
} from "./config";
import { GATE_REMOTE } from "./gate";

describe("pipeline step order + defaults", () => {
  test("fixed 9-step order", () => {
    expect(PIPELINE_STEPS).toEqual([
      "intent",
      "rebase",
      "review",
      "test",
      "document",
      "lint",
      "push",
      "pr",
      "ci",
    ]);
  });
  test("M1 implements intent/rebase/review/push only", () => {
    expect([...M1_IMPLEMENTED_STEPS].sort()).toEqual(["intent", "push", "rebase", "review"]);
  });
  test("review cap defaults to 0 (always parks); rebase/test/document/lint/ci default 3", () => {
    expect(DEFAULT_AUTO_FIX_LIMITS.review).toBe(0);
    expect(DEFAULT_AUTO_FIX_LIMITS.rebase).toBe(3);
    expect(DEFAULT_AUTO_FIX_LIMITS.ci).toBe(3);
    expect(DEFAULT_AUTO_FIX_LIMITS.push).toBe(0);
  });
});

describe("defaultPipelineConfig + autoFixLimit", () => {
  test("defaults are self-consistent", () => {
    const cfg = defaultPipelineConfig();
    expect(cfg.gateRemote).toBe(GATE_REMOTE);
    expect(cfg.defaultBranch).toBe("main");
    expect(cfg.ignorePatterns).toEqual([]);
    expect(autoFixLimit(cfg, "review")).toBe(0);
    expect(autoFixLimit(cfg, "lint")).toBe(3);
  });
  test("mutating a resolved config does not affect the defaults constant", () => {
    const cfg = defaultPipelineConfig();
    cfg.autoFixLimits.review = 9;
    expect(DEFAULT_AUTO_FIX_LIMITS.review).toBe(0);
  });
});

describe("resolvePipelineConfig", () => {
  test("non-object settings → defaults", () => {
    expect(resolvePipelineConfig(null)).toEqual(defaultPipelineConfig());
    expect(resolvePipelineConfig("x")).toEqual(defaultPipelineConfig());
  });
  test("applies valid per-step cap overrides, clamping bad values", () => {
    const cfg = resolvePipelineConfig({
      autoFix: { review: 2, rebase: -5, lint: 4.9, ci: "nope" },
    });
    expect(cfg.autoFixLimits.review).toBe(2);
    expect(cfg.autoFixLimits.rebase).toBe(3); // negative rejected → default
    expect(cfg.autoFixLimits.lint).toBe(4); // floored
    expect(cfg.autoFixLimits.ci).toBe(3); // non-number rejected → default
  });
  test("ignores autoFix when it is not an object", () => {
    const cfg = resolvePipelineConfig({ autoFix: 42 });
    expect(cfg.autoFixLimits).toEqual(DEFAULT_AUTO_FIX_LIMITS);
  });
  test("overrides gateRemote / ignorePatterns / defaultBranch", () => {
    const cfg = resolvePipelineConfig({
      gateRemote: "  factory  ",
      ignorePatterns: ["*.snap", 42, "dist/**"],
      defaultBranch: "  trunk ",
    });
    expect(cfg.gateRemote).toBe("factory");
    expect(cfg.ignorePatterns).toEqual(["*.snap", "dist/**"]);
    expect(cfg.defaultBranch).toBe("trunk");
  });
  test("blank string overrides are rejected", () => {
    const cfg = resolvePipelineConfig({ gateRemote: "   ", defaultBranch: "" });
    expect(cfg.gateRemote).toBe(GATE_REMOTE);
    expect(cfg.defaultBranch).toBe("main");
  });

  // ── flat UI-settings knobs (the keys ezcorp.config.ts declares) ─────
  test("flat reviewAutofixCap + autofixCap knobs set the per-step caps", () => {
    const cfg = resolvePipelineConfig({ reviewAutofixCap: 2, autofixCap: 5 });
    expect(cfg.autoFixLimits.review).toBe(2);
    // autofixCap fans out to rebase/test/document/lint/ci only …
    for (const step of ["rebase", "test", "document", "lint", "ci"] as const) {
      expect(cfg.autoFixLimits[step]).toBe(5);
    }
    // … and never touches the no-auto-fix steps.
    expect(cfg.autoFixLimits.push).toBe(0);
    expect(cfg.autoFixLimits.intent).toBe(0);
    expect(cfg.autoFixLimits.pr).toBe(0);
  });
  test("invalid/negative flat cap knobs leave defaults untouched", () => {
    const cfg = resolvePipelineConfig({ reviewAutofixCap: -1, autofixCap: "nope" });
    expect(cfg.autoFixLimits.review).toBe(0); // default
    expect(cfg.autoFixLimits.rebase).toBe(3); // default
  });
  test("a flat autofixCap of 0 is honored (not treated as unset)", () => {
    const cfg = resolvePipelineConfig({ autofixCap: 0 });
    expect(cfg.autoFixLimits.rebase).toBe(0);
    expect(cfg.autoFixLimits.ci).toBe(0);
  });
  test("comma-separated ignorePatterns string is split, trimmed, emptied-out", () => {
    const cfg = resolvePipelineConfig({ ignorePatterns: " *.snap , , dist/** ,, " });
    expect(cfg.ignorePatterns).toEqual(["*.snap", "dist/**"]);
  });
});
