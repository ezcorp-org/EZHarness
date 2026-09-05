import { test, expect, describe, afterAll } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { useTempProjectRoot } from "./helpers/temp-project-root";
import { allowedInstallRoots, authoredExtensionsDir, downloadedExtensionsDir, isRemovableInstallPath, resolveInstallPath } from "../extensions/install-roots";

const TMP_ROOT = useTempProjectRoot("install-roots-");
afterAll(() => TMP_ROOT.cleanup());

describe("resolveInstallPath", () => {
  test("null / undefined / empty in, null out", () => {
    expect(resolveInstallPath(null)).toBeNull();
    expect(resolveInstallPath(undefined)).toBeNull();
    expect(resolveInstallPath("")).toBeNull();
  });

  test("an already-absolute path is returned unchanged (every genuinely external install)", () => {
    expect(resolveInstallPath("/opt/elsewhere/my-ext")).toBe("/opt/elsewhere/my-ext");
    // Even one that happens to sit under the resolved root: absolute means
    // "trust it verbatim", no reconstruction attempted.
    const underRoot = join(TMP_ROOT.root, "my-ext");
    expect(resolveInstallPath(underRoot)).toBe(underRoot);
  });

  test("a relative path resolves against the DEFAULT root (getProjectRoot())", () => {
    expect(resolveInstallPath("docs/extensions/examples/web-search")).toBe(
      join(TMP_ROOT.root, "docs/extensions/examples/web-search"),
    );
    expect(resolveInstallPath("extensions/ez-factory")).toBe(
      join(TMP_ROOT.root, "extensions/ez-factory"),
    );
    expect(resolveInstallPath("packages/@ezcorp/ai-kit")).toBe(
      join(TMP_ROOT.root, "packages/@ezcorp/ai-kit"),
    );
  });

  test("an explicit root argument overrides the default", () => {
    expect(resolveInstallPath("docs/extensions/examples/web-search", "/app")).toBe(
      "/app/docs/extensions/examples/web-search",
    );
  });

  test("this is the exact reconstruction of a bundled entry's resolvedPath", () => {
    // bundled.ts computes `join(getProjectRoot(), entry.path)` to READ the
    // files and persists `entry.path` via `persistPath`. resolveInstallPath
    // must invert that exactly, from whichever root the CURRENT process
    // resolves.
    const entryPath = "docs/extensions/examples/web-search";
    const resolvedAtInstallTime = join(TMP_ROOT.root, entryPath);
    expect(resolveInstallPath(entryPath)).toBe(resolvedAtInstallTime);
  });
});

