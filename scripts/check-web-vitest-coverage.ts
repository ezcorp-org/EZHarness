#!/usr/bin/env bun
/** Fail when a shipped, executable shared-web source has no V8 DA record. */
import { Glob } from "bun";
import { relative, resolve } from "node:path";
import { isDeclarationOnlyTypeScript, isExcluded, REPO_ROOT } from "./coverage-config.ts";

export function lcovSourceFiles(lcov: string): Set<string> {
  const files = new Set<string>();
  let current: string | null = null;
  let hasData = false;
  const finish = () => {
    if (current && hasData) files.add(current);
    current = null;
    hasData = false;
  };
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      finish();
      const source = line.slice(3);
      const absolute = source.startsWith("/") ? source : resolve(REPO_ROOT, source);
      current = relative(REPO_ROOT, absolute).replaceAll("\\", "/");
      continue;
    }
    if (line === "end_of_record") {
      finish();
      continue;
    }
    if (!current || !line.startsWith("DA:")) continue;
    const [lineNumber, hits] = line.slice(3).split(",", 2);
    if (/^[1-9]\d*$/.test(lineNumber ?? "") && /^\d+$/.test(hits ?? "")) hasData = true;
  }
  finish();
  return files;
}

const WEB_VITEST_INCLUDE_MANIFEST = resolve(REPO_ROOT, "scripts/web-vitest-coverage-includes.sh");

/** Parse the one shell manifest shared by the selected and full Node/V8 runs. */
export function webVitestIncludePatterns(manifest: string): string[] {
  return [...manifest.matchAll(/"--coverage\.include=([^"\n]+)"/g)].map((match) => match[1] ?? "");
}

/** Expand the configured Vitest source patterns against web/, preserving literal route brackets. */
export function configuredWebVitestSources(patterns: readonly string[]): string[] {
  const sources = new Set<string>();
  for (const pattern of patterns) {
    const literal = pattern.replace(/\[\[\]/g, "[");
    const escaped = literal.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
    for (const source of new Glob(escaped).scanSync({ cwd: resolve(REPO_ROOT, "web") })) {
      sources.add(`web/${source.replaceAll("\\", "/")}`);
    }
  }
  return [...sources].sort();
}

export async function missingWebLibCoverage(
  files: readonly string[],
  lcovFiles: ReadonlySet<string>,
  readSource: (file: string) => Promise<string>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    if (isExcluded(file) || lcovFiles.has(file)) continue;
    if (file.endsWith(".ts") && isDeclarationOnlyTypeScript(await readSource(file))) continue;
    missing.push(file);
  }
  return missing;
}

if (import.meta.main) {
  if (process.argv.length < 3) throw new Error("usage: check-web-vitest-coverage.ts <lcov.info> [...]");
  const lcov = await Promise.all(process.argv.slice(2).map((path) => Bun.file(path).text()));
  const manifest = await Bun.file(WEB_VITEST_INCLUDE_MANIFEST).text();
  const sources = configuredWebVitestSources(webVitestIncludePatterns(manifest))
    .filter((file) => !file.includes("/__tests__/") && !file.endsWith(".test.ts"));
  const missing = await missingWebLibCoverage(
    sources,
    lcovSourceFiles(lcov.join("\n")),
    async (file) => Bun.file(resolve(REPO_ROOT, file)).text(),
  );
  if (missing.length > 0) {
    console.error(`web Vitest coverage has no DA record for ${missing.length} executable shared source file(s):`);
    for (const file of missing) console.error(`  ${file}`);
    process.exit(1);
  }
  console.log(`web Vitest coverage records every configured executable source (${sources.length} candidates)`);
}
