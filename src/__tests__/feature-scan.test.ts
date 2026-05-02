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