describe("install-path containment predicate", () => {
  test("allowedInstallRoots is the host-owned install bases, one per writer", () => {
    expect(allowedInstallRoots()).toEqual([
      join(TMP_ROOT.root, "data", "extensions"),
      join(TMP_ROOT.root, ".ezcorp", "extensions"),
    ]);
    // A registered project adds ITS `.ezcorp/extensions`, appended — the
    // static two are never displaced.
    expect(allowedInstallRoots(["/srv/proj", "relative/proj"])).toEqual([
      join(TMP_ROOT.root, "data", "extensions"),
      join(TMP_ROOT.root, ".ezcorp", "extensions"),
      join("/srv/proj", ".ezcorp", "extensions"),
      // A relative `projects.path` resolves against cwd like everything else.
      join(TMP_ROOT.root, "relative/proj", ".ezcorp", "extensions"),
    ]);
  });

  test("downloadedExtensionsDir stays relative (resolved against cwd)", () => {
    expect(downloadedExtensionsDir()).toBe(join("data", "extensions"));
    expect(resolve(process.cwd(), downloadedExtensionsDir())).toBe(
      allowedInstallRoots()[0],
    );
  });

  test("authoredExtensionsDir is `<root>/.ezcorp/extensions`", () => {
    expect(authoredExtensionsDir("/srv/proj")).toBe(join("/srv/proj", ".ezcorp", "extensions"));
    expect(resolve(authoredExtensionsDir(TMP_ROOT.root))).toBe(allowedInstallRoots()[1]);
  });

  test("an empty install path is refused even from INSIDE a root", async () => {
    // `resolve(cwd, "")` is `cwd`. Run from inside an allowed root and a
    // blank `install_path` would resolve to a real, contained directory —
    // i.e. "delete my working directory" — without the explicit
    // empty-string guard. Asserting it from anywhere else proves nothing:
    // a cwd outside every root is refused for the ordinary reason.
    //
    // It has to be the `.ezcorp/extensions` root, not `data/extensions`:
    // that one is cwd-RELATIVE, so chdir'ing into it moves it too.
    const inside = join(TMP_ROOT.root, ".ezcorp", "extensions", "cwd-probe");
    await mkdir(inside, { recursive: true });
    const savedCwd = process.cwd();
    process.chdir(inside);
    try {
      expect(resolve(process.cwd(), "")).toBe(inside);
      expect(isRemovableInstallPath("")).toBe(false);
      expect(isRemovableInstallPath(null)).toBe(false);
      expect(isRemovableInstallPath(undefined)).toBe(false);
      // Same cwd, a non-empty path: still contained, so the guard is
      // rejecting the EMPTY value, not the location.
      expect(isRemovableInstallPath(".")).toBe(true);
    } finally {
      process.chdir(savedCwd);
    }
  });

  test("accepts installs inside either root, at any depth", () => {
    for (const p of [
      join("data", "extensions", "weather"),
      join(TMP_ROOT.root, "data", "extensions", "weather"),
      join(TMP_ROOT.root, "data", "extensions", "weather", "nested"),
      join(".ezcorp", "extensions", "ai-kit"),
      join(TMP_ROOT.root, ".ezcorp", "extensions", "ai-kit"),
      // Traversal that lands back inside a root is fine — the rule is
      // about where the path RESOLVES, not how it is spelled.
      join("data", "extensions", "x", "..", "weather"),
    ]) {
      expect(isRemovableInstallPath(p)).toBe(true);
    }
  });

  test("a registered project's .ezcorp/extensions is accepted, its siblings are not", () => {
    const projectPath = join(TMP_ROOT.root, "proj");
    const roots = [projectPath];

    expect(isRemovableInstallPath(join(projectPath, ".ezcorp", "extensions", "skill"), roots)).toBe(
      true,
    );
    // Base itself, a sibling tree, and the project dir at large stay out.
    for (const p of [
      join(projectPath, ".ezcorp", "extensions"),
      join(projectPath, ".ezcorp", "extension-data", "skill"),
      join(projectPath, "src"),
      projectPath,
    ]) {
      expect(isRemovableInstallPath(p, roots)).toBe(false);
    }
    // …and without the project registered, nothing under it is removable.
    expect(isRemovableInstallPath(join(projectPath, ".ezcorp", "extensions", "skill"))).toBe(false);
  });

  test("refuses every bundled-extension install path shape", () => {
    // The 28 bundled entries resolve to `join(getProjectRoot(), entry.path)`.
    for (const relPath of [
      "docs/extensions/examples/scratchpad",
      "docs/extensions/examples/task-tracking",
      "extensions/ez-factory",
      "extensions/lessons-distiller",
      "extensions/memory-extractor",
      "packages/@ezcorp/ai-kit",
    ]) {
      expect(isRemovableInstallPath(join(TMP_ROOT.root, relPath))).toBe(false);
      expect(isRemovableInstallPath(relPath)).toBe(false);
    }
  });

  test("refuses escapes, near-misses and the roots themselves", () => {
    for (const p of [
      "../../etc",
      "/etc",
      "/home/user/extensions/notes",
      "/var/lib/extensions/",
      join("data", "extensions-backup", "weather"),
      join("data", "extensions"),
      join(TMP_ROOT.root, "data", "extensions"),
      join(TMP_ROOT.root, ".ezcorp", "extensions"),
      // Resolves back OUT of the root.
      join("data", "extensions", "..", "..", "etc"),
    ]) {
      expect(isRemovableInstallPath(p)).toBe(false);
    }
  });
});
