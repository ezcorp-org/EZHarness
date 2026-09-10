#!/usr/bin/env bun
/** Fail closed if a final browser-coverage raw manifest omits a scripted route. */
import { BROWSER_CANONICAL_SOURCES, REPO_ROOT } from "./coverage-config.ts";
import type { RawCoverage } from "./browser-coverage-to-lcov.ts";

export function scriptedRouteFiles(): string[] {
  return [...new Bun.Glob("web/src/routes/**/+*.svelte").scanSync({ cwd: REPO_ROOT, onlyFiles: true })]
    .map((path) => path.replaceAll("\\", "/"))
    .sort();
}

export function assertCompleteRouteInventory(expected: readonly string[]): void {
  const actual = scriptedRouteFiles();
  const given = [...expected].sort();
  const duplicates = given.filter((path, i) => i > 0 && path === given[i - 1]);
  const missing = actual.filter((path) => !given.includes(path));
  const extra = given.filter((path) => !actual.includes(path));
  if (duplicates.length || missing.length || extra.length) {
    throw new Error(
      `browser coverage route inventory is incomplete: expected all ${actual.length} scripted routes; ` +
      `missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"} ` +
      `duplicates=${duplicates.join(",") || "none"}`,
    );
  }
}

export function assertBrowserCanonicalSources(expected: readonly string[]): void {
  const missing = BROWSER_CANONICAL_SOURCES.filter((source) => !expected.includes(source));
  if (missing.length > 0) {
    throw new Error(`browser coverage source inventory is incomplete: missing=${missing.join(",")}`);
  }
}

if (import.meta.main) {
  const [flag, rawPath] = process.argv.slice(2);
  if (flag !== "--check" || !rawPath) {
    throw new Error("usage: browser-route-coverage-manifest.ts --check <raw.json>");
  }
  const raw = await Bun.file(rawPath).json() as RawCoverage;
  assertCompleteRouteInventory(raw.expectedRouteFiles ?? []);
  assertBrowserCanonicalSources(raw.expectedFiles ?? []);
  console.log(`verified ${scriptedRouteFiles().length} scripted Svelte routes and ${BROWSER_CANONICAL_SOURCES.length} browser source(s)`);
}
