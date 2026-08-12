/**
 * `src/extensions/extension-data-dir.ts` — the path an extension's data
 * lives at, and the containment rule the uninstall `rm -rf` runs first.
 *
 * The predicate is the interesting half. `isRemovableDataDir` authorizes a
 * RECURSIVE delete against a name read back out of the database, so the
 * cases below are the ones that decide whether a bad name deletes the
 * wrong tree: traversal (`..`), an absolute name, the base directory
 * itself, and the sibling-prefix (`extension-data-backup`) that a bare
 * `startsWith(base)` would wrongly admit.
 *
 * Every assertion is pure path arithmetic against an explicit `root`, so
 * this file touches no filesystem and needs no project-root override.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  extensionDataBaseDir,
  extensionDataDir,
  isRemovableDataDir,
} from "../extensions/extension-data-dir";

const ROOT = join(sep, "srv", "ezcorp");
const BASE = join(ROOT, ".ezcorp", "extension-data");

describe("extensionDataBaseDir / extensionDataDir", () => {
  test("base is <root>/.ezcorp/extension-data", () => {
    expect(extensionDataBaseDir(ROOT)).toBe(BASE);
  });

  test("an extension's dir is the base joined with its manifest name", () => {
    expect(extensionDataDir("task-tracking", ROOT)).toBe(join(BASE, "task-tracking"));
  });

  test("both default their root to getProjectRoot()", () => {
    // Not asserting WHICH root — that is `project-root.ts`'s contract, and
    // pinning it here would just restate it. What matters is that the two
    // defaults agree, so a caller that omits `root` cannot get a data dir
    // outside the base the predicate checks against.
    expect(extensionDataDir("notes").startsWith(extensionDataBaseDir() + sep)).toBe(true);
  });
});

describe("isRemovableDataDir", () => {
  test("accepts an ordinary manifest name", () => {
    expect(isRemovableDataDir("task-tracking", ROOT)).toBe(true);
  });

  test("accepts every character class the manifest name pattern allows", () => {
    for (const name of ["a", "ez-factory", "ai_kit", "web.search", "x0123456789"]) {
      expect(isRemovableDataDir(name, ROOT)).toBe(true);
    }
  });

  // ── Refusals: each one is a directory outside the base ───────────────

  test("refuses a traversal that escapes the base", () => {
    for (const name of ["..", join("..", ".."), join("..", "extensions", "ez-factory")]) {
      expect(isRemovableDataDir(name, ROOT)).toBe(false);
    }
  });

  test("refuses an absolute name", () => {
    expect(isRemovableDataDir(join(sep, "etc"), ROOT)).toBe(false);
  });

  // ── The hole this predicate shipped with ────────────────────────────
  //
  // Containment alone is NOT enough, and the first cut of this function
  // checked only containment (`startsWith(base + sep)`). A name that walks
  // OUT of the base and back IN stays "inside" while naming a DIFFERENT
  // extension's store, so `DELETE /api/extensions/:id?purgeData=1` on a row
  // carrying that name erased a built-in's data. It was reachable: the MCP
  // install route synthesises its manifest and never runs `manifest.ts`'s
  // name validation.

  test("refuses a name that walks out of the base and back in", () => {
    for (const name of [
      join("..", "extension-data", "task-tracking"),
      join("x", "..", "..", "extension-data", "ask-user"),
      join("..", "..", ".ezcorp", "extension-data", "ask-user"),
    ]) {
      expect(isRemovableDataDir(name, ROOT)).toBe(false);
    }
  });

  test("refuses a nested name — a data dir is exactly one level down", () => {
    // Previously accepted, because it too is `startsWith` the base.
    expect(isRemovableDataDir(join("scoped", "notes"), ROOT)).toBe(false);
  });

  test("says yes ONLY for a DIRECT CHILD of the base", () => {
    // The invariant every refusal above is an instance of, stated once over
    // the whole set: whenever the predicate says yes, the directory it
    // authorized is a single segment inside the base — never deeper, never
    // elsewhere. A future change to how the path is built cannot quietly
    // widen this without failing here.
    const names = [
      "task-tracking",
      "",
      ".",
      "..",
      join("..", ".."),
      join(sep, "etc"),
      join("..", "extension-data", "ask-user"),
      join("..", "extension-data-backup", "notes"),
      join("scoped", "notes"),
      "../",
      "a/b/../..",
    ];
    for (const name of names) {
      if (!isRemovableDataDir(name, ROOT)) continue;
      expect(dirname(extensionDataDir(name, ROOT))).toBe(BASE);
    }
  });

  test("the accepted name shape is byte-identical to the manifest's", () => {
    // The predicate restates `NAME_REGEX` rather than importing it, to keep
    // this module a leaf. That is only safe while the two agree, so pin the
    // literal against its source of truth.
    const manifestSrc = readFileSync(
      join(import.meta.dir, "..", "extensions", "manifest.ts"),
      "utf8",
    );
    const dataDirSrc = readFileSync(
      join(import.meta.dir, "..", "extensions", "extension-data-dir.ts"),
      "utf8",
    );
    const pattern = /\/\^\[a-z0-9\]\[a-z0-9\-_.\]\{0,63\}\$\//;
    expect(manifestSrc).toMatch(pattern);
    expect(dataDirSrc).toMatch(pattern);
  });

  test("refuses a name that resolves to the base itself", () => {
    // `join(base, "")` is the base, and `join(base, ".")` normalizes to it —
    // both would mean "delete every extension's stored data".
    expect(isRemovableDataDir("", ROOT)).toBe(false);
    expect(isRemovableDataDir(".", ROOT)).toBe(false);
  });

  test("refuses a null/undefined name", () => {
    expect(isRemovableDataDir(null, ROOT)).toBe(false);
    expect(isRemovableDataDir(undefined, ROOT)).toBe(false);
  });

  test("refuses a sibling directory sharing the base's prefix", () => {
    // `<base>-backup` starts with `<base>` but is NOT inside it. This is the
    // case the trailing separator in the predicate exists for; deleting it
    // would take a backup nobody asked to remove.
    const escaping = join("..", "extension-data-backup", "notes");
    expect(isRemovableDataDir(escaping, ROOT)).toBe(false);
  });

  test("refuses every character class the manifest name pattern excludes", () => {
    for (const name of [
      "Uppercase",
      "-leading-dash",
      ".leading-dot",
      "has space",
      "has/slash",
      "has\\backslash",
      "a".repeat(65),
    ]) {
      expect(isRemovableDataDir(name, ROOT)).toBe(false);
    }
  });
});
