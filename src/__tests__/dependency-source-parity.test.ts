/**
 * LOCKSTEP guard: every dependency `source` the extension-author
 * composition picker can emit MUST be accepted by the host's manifest
 * validator.
 *
 * The bug this exists to make impossible:
 *
 *   The picker wrote the picked row's source verbatim into the managed
 *   `dependencies` block, while `validateDependencies` ran EVERY source
 *   through `parseSource` — which only accepts git-cloneable refs. Every
 *   extension the picker can offer is already installed, so no composed
 *   dependency could survive install. It failed 100% of the time, in
 *   every deployment, with a 422 at the very last step:
 *
 *     Invalid manifest: dependencies.<dep>.source is invalid:
 *     Unrecognized source format: "bundled"
 *
 * Nothing checked the two sides against each other, so the mismatch was
 * INVISIBLE: the panel renders the dep chip, the draft PUT succeeds, the
 * config on disk looks right. Only Install disagrees. Both sides also
 * pass every one of their own unit tests, because each is internally
 * consistent — a defect only a cross-side assertion can see.
 *
 * Same pairing pattern (and same reason) as
 * `author-draft-allowlist-parity.test.ts`: two deliberately independent
 * declarations, plus a test that fails the moment they drift.
 *
 * The three legs:
 *   1. PARITY   — every `PICKER_DEPENDENCY_SOURCES` entry validates.
 *   2. CLOSURE  — `dependencySourceFor` over its WHOLE input domain only
 *                 ever returns members of that set, and the panel does
 *                 not bypass it with an inlined literal. Without this,
 *                 leg 1 could pass while the component emits something
 *                 else entirely (which is exactly what it used to do).
 *   3. STRICTNESS — the validator did NOT get loosened for clone paths:
 *                 arbitrary, option-shaped and metacharacter-laden
 *                 sources are still rejected.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDependencies } from "../extensions/manifest";
import {
  PREINSTALLED_DEPENDENCY_SOURCES,
  isPreinstalledDependencySource,
  validateDependencySource,
} from "../extensions/dependency-source";
import { parseSource } from "../extensions/source-parser";
// Imported from `dependency-picker` — the narrow module that owns these
// — NOT from `ezcorp-config-edit`, which re-exports them for the panel.
// This test is coverage-instrumented, so importing the wider module
// pulled its whole source-text editor in as a zero-hit lcov record that
// merge-lcov unioned with the vitest leg's clean 100%, reporting a
// fully-tested file at 83.97%. Import only what this test exercises.
import {
  PICKER_DEPENDENCY_SOURCES,
  VIRTUAL_BUILTIN_EXTENSION_ID,
  dependencySourceFor,
  isPickableDependency,
  toDependencyEntry,
} from "../../web/src/lib/dependency-picker";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PANEL = join(
  REPO_ROOT,
  "web/src/lib/components/extensions/AuthorCompositionPanel.svelte",
);

/** Validate a one-entry dependency record carrying `source`. */
function validateOne(source: string, version = "^1.0.0") {
  return validateDependencies({ "some-dep": { source, version } });
}

