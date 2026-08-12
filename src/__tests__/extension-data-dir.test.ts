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
import { join, sep } from "node:path";
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

  test("an absolute name is contained, not escaped", () => {
    // `join(base, "/etc")` is `<base>/etc`, not `/etc` — a leading separator
    // is just a segment to `join`. So an absolute name does not need to be
    // REFUSED to be safe; it is already neutralized. Assert the property
    // that actually matters, which holds either way: whenever the predicate
    // says yes, the directory it authorized is strictly inside the base.
    const name = join(sep, "etc");
    expect(isRemovableDataDir(name, ROOT)).toBe(true);
    expect(extensionDataDir(name, ROOT)).toBe(join(BASE, "etc"));
  });

  test("says yes ONLY for a directory strictly inside the base", () => {
    // The invariant every refusal above is an instance of. Stated once
    // over the whole set so a future change to how the path is built
    // (`join` → `resolve`, say, which does NOT neutralize a leading
    // separator) cannot quietly authorize a delete outside the base.
    const names = [
      "task-tracking",
      "",
      ".",
      "..",
      join("..", ".."),
      join(sep, "etc"),
      join("..", "extension-data-backup", "notes"),
      join("scoped", "notes"),
    ];
    for (const name of names) {
      if (!isRemovableDataDir(name, ROOT)) continue;
      expect(extensionDataDir(name, ROOT).startsWith(BASE + sep)).toBe(true);
    }
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

  test("a nested name stays inside the base and is removable", () => {
    // Not a name any installer produces (`manifest.ts` pins names to a
    // single segment), but it resolves inside the base, so the predicate
    // must say so rather than accidentally refusing on the separator.
    expect(isRemovableDataDir(join("scoped", "notes"), ROOT)).toBe(true);
  });
});
