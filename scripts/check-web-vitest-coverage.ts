#!/usr/bin/env bun
/** Fail when a shipped, executable shared-web source has no V8 DA record. */
import { Glob } from "bun";
import { relative, resolve } from "node:path";
import { isDeclarationOnlyTypeScript, isExcluded, REPO_ROOT } from "./coverage-config.ts";

export function lcovSourceFiles(lcov: string): Set<string> {
  const files = new Set<string>();
  for (const line of lcov.split("\n")) {
    if (!line.startsWith("SF:")) continue;
    const source = line.slice(3);
    const absolute = source.startsWith("/") ? source : resolve(REPO_ROOT, source);
    files.add(relative(REPO_ROOT, absolute).replaceAll("\\", "/"));
  }
  return files;
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
  const sources = [
    ...new Glob("web/src/lib/**/*.ts").scanSync({ cwd: REPO_ROOT }),
    ...new Glob("web/src/lib/**/*.svelte").scanSync({ cwd: REPO_ROOT }),
  ].filter((file) => !file.includes("/__tests__/") && !file.endsWith(".test.ts"));
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
  console.log(`web Vitest coverage records every executable shared source (${sources.length} candidates)`);
}
