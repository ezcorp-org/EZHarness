/**
 * Unit + integration tests for the visual-evidence CAPTURE SELECTOR
 * (`scripts/visual-evidence/select-specs.ts`).
 *
 * The pure `selectEvidenceSpecs` / `toWebRelativeSpecPath` helpers are exercised
 * directly (no git). A small integration block spawns the real script against a
 * throwaway temp git repo to prove `main()`'s git wiring: the ACMR diff (so a
 * deleted spec never counts), the web-relative output, the __NONE__/__ALL__
 * sentinels, and the fail-open on a bad base ref.
 *
 * Follows the sandbox idiom of `src/__tests__/coverage-gate.test.ts`: because
 * the script resolves REPO_ROOT via `import.meta.dir`, we copy it (plus the two
 * modules it imports) into a temp scripts/ tree so it rebases onto the sandbox.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CoversMap } from "../../scripts/check-visual-evidence.ts";
import { selectEvidenceSpecs, toWebRelativeSpecPath } from "../../scripts/visual-evidence/select-specs.ts";

// Fixture covers map: two specs render the same footer component; one also
// renders the model selector. Route key carries `[id]`/`(app)` to prove
// escapeGlob rides through the selector's union path too.
const COVERS: CoversMap = {
  "web/e2e/footer.spec.ts": ["web/src/lib/components/ChatMessage.svelte"],
  "web/e2e/routing.spec.ts": [
    "web/src/lib/components/ChatMessage.svelte",
    "web/src/lib/components/ModelSelector.svelte",
  ],
};

// ── toWebRelativeSpecPath ────────────────────────────────────────────────────
describe("select-specs: toWebRelativeSpecPath", () => {
  test("strips the leading web/ so the path is Playwright-rootDir-relative", () => {
    expect(toWebRelativeSpecPath("web/e2e/dash.spec.ts")).toBe("e2e/dash.spec.ts");
    expect(toWebRelativeSpecPath("web/e2e/nested/a.spec.ts")).toBe("e2e/nested/a.spec.ts");
  });
  test("leaves a path without a web/ prefix unchanged", () => {
    expect(toWebRelativeSpecPath("e2e/already.spec.ts")).toBe("e2e/already.spec.ts");
  });
});

// ── selectEvidenceSpecs ──────────────────────────────────────────────────────
describe("select-specs: selectEvidenceSpecs", () => {
  test("non-visual diff (no visual, no spec) → none", () => {
    expect(selectEvidenceSpecs(["src/runtime/foo.ts", "README.md", "scripts/x.ts"])).toEqual({
      mode: "none",
    });
    expect(selectEvidenceSpecs([])).toEqual({ mode: "none" });
  });

  test("a changed spec → some, converted to web-relative", () => {
    expect(selectEvidenceSpecs(["web/e2e/dash.spec.ts"])).toEqual({
      mode: "some",
      specs: ["e2e/dash.spec.ts"],
    });
  });

  test("visual + spec both changed → some (the changed spec)", () => {
    expect(
      selectEvidenceSpecs(["web/src/routes/dashboard/+page.svelte", "web/e2e/dashboard.spec.ts"]),
    ).toEqual({ mode: "some", specs: ["e2e/dashboard.spec.ts"] });
  });

  test("multiple changed specs are deduped and sorted", () => {
    const result = selectEvidenceSpecs([
      "web/e2e/zed.spec.ts",
      "web/e2e/alpha.spec.ts",
      "web/e2e/zed.spec.ts",
      "web/src/lib/components/Foo.svelte",
    ]);
    expect(result).toEqual({
      mode: "some",
      specs: ["e2e/alpha.spec.ts", "e2e/zed.spec.ts"],
    });
  });

  test("visual change WITHOUT a spec → all (fail-open, evidence-exempt path)", () => {
    expect(selectEvidenceSpecs(["web/src/lib/components/Foo.svelte"])).toEqual({ mode: "all" });
    expect(selectEvidenceSpecs(["web/src/app.css"])).toEqual({ mode: "all" });
  });

  test("a non-spec e2e helper does not count as a spec (→ none when alone)", () => {
    // web/e2e/helper.ts is neither a visual surface nor a *.spec.ts.
    expect(selectEvidenceSpecs(["web/e2e/helper.ts"])).toEqual({ mode: "none" });
  });
});

// ── selectEvidenceSpecs: covers-map union ────────────────────────────────────
describe("select-specs: selectEvidenceSpecs covers union", () => {
  test("some = changed specs ∪ covering specs of changed visual files", () => {
    const result = selectEvidenceSpecs(
      ["web/e2e/manual.spec.ts", "web/src/lib/components/ChatMessage.svelte"],
      COVERS,
    );
    // manual.spec (changed) unions with footer + routing (both render ChatMessage).
    expect(result).toEqual({
      mode: "some",
      specs: ["e2e/footer.spec.ts", "e2e/manual.spec.ts", "e2e/routing.spec.ts"],
    });
  });

  test("union dedupes when a covering spec is also the changed spec", () => {
    const result = selectEvidenceSpecs(
      ["web/e2e/routing.spec.ts", "web/src/lib/components/ModelSelector.svelte"],
      COVERS,
    );
    // ModelSelector is covered only by routing.spec, which is also the changed
    // spec → the set collapses to one entry.
    expect(result).toEqual({ mode: "some", specs: ["e2e/routing.spec.ts"] });
  });

  test("no covers map → just the changed specs (P1 behavior, no union)", () => {
    expect(
      selectEvidenceSpecs(["web/e2e/manual.spec.ts", "web/src/lib/components/ChatMessage.svelte"]),
    ).toEqual({ mode: "some", specs: ["e2e/manual.spec.ts"] });
  });

  test("changed spec but no changed visual file → union is a no-op", () => {
    expect(selectEvidenceSpecs(["web/e2e/manual.spec.ts"], COVERS)).toEqual({
      mode: "some",
      specs: ["e2e/manual.spec.ts"],
    });
  });

  test("visual-without-spec stays 'all' — the covers map does NOT re-scope fail-open", () => {
    expect(selectEvidenceSpecs(["web/src/lib/components/ChatMessage.svelte"], COVERS)).toEqual({
      mode: "all",
    });
  });
});

// ── integration: main() over a real temp git repo ────────────────────────────
describe("select-specs: main() git wiring", () => {
  const REPO_ROOT = resolve(import.meta.dir, "..", "..");
  const SCRIPT_SRC = join(REPO_ROOT, "scripts/visual-evidence/select-specs.ts");
  const GATE_SRC = join(REPO_ROOT, "scripts/check-visual-evidence.ts");
  const CONFIG_SRC = join(REPO_ROOT, "scripts/coverage-config.ts");

  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function git(root: string, args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
  }

  /**
   * Build a sandbox repo: base files committed on `main`, then a `feat` branch
   * with `changes` applied (writes + removals). Runs select-specs.ts with the
   * given base ref and returns trimmed stdout.
   */
  async function runScenario(opts: {
    base: Record<string, string>;
    write?: Record<string, string>;
    remove?: string[];
    baseRef?: string;
  }): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), "evsel-"));
    sandboxes.push(root);
    mkdirSync(join(root, "scripts/visual-evidence"), { recursive: true });
    copyFileSync(SCRIPT_SRC, join(root, "scripts/visual-evidence/select-specs.ts"));
    copyFileSync(GATE_SRC, join(root, "scripts/check-visual-evidence.ts"));
    copyFileSync(CONFIG_SRC, join(root, "scripts/coverage-config.ts"));

    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "Test"]);

    for (const [rel, content] of Object.entries(opts.base)) {
      const abs = join(root, rel);
      mkdirSync(resolve(abs, ".."), { recursive: true });
      await Bun.write(abs, content);
    }
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "base"]);

    await git(root, ["checkout", "-q", "-b", "feat"]);
    for (const [rel, content] of Object.entries(opts.write ?? {})) {
      const abs = join(root, rel);
      mkdirSync(resolve(abs, ".."), { recursive: true });
      await Bun.write(abs, content);
    }
    for (const rel of opts.remove ?? []) rmSync(join(root, rel), { force: true });
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "feat"]);

    const proc = Bun.spawn(["bun", join(root, "scripts/visual-evidence/select-specs.ts")], {
      cwd: root,
      env: { ...process.env, BASE_REF: opts.baseRef ?? "main" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return out.trim();
  }

  test("changed spec → web-relative spec path", async () => {
    const out = await runScenario({
      base: { "web/e2e/foo.spec.ts": "// v1\n", "web/src/lib/components/Foo.svelte": "<div/>" },
      write: { "web/e2e/foo.spec.ts": "// v2\n" },
    });
    expect(out).toBe("e2e/foo.spec.ts");
  });

  test("non-visual diff → __NONE__", async () => {
    const out = await runScenario({
      base: { "README.md": "# hi\n" },
      write: { "README.md": "# hi there\n" },
    });
    expect(out).toBe("__NONE__");
  });

  test("visual change without a spec → __ALL__ (fail-open)", async () => {
    const out = await runScenario({
      base: { "web/src/lib/components/Foo.svelte": "<div>1</div>" },
      write: { "web/src/lib/components/Foo.svelte": "<div>2</div>" },
    });
    expect(out).toBe("__ALL__");
  });

  test("a DELETED spec is excluded by ACMR (deletion + visual edit → __ALL__)", async () => {
    const out = await runScenario({
      base: {
        "web/e2e/bar.spec.ts": "// spec\n",
        "web/src/lib/components/Foo.svelte": "<div>1</div>",
      },
      remove: ["web/e2e/bar.spec.ts"],
      write: { "web/src/lib/components/Foo.svelte": "<div>2</div>" },
    });
    // The deleted spec must NOT satisfy "a spec changed"; only the visual edit
    // remains → no mappable spec → full suite.
    expect(out).toBe("__ALL__");
  });

  test("a bad base ref makes git error → __ALL__ (fail-open, exit 0)", async () => {
    const out = await runScenario({
      base: { "web/e2e/foo.spec.ts": "// v1\n" },
      write: { "web/e2e/foo.spec.ts": "// v2\n" },
      baseRef: "origin/does-not-exist",
    });
    expect(out).toBe("__ALL__");
  });

  test("main() unions the covering spec of a changed visual file with the changed spec", async () => {
    // beta.spec is changed directly; the changed Widget component is covered by
    // alpha.spec (unchanged) per the sandbox's evidence-covers.json → capture
    // must run BOTH, proving main() loads the map and applies the union.
    const covers = JSON.stringify({
      "web/e2e/alpha.spec.ts": ["web/src/lib/components/Widget.svelte"],
      "web/e2e/beta.spec.ts": ["web/src/lib/components/Other.svelte"],
    });
    const out = await runScenario({
      base: {
        "web/e2e/alpha.spec.ts": "// @evidence v1\n",
        "web/e2e/beta.spec.ts": "// @evidence v1\n",
        "web/src/lib/components/Widget.svelte": "<div>1</div>",
        "web/e2e/evidence-covers.json": covers,
      },
      write: {
        "web/e2e/beta.spec.ts": "// @evidence v2\n",
        "web/src/lib/components/Widget.svelte": "<div>2</div>",
      },
    });
    expect(out).toBe("e2e/alpha.spec.ts\ne2e/beta.spec.ts");
  });

  test("main() degrades to just the changed spec when the covers map is absent", async () => {
    // No evidence-covers.json in the sandbox → loadCoversMap returns null → the
    // union is skipped and only the directly-changed spec is selected.
    const out = await runScenario({
      base: {
        "web/e2e/beta.spec.ts": "// @evidence v1\n",
        "web/src/lib/components/Widget.svelte": "<div>1</div>",
      },
      write: {
        "web/e2e/beta.spec.ts": "// @evidence v2\n",
        "web/src/lib/components/Widget.svelte": "<div>2</div>",
      },
    });
    expect(out).toBe("e2e/beta.spec.ts");
  });
});