describe("dependency-source parity — picker ↔ manifest validator", () => {
  // ── 1. PARITY ────────────────────────────────────────────────────

  test("every source form the picker can emit is accepted by validateDependencies", () => {
    for (const source of PICKER_DEPENDENCY_SOURCES) {
      const r = validateOne(source);
      expect(
        r.valid,
        `the composition picker can emit source "${source}", but validateDependencies rejects it: ${r.errors.join(", ")} — teach src/extensions/dependency-source.ts about it (or stop emitting it)`,
      ).toBe(true);
      expect(r.errors).toEqual([]);
    }
  });

  test("every source form the picker can emit has a defined INSTALL semantic", () => {
    // Validation passing is not enough: the installer must also know what
    // to do with the string. Exactly one of the two must hold — resolve
    // by name against the installed set, or clone it.
    for (const source of PICKER_DEPENDENCY_SOURCES) {
      const preinstalled = isPreinstalledDependencySource(source);
      const cloneable = (() => {
        try {
          parseSource(source);
          return true;
        } catch {
          return false;
        }
      })();
      expect(
        preinstalled !== cloneable,
        `source "${source}" must be EITHER preinstalled-resolvable OR git-cloneable, not ${preinstalled ? "both" : "neither"}`,
      ).toBe(true);
    }
  });

  test("a full picker-built dependency entry validates end to end", () => {
    // The real shape the panel writes, for both branches of
    // `dependencySourceFor` — name + emitted source + caret version.
    for (const isBundled of [true, false]) {
      const entry = toDependencyEntry({
        id: "ext-1",
        name: "some-dep",
        version: "1.2.3",
        isBundled,
      });
      const r = validateDependencies({
        [entry.name]: { source: entry.source, version: entry.version },
      });
      expect(r.valid, `${entry.source}: ${r.errors.join(", ")}`).toBe(true);
      expect(entry.version).toBe("^1.2.3");
    }
  });

  // ── 2. CLOSURE ───────────────────────────────────────────────────

  test("dependencySourceFor only ever returns a declared picker source", () => {
    // The WHOLE input domain of the flag it branches on.
    for (const isBundled of [true, false, undefined]) {
      const emitted = dependencySourceFor({ isBundled });
      expect(
        (PICKER_DEPENDENCY_SOURCES as readonly string[]).includes(emitted),
        `dependencySourceFor({isBundled:${String(isBundled)}}) returned "${emitted}", which is not in PICKER_DEPENDENCY_SOURCES`,
      ).toBe(true);
    }
    expect(dependencySourceFor({ isBundled: true })).toBe("bundled");
    expect(dependencySourceFor({ isBundled: false })).toBe("local");
    expect(dependencySourceFor({})).toBe("local");
  });

  test("the composition panel does not inline its own dependency source literal", () => {
    // The closure above is only meaningful while the component actually
    // GOES THROUGH `toDependencyEntry`. The original bug was a hardcoded
    // `source: "bundled"` in this file, invisible to every unit test on
    // either side.
    const src = readFileSync(PANEL, "utf8");
    expect(src).toContain("toDependencyEntry");
    const inlined = [...src.matchAll(/source:\s*["'`]/g)];
    expect(
      inlined.length,
      `${PANEL} inlines a dependency source literal; build entries with toDependencyEntry() so the parity test can see the emitted forms`,
    ).toBe(0);
  });

  test("the preinstalled set is exactly the two documented forms", () => {
    // Pins the shape itself, so widening it has to be deliberate and
    // lands in the same review as the installer change that handles it.
    expect([...PREINSTALLED_DEPENDENCY_SOURCES].sort()).toEqual([
      "bundled",
      "local",
    ]);
    expect([...PICKER_DEPENDENCY_SOURCES].sort()).toEqual(["bundled", "local"]);
  });

  // ── 3. STRICTNESS (no loosening for clone paths) ──────────────────

  test("genuinely cloneable sources are still accepted", () => {
    for (const source of [
      "github:user/repo",
      "github:user/repo@v1.2.3",
      "gitlab:org/project",
      "https://example.com/repo.git",
      "git@github.com:user/repo.git",
    ]) {
      expect(validateOne(source).valid, source).toBe(true);
    }
  });

  test("an arbitrary non-cloneable string is still rejected", () => {
    for (const source of [
      "builtin",
      "installed",
      "bundled:foo",
      "Bundled",
      "local:/tmp/x",
      "",
      "  ",
      "../../etc/passwd",
      "npm:left-pad",
    ]) {
      const r = validateOne(source);
      expect(r.valid, `source "${source}" must NOT be accepted`).toBe(false);
      expect(r.errors.some((e) => e.includes("some-dep"))).toBe(true);
    }
  });

  test("option-shaped and metacharacter refs are still rejected", () => {
    for (const source of [
      "github:user/repo@--upload-pack=touch /tmp/pwned",
      "github:user/repo@$(id)",
      "gitlab:org/project@-x",
      "https://example.com/repo.git@bad;ref",
    ]) {
      expect(validateOne(source).valid, source).toBe(false);
    }
  });

  test("the rejection message points at the non-cloneable forms", () => {
    const msg = validateDependencySource("totally-bogus");
    expect(msg).not.toBeNull();
    for (const form of PREINSTALLED_DEPENDENCY_SOURCES) {
      expect(msg).toContain(`"${form}"`);
    }
  });
});

describe("dependency picker — what may be offered as a dependency", () => {
  test("the virtual builtin row is not a pickable dependency", () => {
    // Seeded by `src/db/migrate.ts` so native tool calls have an
    // extension_id. Not a real extension: depending on it produces a
    // manifest naming something that can never resolve.
    expect(
      isPickableDependency({ id: VIRTUAL_BUILTIN_EXTENSION_ID, source: "builtin" }),
    ).toBe(false);
    // Excluded on EITHER marker alone, so a row identified only one way
    // still cannot slip through.
    expect(isPickableDependency({ id: "builtin", source: "local:/x" })).toBe(false);
    expect(isPickableDependency({ id: "ext-9", source: "builtin" })).toBe(false);
  });

  test("real installed extensions stay pickable", () => {
    expect(isPickableDependency({ id: "ext-1", source: "local:/x" })).toBe(true);
    expect(isPickableDependency({ id: "ext-2", source: "github:u/r" })).toBe(true);
    expect(isPickableDependency({ id: "ext-3" })).toBe(true);
    expect(isPickableDependency({ id: "ext-4", source: null })).toBe(true);
  });

  test("the virtual builtin id matches what the migration seeds", () => {
    const migrate = readFileSync(join(REPO_ROOT, "src/db/migrate.ts"), "utf8");
    expect(migrate).toContain(`VALUES ('${VIRTUAL_BUILTIN_EXTENSION_ID}', 'Built-in Tools'`);
  });
});
