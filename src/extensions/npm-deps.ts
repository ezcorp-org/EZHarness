/**
 * Extension npm-dependency contract (verify-only, v1).
 *
 * An extension may declare third-party npm packages it imports at runtime
 * via the manifest's optional `npmDependencies` map (npm registry name →
 * semver RANGE). Unlike ext-to-ext `dependencies`, these are NOT installed
 * by the host — they must already be present in the deployment's
 * `node_modules` (the HOST APP's, resolved from the app root, or vendored
 * under the extension's own dir). This module is the single DRY choke
 * point that VERIFIES them; install/activate/spawn/boot all call in here so
 * an unresolvable dependency surfaces one actionable operator message
 * instead of the opaque "Transport closed" crash-loop it caused before
 * (live incident 2026-07-11: `@zxing/library` missing from the image's
 * `/app/node_modules`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface NpmDepIssue {
  name: string;
  range: string;
  reason: "missing" | "version-mismatch";
  /** e.g. resolved version for mismatches */
  detail?: string;
}

export interface NpmDepCheck {
  ok: boolean;
  issues: NpmDepIssue[];
}

/**
 * Read the resolved package's own `version` off disk. Bun's isolated
 * linker resolves through
 * `node_modules/.bun/<name>@<ver>/node_modules/<name>/…`, so the LAST
 * `/node_modules/<name>/` segment of the resolved entry path is always the
 * real package dir. Returns null when the version can't be determined
 * (marker missing, package.json unreadable, or no string `version`) —
 * resolution already succeeded, so the caller treats null as "satisfied"
 * (never a false-positive mismatch).
 */
function readResolvedVersion(resolvedPath: string, name: string): string | null {
  const marker = `/node_modules/${name}/`;
  const idx = resolvedPath.lastIndexOf(marker);
  // idx === -1 (no marker) funnels through the same unreadable path as a
  // missing package.json — join onto the full resolved file, whose
  // `/package.json` child never exists, so readFileSync throws → null.
  const pkgDir = idx === -1 ? resolvedPath : resolvedPath.slice(0, idx + marker.length);
  try {
    const parsed = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a package to SOME real file inside it, robust to SUBPATH-ONLY
 * packages whose root export is absent (e.g. `@modelcontextprotocol/sdk`,
 * which only exports `.../client/index.js` — `Bun.resolveSync(name)`
 * throws for it even when it's installed). Try the package's own
 * `package.json` FIRST (addressable for such packages, and it hands the
 * version read the real package dir via the last-segment heuristic), then
 * the bare specifier. Returns null only when the package isn't installed.
 */
function resolvePackageEntry(name: string, fromDir: string): string | null {
  try {
    return Bun.resolveSync(`${name}/package.json`, fromDir);
  } catch {
    /* subpath-only / exports-restricted package.json — fall through */
  }
  try {
    return Bun.resolveSync(name, fromDir);
  } catch {
    return null;
  }
}

/** Verify every declared dep resolves from `fromDir` and satisfies its range. */
export function verifyNpmDependencies(
  npmDependencies: Record<string, string> | undefined,
  fromDir: string,
): NpmDepCheck {
  const issues: NpmDepIssue[] = [];
  if (!npmDependencies) return { ok: true, issues };
  for (const [name, range] of Object.entries(npmDependencies)) {
    const resolved = resolvePackageEntry(name, fromDir);
    if (resolved === null) {
      issues.push({ name, range, reason: "missing" });
      continue;
    }
    const version = readResolvedVersion(resolved, name);
    // Resolution succeeded but the version is indeterminate → satisfied.
    if (version === null) continue;
    if (!Bun.semver.satisfies(version, range)) {
      issues.push({ name, range, reason: "version-mismatch", detail: version });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** One actionable operator-facing message shared by installer/activate/spawn/boot. */
export function formatNpmDepError(extensionName: string, issues: NpmDepIssue[]): string {
  const parts = issues.map((i) =>
    i.reason === "missing"
      ? `${i.name}@${i.range} (missing)`
      : `${i.name}@${i.range} (found ${i.detail}, needs ${i.range})`,
  );
  return (
    `Extension "${extensionName}" requires npm package(s) it cannot resolve: ${parts.join(", ")}. ` +
    `Install them in the deployment (root package.json + bun install, or rebuild the image), then retry.`
  );
}
