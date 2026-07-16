/**
 * Unit tests for the visual-evidence HARD gate's pure logic:
 *   scripts/check-visual-evidence.ts
 *
 * These exercise the exported pure functions directly (no git/subprocess), so
 * they're fast and deterministic. The git/env-wiring main() is validated by the
 * end-to-end sanity-run in the plan, not here.
 */
import { afterAll, test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CoversMap,
  coveringSpecsForFile,
  isSpecFile,
  isValidCoversMap,
  isVisualSurfaceFile,
  loadCoversMap,
  visualEvidenceViolation,
  visualEvidenceViolationWithCovers,
} from "../../scripts/check-visual-evidence.ts";

// A tiny fixture map exercising the covers logic: two specs render the same
// footer component (∃-covering semantics), a third covers a settings route, and
// route keys carry SvelteKit `[id]` / `(app)` segments to prove escapeGlob.
const COVERS: CoversMap = {
  "web/e2e/chat.spec.ts": [
    "web/src/lib/components/ChatMessage.svelte",
    "web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte",
  ],
  "web/e2e/footer.spec.ts": ["web/src/lib/components/ChatMessage.svelte"],
  "web/e2e/settings.spec.ts": ["web/src/routes/(app)/settings/+page.svelte"],
};

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

// ── isValidCoversMap ─────────────────────────────────────────────────────────
describe("check-visual-evidence: isValidCoversMap", () => {
  test("accepts a plain { spec → string[] } object", () => {
    expect(isValidCoversMap({ "a.spec.ts": ["web/src/x.svelte"] })).toBe(true);
    expect(isValidCoversMap({})).toBe(true);
  });

  test("rejects arrays, null, and non-string-array values", () => {
    expect(isValidCoversMap(null)).toBe(false);
    expect(isValidCoversMap([])).toBe(false);
    expect(isValidCoversMap("x")).toBe(false);
    expect(isValidCoversMap({ a: "not-an-array" })).toBe(false);
    expect(isValidCoversMap({ a: [1, 2] })).toBe(false);
    expect(isValidCoversMap({ a: ["ok", 3] })).toBe(false);
  });
});

// ── coveringSpecsForFile ─────────────────────────────────────────────────────
describe("check-visual-evidence: coveringSpecsForFile", () => {
  test("returns every spec whose globs match the file, sorted", () => {
    expect(coveringSpecsForFile("web/src/lib/components/ChatMessage.svelte", COVERS)).toEqual([
      "web/e2e/chat.spec.ts",
      "web/e2e/footer.spec.ts",
    ]);
  });

  test("matches SvelteKit [id]/(app) route segments literally (escapeGlob)", () => {
    expect(
      coveringSpecsForFile("web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte", COVERS),
    ).toEqual(["web/e2e/chat.spec.ts"]);
  });

  test("returns [] for a file no spec covers", () => {
    expect(coveringSpecsForFile("web/src/lib/components/Unmapped.svelte", COVERS)).toEqual([]);
  });
});

// ── visualEvidenceViolationWithCovers ────────────────────────────────────────
describe("check-visual-evidence: visualEvidenceViolationWithCovers", () => {
  test("no visual file changed → pass", () => {
    expect(visualEvidenceViolationWithCovers(["src/x.ts", "web/e2e/chat.spec.ts"], COVERS)).toBeNull();
  });

  test("visual change with NO spec → coarse violation (same as map-less gate)", () => {
    const files = ["web/src/lib/components/ChatMessage.svelte"];
    const v = visualEvidenceViolationWithCovers(files, COVERS);
    expect(v).toBe(visualEvidenceViolation(files));
    expect(v).toContain("web/src/lib/components/ChatMessage.svelte");
  });

  test("covered file passes when ONE of its covering specs changed", () => {
    expect(
      visualEvidenceViolationWithCovers(
        ["web/src/lib/components/ChatMessage.svelte", "web/e2e/footer.spec.ts"],
        COVERS,
      ),
    ).toBeNull();
  });

  test("covered file FAILS when only an unrelated spec changed, naming its covering specs", () => {
    const v = visualEvidenceViolationWithCovers(
      ["web/src/lib/components/ChatMessage.svelte", "web/e2e/settings.spec.ts"],
      COVERS,
    );
    expect(v).not.toBeNull();
    expect(v).toContain("web/src/lib/components/ChatMessage.svelte");
    expect(v).toContain("web/e2e/chat.spec.ts");
    expect(v).toContain("web/e2e/footer.spec.ts");
    expect(v).toContain("evidence-covers.json");
  });

  test("a file with NO covering entry keeps the coarse rule (any changed spec passes)", () => {
    expect(
      visualEvidenceViolationWithCovers(
        ["web/src/lib/components/Unmapped.svelte", "web/e2e/settings.spec.ts"],
        COVERS,
      ),
    ).toBeNull();
  });

  test("partial satisfaction still fails: one covered file left un-evidenced", () => {
    // chat.spec covers ChatMessage (changed → ok); the settings route is covered
    // only by settings.spec, which did NOT change → violation names just it.
    const v = visualEvidenceViolationWithCovers(
      [
        "web/src/lib/components/ChatMessage.svelte",
        "web/src/routes/(app)/settings/+page.svelte",
        "web/e2e/chat.spec.ts",
      ],
      COVERS,
    );
    expect(v).not.toBeNull();
    expect(v).toContain("web/src/routes/(app)/settings/+page.svelte");
    expect(v).toContain("web/e2e/settings.spec.ts");
    expect(v).not.toContain("ChatMessage.svelte");
  });
});

// ── loadCoversMap (fail-open) ────────────────────────────────────────────────
describe("check-visual-evidence: loadCoversMap", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function tmpFile(name: string, body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "evcov-"));
    dirs.push(dir);
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  }

  test("returns null for a missing file (fail-open)", async () => {
    expect(await loadCoversMap(join(tmpdir(), "definitely-absent-covers.json"))).toBeNull();
  });

  test("returns null for malformed JSON (fail-open)", async () => {
    expect(await loadCoversMap(tmpFile("bad.json", "{not json"))).toBeNull();
  });

  test("returns null for a mis-shaped (valid JSON, wrong shape) map", async () => {
    expect(await loadCoversMap(tmpFile("shape.json", JSON.stringify({ a: "x" })))).toBeNull();
  });

  test("returns the parsed map for a valid file", async () => {
    const p = tmpFile("ok.json", JSON.stringify(COVERS));
    expect(await loadCoversMap(p)).toEqual(COVERS);
  });

  test("the repo's own evidence-covers.json loads and is valid", async () => {
    const map = await loadCoversMap();
    expect(map).not.toBeNull();
    expect(isValidCoversMap(map)).toBe(true);
  });
});
