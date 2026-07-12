/**
 * Static dependency audit (kills "Mode A" — an undeclared runtime npm
 * import): walk every example + bundled extension's RUNTIME source, extract
 * the bare (non-relative, non-node:, non-bun:, non-@ezcorp) import
 * specifiers, and assert each one is BOTH (a) declared in that extension's
 * manifest `npmDependencies` AND (b) present in the app root
 * `package.json` dependencies. This is the compile-time guarantee that a
 * subprocess can never import a package the deployment didn't ship — the
 * exact drift the live incident (2026-07-11) hit with `@zxing/library`.
 *
 * Extensions that ship their OWN `package.json` (workspace packages like
 * `@ezcorp/ai-kit`, and the `extensions/*` bundled ports) declare + resolve
 * their deps the standard npm way, so they are exempt from the
 * manifest-`npmDependencies` contract (which is for extensions that resolve
 * from the HOST app's node_modules).
 *
 * Spec: tasks/extension-npm-deps.md.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { loadManifestFresh } from "../extensions/loader";
import { resolveBundledExtensions } from "../extensions/bundled";

const ROOT = join(import.meta.dir, "..", "..");

// Node builtins, with and without the `node:` prefix — some example code
// still imports `fs`/`path` bare. Neither form is an npm dependency.
const BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

// npm package-name grammar (same shape the manifest validator enforces).
// Also filters out any structural regex garbage (whitespace, punctuation).
const NPM_PKG_NAME_REGEX = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

// Static import/export + dynamic import + require + bare side-effect import.
// The clause between `import|export` and `from` only admits import-clause
// chars (identifiers / `*` / braces / commas / whitespace), so a stray
// `.from("x")` method call never matches. Kept simple + deterministic.
const IMPORT_RE =
  /(?:import|export)(?:[\w*{}\n\r\t, ]+)from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

const EXCLUDE_SEGMENTS = ["/app/", "/__tests__/", "/__fixtures__/", "/scripts/"];

/** The npm package a specifier belongs to (`@scope/pkg/sub` → `@scope/pkg`). */
function packageOf(spec: string): string {
  return spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
}

function isBare(spec: string): boolean {
  return (
    !spec.startsWith(".") &&
    !spec.startsWith("/") &&
    !spec.startsWith("node:") &&
    !spec.startsWith("bun:")
  );
}

/** Collect third-party npm package names imported by a dir's runtime .ts
 *  files → the relative file(s) where each was seen (for failure text). */
function collectThirdPartyImports(absDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const glob = new Glob("**/*.ts");
  for (const rel of glob.scanSync(absDir)) {
    if (rel.endsWith(".test.ts")) continue;
    const posix = `/${rel.replaceAll("\\", "/")}/`;
    if (EXCLUDE_SEGMENTS.some((seg) => posix.includes(seg))) continue;
    const src = readFileSync(join(absDir, rel), "utf8");
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || !isBare(spec)) continue;
      const pkg = packageOf(spec);
      if (pkg.startsWith("@ezcorp/") || BUILTINS.has(pkg) || !NPM_PKG_NAME_REGEX.test(pkg)) {
        continue;
      }
      const seen = out.get(pkg) ?? [];
      if (!seen.includes(rel)) seen.push(rel);
      out.set(pkg, seen);
    }
  }
  return out;
}

/** All extension dirs in scope: every example dir + every bundled dir. */
function auditDirs(): string[] {
  const dirs = new Set<string>();
  for (const rel of new Glob("docs/extensions/examples/*/ezcorp.config.ts").scanSync(ROOT)) {
    dirs.add(dirname(rel));
  }
  for (const entry of resolveBundledExtensions()) {
    dirs.add(entry.path);
  }
  return [...dirs].sort();
}

const ROOT_DEPS = new Set<string>(
  Object.keys(
    (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    }).dependencies ?? {},
  ),
);

describe("extension third-party dependency audit", () => {
  test("every runtime npm import is declared in npmDependencies AND present in root deps", async () => {
    const failures: string[] = [];

    for (const dir of auditDirs()) {
      const absDir = join(ROOT, dir);
      if (!existsSync(absDir)) continue;
      // Extensions with their OWN package.json declare + resolve deps the
      // standard npm way (workspace packages / bundled ports) — exempt from
      // the manifest-npmDependencies contract.
      if (existsSync(join(absDir, "package.json"))) continue;

      const imports = collectThirdPartyImports(absDir);
      if (imports.size === 0) continue;

      let declared = new Set<string>();
      try {
        const manifest = await loadManifestFresh(absDir);
        declared = new Set(Object.keys(manifest.npmDependencies ?? {}));
      } catch (err) {
        failures.push(
          `${dir}: imports third-party package(s) but its manifest could not be ` +
            `loaded to check npmDependencies (${err instanceof Error ? err.message : String(err)})`,
        );
      }

      for (const [pkg, files] of imports) {
        if (!declared.has(pkg)) {
          failures.push(
            `${dir}: imports "${pkg}" (e.g. ${files[0]}) but does NOT declare it in ` +
              `the manifest's npmDependencies`,
          );
        }
        if (!ROOT_DEPS.has(pkg)) {
          failures.push(
            `${dir}: imports "${pkg}" (e.g. ${files[0]}) but it is MISSING from the app ` +
              `root package.json dependencies`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("the two headline consumers declare their known deps (guards the audit itself)", async () => {
    // A positive control so a broken regex/loader can't silently pass the
    // audit above by finding zero imports.
    const scanner = collectThirdPartyImports(
      join(ROOT, "docs/extensions/examples/graded-card-scanner"),
    );
    expect([...scanner.keys()].sort()).toEqual(["@zxing/library", "fast-png", "jpeg-js"]);

    const excel = collectThirdPartyImports(join(ROOT, "docs/extensions/examples/excel"));
    expect([...excel.keys()]).toEqual(["exceljs"]);
  });
});
