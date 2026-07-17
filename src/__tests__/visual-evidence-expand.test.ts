/**
 * Tests for the WF2 changed-files EXPANDER
 * (`scripts/visual-evidence/expand-changed-specs.ts`): the pure
 * `expandChangedFiles` union logic, plus a subprocess run of `main()` against
 * the REAL repo covers map to prove the file-rewrite wiring and the fail-soft
 * contract (bad input → untouched file, exit 0).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type CoversMap,
  coveringSpecsForFile,
  loadCoversMap,
} from "../../scripts/check-visual-evidence.ts";
import { expandChangedFiles } from "../../scripts/visual-evidence/expand-changed-specs.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts/visual-evidence/expand-changed-specs.ts");

const COVERS: CoversMap = {
  "web/e2e/footer.spec.ts": ["web/src/lib/components/ChatMessage.svelte"],
  "web/e2e/routing.spec.ts": [
    "web/src/lib/components/ChatMessage.svelte",
    "web/src/lib/components/ModelSelector.svelte",
  ],
};

describe("expand-changed-specs: expandChangedFiles", () => {
  test("appends the covering specs of a changed visual file, deduped, order preserved", () => {
    const lines = ["README.md", "web/src/lib/components/ChatMessage.svelte"];
    expect(expandChangedFiles(lines, COVERS)).toEqual([
      "README.md",
      "web/src/lib/components/ChatMessage.svelte",
      "web/e2e/footer.spec.ts",
      "web/e2e/routing.spec.ts",
    ]);
  });

  test("a covering spec already in the diff is not duplicated", () => {
    const lines = ["web/e2e/routing.spec.ts", "web/src/lib/components/ModelSelector.svelte"];
    expect(expandChangedFiles(lines, COVERS)).toEqual([
      "web/e2e/routing.spec.ts",
      "web/src/lib/components/ModelSelector.svelte",
    ]);
  });

  test("non-visual lines and uncovered visual files pass through untouched", () => {
    const lines = ["src/runtime/foo.ts", "web/src/lib/components/Uncovered.svelte"];
    expect(expandChangedFiles(lines, COVERS)).toEqual(lines);
  });
});

describe("expand-changed-specs: main() wiring", () => {
  test("rewrites the file with covering specs from the REAL repo covers map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evexp-"));
    try {
      const file = join(dir, "changed-files.txt");
      // ChatMessage.svelte is covered by ≥1 real spec in web/e2e/evidence-covers.json.
      await Bun.write(file, "web/src/lib/components/ChatMessage.svelte\nREADME.md\n");
      const proc = Bun.spawn(["bun", SCRIPT, file], {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      expect(code).toBe(0);
      const lines = (await Bun.file(file).text()).trim().split("\n");
      expect(lines[0]).toBe("web/src/lib/components/ChatMessage.svelte");
      expect(lines[1]).toBe("README.md");
      const appended = lines.slice(2);
      // Derive the EXPECTED appended set from the REAL repo covers map rather
      // than assuming ChatMessage.svelte has ≥1 covering spec: the expander
      // appends exactly coveringSpecsForFile(<changed visual file>, map) (its
      // sorted, deduped output), so this stays correct whatever the map says
      // while still proving the real map → file-rewrite wiring.
      const map = await loadCoversMap();
      if (!map) throw new Error("repo covers map failed to load — cannot verify expand wiring");
      const expected = coveringSpecsForFile("web/src/lib/components/ChatMessage.svelte", map);
      expect(appended).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fail-soft: missing target file and missing arg both exit 0", async () => {
    const noFile = Bun.spawn(["bun", SCRIPT, "/tmp/does-not-exist-evexp.txt"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await noFile.exited).toBe(0);
    const noArg = Bun.spawn(["bun", SCRIPT], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(await noArg.exited).toBe(0);
  });
});
