/**
 * Tests for the deterministic Feature Index scanner
 * (`src/runtime/scan/feature-scan.ts`) and the shared FS helpers it
 * delegates to (`src/runtime/fs/scan-fs.ts`).
 *
 * Coverage targets (per design doc + dev's #13 summary):
 *   1. Grouping by immediate child dir under known source roots.
 *   2. Slug-collision rule (`web/src/components` → `web-components`).
 *   3. Slug rule applied to packages (`packages/foo/src/utils` →
 *      `packages-utils` when colliding).
 *   4. Recursive file collection inside a feature directory.
 *   5. Exclusion of `node_modules`, `.git`, `.ezcorp`, dotfiles.
 *   6. Symlink-escape filter — a symlink pointing OUTSIDE the project
 *      is dropped; a symlink staying inside is followed.
 *   7. Empty / single-file features are skipped.
 *   8. Empty / missing source roots → no throw.
 *   9. Determinism — repeated scans return identical output.
 *   10. Description format = `Files under <relpath>`.
 *   11. **Meta-invariant**: the mention search endpoint imports the
 *       shared helper (`scan-fs.ts`) — no duplication of
 *       EXCLUDED_DIR_NAMES / symlink-escape / dotfile filter.
 *   12. listFilteredChildren / realpathInsideRoot direct unit coverage.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";

import { scanFeatures } from "../runtime/scan/feature-scan";
import {
  listFilteredChildren,
  realpathInsideRoot,
  EXCLUDED_DIR_NAMES,
} from "../runtime/fs/scan-fs";

// ── Fixture builder helpers ──────────────────────────────────────────
let projectRoot: string;
let outsideRoot: string;

async function writeFiles(spec: Record<string, string>): Promise<void> {
  for (const [rel, contents] of Object.entries(spec)) {
    const abs = resolve(projectRoot, rel);
    await mkdir(resolve(abs, ".."), { recursive: true });
    await writeFile(abs, contents);
  }
}

async function makeDir(rel: string): Promise<void> {
  await mkdir(resolve(projectRoot, rel), { recursive: true });
}

beforeEach(async () => {
  projectRoot = await mkdtemp(resolve(tmpdir(), "feat-scan-"));
  outsideRoot = await mkdtemp(resolve(tmpdir(), "feat-scan-outside-"));
});
afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

// ── scanFeatures — happy paths ───────────────────────────────────────
describe("scanFeatures — grouping & skip rules", () => {
  test("groups by immediate child of src/, skips single-file features", async () => {
    await writeFiles({
      "src/featA/a.ts": "a",
      "src/featA/b.ts": "b",
      "src/featB/x.ts": "x", // single-file → skipped
    });

    const result = await scanFeatures(projectRoot);
    expect(result.map((f) => f.name)).toEqual(["featA"]);
    expect(result[0]!.files).toEqual(["src/featA/a.ts", "src/featA/b.ts"]);
  });

  test("recursively walks subdirs inside a feature; output sorted", async () => {
    await writeFiles({
      "src/featA/a.ts": "a",
      "src/featA/sub/b.ts": "b",
      "src/featA/sub/c.ts": "c",
    });

    const result = await scanFeatures(projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0]!.files).toEqual([
      "src/featA/a.ts",
      "src/featA/sub/b.ts",
      "src/featA/sub/c.ts",
    ]);
  });

  test("description format = 'Files under <relpath>'", async () => {
    await writeFiles({
      "src/chat/a.ts": "a",
      "src/chat/b.ts": "b",
    });
    const result = await scanFeatures(projectRoot);
    expect(result[0]!.description).toBe("Files under src/chat");
  });

  test("empty directories produce no feature", async () => {
    await makeDir("src/empty");
    await writeFiles({ "src/featA/a.ts": "a", "src/featA/b.ts": "b" });
    const result = await scanFeatures(projectRoot);
    expect(result.map((f) => f.name)).toEqual(["featA"]);
  });

  test("missing source roots → empty array, no throw", async () => {
    // tmpdir created in beforeEach has no src/, no web/src/, no packages/
    expect(await scanFeatures(projectRoot)).toEqual([]);
  });

  test("nonexistent projectRoot → empty array, no throw", async () => {
    expect(await scanFeatures("/this/path/definitely/does/not/exist")).toEqual([]);
  });

  test("empty projectRoot string → empty array", async () => {
    expect(await scanFeatures("")).toEqual([]);
  });
});

// ── Slug collision rule ──────────────────────────────────────────────
describe("scanFeatures — slug collision", () => {
  test("src/components vs web/src/components → ['components', 'web-components']", async () => {
    await writeFiles({
      "src/components/a.ts": "a",
      "src/components/b.ts": "b",
      "web/src/components/c.ts": "c",
      "web/src/components/d.ts": "d",
    });
    const result = await scanFeatures(projectRoot);
    expect(result.map((f) => f.name)).toEqual(["components", "web-components"]);
    const byName = new Map(result.map((f) => [f.name, f]));
    expect(byName.get("components")!.files).toEqual([
      "src/components/a.ts",
      "src/components/b.ts",
    ]);
    expect(byName.get("web-components")!.files).toEqual([
      "web/src/components/c.ts",
      "web/src/components/d.ts",
    ]);
  });

  test("packages collision: src/utils first → packages variant becomes 'packages-utils'", async () => {
    await writeFiles({
      "src/utils/a.ts": "a",
      "src/utils/b.ts": "b",
      "packages/foo/src/utils/x.ts": "x",
      "packages/foo/src/utils/y.ts": "y",
    });
    const result = await scanFeatures(projectRoot);
    const names = result.map((f) => f.name).sort();
    expect(names).toEqual(["packages-utils", "utils"]);
  });

  test("packages alone produces bare slug (no collision)", async () => {
    await writeFiles({
      "packages/foo/src/standalone/a.ts": "a",
      "packages/foo/src/standalone/b.ts": "b",
    });
    const result = await scanFeatures(projectRoot);
    expect(result.map((f) => f.name)).toEqual(["standalone"]);
  });

  test("scoped packages: packages/@scope/<pkg>/src is treated as a source root", async () => {
    await writeFiles({
      "packages/@ezcorp/sdk/src/runtime/r.ts": "r",
      "packages/@ezcorp/sdk/src/runtime/s.ts": "s",
      "packages/@ezcorp/ai-kit/src/mcp/server.ts": "x",
      "packages/@ezcorp/ai-kit/src/mcp/client.ts": "y",
    });
    const result = await scanFeatures(projectRoot);
    const names = result.map((f) => f.name).sort();
    // Each scoped package's src/* immediate children become features.
    expect(names).toContain("runtime");
    expect(names).toContain("mcp");
  });

  test("docs/extensions/examples is a source root: each example becomes a feature", async () => {
    await writeFiles({
      "docs/extensions/examples/auto-note/ezcorp.config.ts": "// manifest",
      "docs/extensions/examples/auto-note/runtime.ts": "// runtime",
      "docs/extensions/examples/task-stack/ezcorp.config.ts": "// manifest",
      "docs/extensions/examples/task-stack/runtime.ts": "// runtime",
    });
    const result = await scanFeatures(projectRoot);
    const names = result.map((f) => f.name).sort();
    expect(names).toContain("auto-note");
    expect(names).toContain("task-stack");
    const autoNote = result.find((f) => f.name === "auto-note")!;
    expect(autoNote.files).toContain("docs/extensions/examples/auto-note/ezcorp.config.ts");
  });

  test("triple collision (prefixed slug also collides) → duplicate dropped", async () => {
    // src/foo claims "foo".
    // web/src/foo collides → becomes "web-foo".
    // Manually staging a separate "web-foo" basename via packages/web/src
    // that already has "foo" would re-collide; this is a corner case the
    // implementation handles by skipping rather than producing a non-unique
    // slug. Construct it: packages/web/src/foo + src/foo + a separately
    // named src/web-foo.
    await writeFiles({
      "src/foo/a.ts": "a",
      "src/foo/b.ts": "b",
      "src/web-foo/x.ts": "x",
      "src/web-foo/y.ts": "y",
      "web/src/foo/c.ts": "c",
      "web/src/foo/d.ts": "d",
    });
    const result = await scanFeatures(projectRoot);
    const names = result.map((f) => f.name).sort();
    // src/foo and src/web-foo each claim their bare slug. The web/src/foo
    // bucket would prefix to "web-foo" but that's already claimed → dropped.
    expect(names).toEqual(["foo", "web-foo"]);
  });
});

// ── Exclusion rules ──────────────────────────────────────────────────
describe("scanFeatures — exclusions", () => {
  test("node_modules / .git / .ezcorp inside a feature dir are excluded", async () => {
    await writeFiles({
      "src/featA/a.ts": "a",
      "src/featA/b.ts": "b",
      "src/featA/node_modules/lib/index.js": "x",
      "src/featA/.git/HEAD": "ref",
      "src/featA/.ezcorp/extension-data/foo": "x",
    });
    const result = await scanFeatures(projectRoot);
    expect(result).toHaveLength(1);
    expect(result[0]!.files).toEqual(["src/featA/a.ts", "src/featA/b.ts"]);
  });

  test("dotfiles inside a feature dir are excluded", async () => {
    await writeFiles({
      "src/featA/a.ts": "a",
      "src/featA/b.ts": "b",
      "src/featA/.env": "SECRET=1",
      "src/featA/.hidden/file.ts": "x",
    });
    const result = await scanFeatures(projectRoot);
    expect(result[0]!.files).toEqual(["src/featA/a.ts", "src/featA/b.ts"]);
  });

  test("excluded children at the source-root level do NOT produce features", async () => {
    await writeFiles({
      "src/.git/HEAD": "ref",
      "src/node_modules/foo/index.js": "x",
      "src/featReal/a.ts": "a",
      "src/featReal/b.ts": "b",
    });
    const result = await scanFeatures(projectRoot);
    expect(result.map((f) => f.name)).toEqual(["featReal"]);
  });
});

// ── Symlink-escape filter ────────────────────────────────────────────
describe("scanFeatures — symlink handling", () => {
  test("symlink inside a feature pointing OUTSIDE the project is dropped", async () => {
    await writeFiles({
      "src/featA/a.ts": "a",
      "src/featA/b.ts": "b",
    });
    // Outside file the symlink will point to.
    await writeFile(resolve(outsideRoot, "leak.ts"), "leak");
    // featA/escape.ts → outside/leak.ts (escape attempt)
    await symlink(
      resolve(outsideRoot, "leak.ts"),
      resolve(projectRoot, "src/featA/escape.ts"),
    );

    const result = await scanFeatures(projectRoot);
    expect(result[0]!.files).toEqual(["src/featA/a.ts", "src/featA/b.ts"]);
    expect(result[0]!.files).not.toContain("src/featA/escape.ts");
  });

  test("symlink inside a feature pointing back INSIDE the project is followed", async () => {
    await writeFiles({
      "src/featA/a.ts": "a",
      "src/featA/b.ts": "b",
      "src/shared/target.ts": "target",
    });
    // featA/inside.ts → src/shared/target.ts (in-bounds — kept).
    await symlink(
      resolve(projectRoot, "src/shared/target.ts"),
      resolve(projectRoot, "src/featA/inside.ts"),
    );
    const result = await scanFeatures(projectRoot);
    const featA = result.find((f) => f.name === "featA")!;
    expect(featA.files).toContain("src/featA/inside.ts");
  });

  test("scanner works when projectRoot itself is a symlink", async () => {
    await writeFiles({
      "src/featA/a.ts": "a",
      "src/featA/b.ts": "b",
    });
    const aliasRoot = await mkdtemp(resolve(tmpdir(), "feat-scan-alias-"));
    await rm(aliasRoot, { recursive: true, force: true });
    await symlink(projectRoot, aliasRoot);

    const result = await scanFeatures(aliasRoot);
    expect(result.map((f) => f.name)).toEqual(["featA"]);

    await rm(aliasRoot, { force: true });
  });
});

// ── D1: Symlink-cycle DoS regression (audit fix d25c126a) ───────────
describe("scanFeatures — symlink-cycle resilience (D1)", () => {
  test("mutual symlinks between two feature dirs terminate within 2s and return finite results", async () => {
    // Without the d25c126a fix this hangs indefinitely (or stack-overflows)
    // because each symlink resolves to a path that's still inside the
    // project root. The fix tracks visited realpaths in a per-feature
    // `seen` set and skips revisits.
    await writeFiles({
      "src/featA/a.ts": "a",
      "src/featA/a2.ts": "a2",
      "src/featB/b.ts": "b",
      "src/featB/b2.ts": "b2",
    });
    // featA/link-to-b → src/featB; featB/link-to-a → src/featA
    await symlink(
      resolve(projectRoot, "src/featB"),
      resolve(projectRoot, "src/featA/link-to-b"),
    );
    await symlink(
      resolve(projectRoot, "src/featA"),
      resolve(projectRoot, "src/featB/link-to-a"),
    );

    const start = Date.now();
    const result = await scanFeatures(projectRoot);
    const elapsed = Date.now() - start;

    // Termination guard: 2s is generous for a sub-100-file fixture; the
    // unbounded version would never terminate.
    expect(elapsed).toBeLessThan(2000);
    // Result is finite and includes both top-level features.
    const names = result.map((f) => f.name).sort();
    expect(names).toEqual(["featA", "featB"]);
  });

  test("self-symlink (`sym → .`) terminates and is skipped via realpath dedupe", async () => {
    await writeFiles({
      "src/featA/a.ts": "a",
      "src/featA/b.ts": "b",
    });
    // sym points at the parent dir featA itself.
    await symlink(
      resolve(projectRoot, "src/featA"),
      resolve(projectRoot, "src/featA/sym"),
    );

    const start = Date.now();
    const result = await scanFeatures(projectRoot);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);

    const featA = result.find((f) => f.name === "featA")!;
    expect(featA).toBeDefined();
    // The two real files are present; self-symlink content is not
    // re-walked.
    expect(featA.files).toContain("src/featA/a.ts");
    expect(featA.files).toContain("src/featA/b.ts");
  });

  test("symlink-to-parent (`sub/up → ..`) terminates without revisiting featA", async () => {
    await writeFiles({
      "src/featA/a.ts": "a",
      "src/featA/b.ts": "b",
      "src/featA/sub/c.ts": "c",
    });
    // sub/up symlinks back up to featA → realpath same as featA → seen.
    await symlink(
      resolve(projectRoot, "src/featA"),
      resolve(projectRoot, "src/featA/sub/up"),
    );

    const start = Date.now();
    const result = await scanFeatures(projectRoot);
    expect(Date.now() - start).toBeLessThan(2000);

    const featA = result.find((f) => f.name === "featA")!;
    expect(featA.files).toContain("src/featA/a.ts");
    expect(featA.files).toContain("src/featA/b.ts");
    expect(featA.files).toContain("src/featA/sub/c.ts");
    // The `up` symlink resolves to featA (already seen) → no infinite
    // recursion → no duplicate entries like "src/featA/sub/up/a.ts".
    const dupePaths = featA.files.filter((p) => p.includes("/sub/up/"));
    expect(dupePaths).toEqual([]);
  });
});

// ── D2: Scan caps regression (audit fix d25c126a) ───────────────────
describe("scanFeatures — depth + per-feature + total caps (D2)", () => {
  test("MAX_DEPTH=16 truncates pathologically deep trees", async () => {
    // Build src/deepFeat with 20 nested dirs each containing one file.
    // The cap (MAX_DEPTH=16) bounds recursion so the deepest files are
    // truncated rather than explored.
    const spec: Record<string, string> = {
      "src/deepFeat/seed.ts": "s", // anchor file at depth 1 so the feature isn't single-file
    };
    let pathPrefix = "src/deepFeat";
    for (let i = 0; i < 20; i++) {
      pathPrefix += `/d${i}`;
      spec[`${pathPrefix}/leaf.ts`] = "x";
    }
    await writeFiles(spec);

    const result = await scanFeatures(projectRoot);
    const deep = result.find((f) => f.name === "deepFeat")!;
    expect(deep).toBeDefined();
    // The seed + ~16 leaf files should appear; not all 20.
    expect(deep.files.length).toBeLessThan(20);
    expect(deep.files.length).toBeGreaterThanOrEqual(15);
    expect(deep.files).toContain("src/deepFeat/seed.ts");
  });

  test("MAX_FILES_PER_FEATURE=5000 caps a single feature's file count", async () => {
    // Generate 5500 files in src/featBig/ via a single batch mkdir + writes.
    // Use shallow placement to avoid the depth cap interacting.
    await mkdir(resolve(projectRoot, "src/featBig"), { recursive: true });
    const batchSize = 100;
    for (let batch = 0; batch < 55; batch++) {
      const writes: Array<Promise<void>> = [];
      for (let i = 0; i < batchSize; i++) {
        const idx = batch * batchSize + i;
        writes.push(
          writeFile(resolve(projectRoot, `src/featBig/f${idx}.ts`), `${idx}`),
        );
      }
      await Promise.all(writes);
    }

    const result = await scanFeatures(projectRoot);
    const big = result.find((f) => f.name === "featBig")!;
    expect(big).toBeDefined();
    // Cap is at 5000; we wrote 5500.
    expect(big.files.length).toBe(5000);
  }, 30000); // Extended timeout — file IO is the slow part.

  test("MAX_TOTAL_FILES=50000 caps the whole-scan output across features", async () => {
    // 25 features × 2500 files each = 62500 raw files. Each feature is
    // BELOW the per-feature cap (5000), so the per-feature truncation
    // doesn't dominate; the TOTAL cap (50000) is the binding limit
    // and clips the scan output to 50k.
    for (let f = 0; f < 25; f++) {
      const dir = `src/featTotal${f}`;
      await mkdir(resolve(projectRoot, dir), { recursive: true });
      for (let batch = 0; batch < 25; batch++) {
        const writes: Array<Promise<void>> = [];
        for (let i = 0; i < 100; i++) {
          const idx = batch * 100 + i;
          writes.push(
            writeFile(
              resolve(projectRoot, `${dir}/f${idx}.ts`),
              `${idx}`,
            ),
          );
        }
        await Promise.all(writes);
      }
    }

    const result = await scanFeatures(projectRoot);
    const totalFiles = result.reduce((sum, f) => sum + f.files.length, 0);
    // Hard upper bound: cap is 50000.
    expect(totalFiles).toBeLessThanOrEqual(50_000);
    // Sanity: cap actually engaged (would be 62500 without it). The scan
    // may stop slightly short of 50k as features are added wholesale per
    // root iteration — accept anything ≥ 45k as evidence of the cap.
    expect(totalFiles).toBeGreaterThan(45_000);
  }, 60000);
});

// ── Determinism ──────────────────────────────────────────────────────
describe("scanFeatures — determinism", () => {
  test("two runs against the same fixture produce identical output", async () => {
    await writeFiles({
      "src/components/a.ts": "a",
      "src/components/b.ts": "b",
      "web/src/components/c.ts": "c",
      "web/src/components/d.ts": "d",
      "packages/foo/src/utils/u.ts": "u",
      "packages/foo/src/utils/v.ts": "v",
      "packages/bar/src/api/api1.ts": "1",
      "packages/bar/src/api/api2.ts": "2",
    });
    const a = await scanFeatures(projectRoot);
    const b = await scanFeatures(projectRoot);
    expect(b).toEqual(a);
  });
});

// ── Shared-helper duplication assertion (PM headline ask) ────────────
describe("scan-fs shared module — anti-duplication invariant", () => {
  test("mention search endpoint imports EXCLUDED_DIR_NAMES + listFilteredChildren from scan-fs", async () => {
    // The PM specifically asked us to verify the helpers were not
    // re-implemented inside the autocomplete endpoint after extraction.
    // This is a static-text check on the +server.ts file source.
    const src = await readFile(
      resolve(__dirname, "../../web/src/routes/api/mentions/search/+server.ts"),
      "utf8",
    );
    // Either alias path is acceptable — both resolve to the same module.
    const importsFromShared =
      /from\s+["']\$server\/runtime\/fs\/scan-fs["']/.test(src) ||
      /from\s+["'](?:\.\.\/){2,}runtime\/fs\/scan-fs["']/.test(src);
    expect(importsFromShared).toBe(true);
    expect(src).toContain("listFilteredChildren");
    expect(src).toContain("EXCLUDED_DIR_NAMES");

    // No local re-declaration of EXCLUDED_DIR_NAMES (would be a regression).
    expect(/const\s+EXCLUDED_DIR_NAMES\s*=/.test(src)).toBe(false);
  });

  test("feature scanner imports the same helpers", async () => {
    const src = await readFile(
      resolve(__dirname, "../runtime/scan/feature-scan.ts"),
      "utf8",
    );
    expect(src).toMatch(/from\s+["']\.\.\/fs\/scan-fs["']/);
    // No local fork of the symlink-escape predicate.
    expect(/const\s+EXCLUDED_DIR_NAMES\s*=/.test(src)).toBe(false);
  });
});

// ── Direct unit coverage of the shared helper module ─────────────────
describe("listFilteredChildren", () => {
  test("returns empty when absDir escapes the root via symlink", async () => {
    const escapeLink = resolve(projectRoot, "escape");
    await symlink(outsideRoot, escapeLink);
    const out = await listFilteredChildren(projectRoot, escapeLink, "escape");
    expect(out).toEqual([]);
  });

  test("returns empty when absDir does not exist", async () => {
    const out = await listFilteredChildren(
      projectRoot,
      resolve(projectRoot, "nope"),
      "nope",
    );
    expect(out).toEqual([]);
  });

  test("filters dotfiles and EXCLUDED_DIR_NAMES at the dir level", async () => {
    await writeFiles({
      "src/keep.ts": "k",
      "src/.env": "x",
    });
    await makeDir("src/node_modules");
    await makeDir("src/.git");
    await makeDir("src/.ezcorp");
    await makeDir("src/realsub");

    const realRoot = projectRoot;
    const out = await listFilteredChildren(realRoot, resolve(projectRoot, "src"), "src");
    const names = out.map((c) => c.name).sort();
    expect(names).toEqual(["keep.ts", "realsub"]);
  });

  test("classifies symlinks-to-files as kind='file' (in-bounds)", async () => {
    await writeFiles({ "src/target.ts": "t" });
    await symlink(
      resolve(projectRoot, "src/target.ts"),
      resolve(projectRoot, "src/alias.ts"),
    );
    const out = await listFilteredChildren(
      projectRoot,
      resolve(projectRoot, "src"),
      "src",
    );
    const alias = out.find((c) => c.name === "alias.ts");
    expect(alias).toBeDefined();
    expect(alias!.kind).toBe("file");
  });

  test("EXCLUDED_DIR_NAMES contains node_modules, .git, .ezcorp", () => {
    expect(EXCLUDED_DIR_NAMES.has("node_modules")).toBe(true);
    expect(EXCLUDED_DIR_NAMES.has(".git")).toBe(true);
    expect(EXCLUDED_DIR_NAMES.has(".ezcorp")).toBe(true);
  });
});

describe("realpathInsideRoot", () => {
  test("true for the root itself", async () => {
    expect(await realpathInsideRoot(projectRoot, projectRoot)).toBe(true);
  });

  test("true for a descendant file", async () => {
    await writeFiles({ "src/a.ts": "a" });
    expect(
      await realpathInsideRoot(projectRoot, resolve(projectRoot, "src/a.ts")),
    ).toBe(true);
  });

  test("false for an external path", async () => {
    expect(await realpathInsideRoot(projectRoot, outsideRoot)).toBe(false);
  });

  test("false for a non-existent path (realpath fails)", async () => {
    expect(
      await realpathInsideRoot(projectRoot, resolve(projectRoot, "nope")),
    ).toBe(false);
  });

  test("false for a symlink that escapes the root", async () => {
    const escapeLink = resolve(projectRoot, "escape");
    await symlink(outsideRoot, escapeLink);
    expect(await realpathInsideRoot(projectRoot, escapeLink)).toBe(false);
  });

  test("guards against root-prefix lookalike (sibling that starts with same chars)", async () => {
    // realpathInsideRoot guards against `${realRoot}-evil` matching as
    // a prefix-of by requiring `===` OR `realRoot + "/"`. Verify:
    const sibling = `${projectRoot}-sibling`;
    await mkdir(sibling, { recursive: true });
    expect(await realpathInsideRoot(projectRoot, sibling)).toBe(false);
    await rm(sibling, { recursive: true, force: true });
  });
});
