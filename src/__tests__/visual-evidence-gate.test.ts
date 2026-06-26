/**
 * Unit tests for the visual-evidence HARD gate's pure logic:
 *   scripts/check-visual-evidence.ts
 *
 * These exercise the exported pure functions directly (no git/subprocess), so
 * they're fast and deterministic. The git/env-wiring main() is validated by the
 * end-to-end sanity-run in the plan, not here.
 */
import { test, expect, describe } from "bun:test";
import {
  isSpecFile,
  isVisualSurfaceFile,
  visualEvidenceViolation,
} from "../../scripts/check-visual-evidence.ts";

// ── isVisualSurfaceFile ──────────────────────────────────────────────────────
describe("check-visual-evidence: isVisualSurfaceFile", () => {
  test("accepts route +page.svelte, +layout.svelte, components, and css", () => {
    expect(isVisualSurfaceFile("web/src/routes/dashboard/+page.svelte")).toBe(true);
    expect(isVisualSurfaceFile("web/src/routes/+layout.svelte")).toBe(true);
    expect(isVisualSurfaceFile("web/src/lib/components/Foo.svelte")).toBe(true);
    expect(isVisualSurfaceFile("web/src/app.css")).toBe(true);
    expect(isVisualSurfaceFile("web/src/lib/components/x/y.css")).toBe(true);
  });

  test("subtracts web/src/lib/server/** even when it matches a surface glob", () => {
    // *.css under web/src/** would otherwise match, but server code is never visual.
    expect(isVisualSurfaceFile("web/src/lib/server/security/foo.svelte")).toBe(false);
  });

  test("rejects non-visual files (pure ts, server routes, specs, docs, scripts)", () => {
    expect(isVisualSurfaceFile("web/src/lib/util.ts")).toBe(false);
    expect(isVisualSurfaceFile("web/src/routes/api/x/+server.ts")).toBe(false);
    expect(isVisualSurfaceFile("web/e2e/foo.spec.ts")).toBe(false);
    expect(isVisualSurfaceFile("README.md")).toBe(false);
    expect(isVisualSurfaceFile("scripts/x.ts")).toBe(false);
  });
});

// ── isSpecFile ───────────────────────────────────────────────────────────────
describe("check-visual-evidence: isSpecFile", () => {
  test("accepts web/e2e/**/*.spec.ts and rejects everything else", () => {
    expect(isSpecFile("web/e2e/foo.spec.ts")).toBe(true);
    expect(isSpecFile("web/e2e/nested/bar.spec.ts")).toBe(true);
    expect(isSpecFile("web/src/lib/components/Foo.svelte")).toBe(false);
    expect(isSpecFile("src/__tests__/foo.test.ts")).toBe(false);
    expect(isSpecFile("web/e2e/helper.ts")).toBe(false);
  });
});

// ── visualEvidenceViolation ──────────────────────────────────────────────────
describe("check-visual-evidence: visualEvidenceViolation", () => {
  test("flags a visual change with no spec change", () => {
    const v = visualEvidenceViolation(["web/src/routes/dashboard/+page.svelte"]);
    expect(v).not.toBeNull();
    expect(v).toContain("web/src/routes/dashboard/+page.svelte");
    expect(v).toContain("@evidence");
    expect(v).toContain("web/e2e/");
    expect(v).toContain("evidence-exempt");
  });

  test("passes when a visual file AND a Playwright spec both changed", () => {
    expect(
      visualEvidenceViolation([
        "web/src/routes/dashboard/+page.svelte",
        "web/e2e/dashboard.spec.ts",
      ]),
    ).toBeNull();
  });

  test("passes when no visual file changed (even with random other files)", () => {
    expect(
      visualEvidenceViolation(["src/runtime/foo.ts", "README.md", "scripts/x.ts"]),
    ).toBeNull();
  });

  test("passes on an empty changed-file list", () => {
    expect(visualEvidenceViolation([])).toBeNull();
  });

  test("passes a component .svelte change accompanied by a changed spec", () => {
    expect(
      visualEvidenceViolation([
        "web/src/lib/components/Foo.svelte",
        "web/e2e/foo.spec.ts",
      ]),
    ).toBeNull();
  });
});
