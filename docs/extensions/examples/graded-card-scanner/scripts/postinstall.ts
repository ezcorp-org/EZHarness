#!/usr/bin/env bun
// graded-card-scanner postinstall — ship the scanner SPA into the
// extension-data dir so the platform's static-file route serves it at
// /api/extensions/graded-card-scanner/data/app/index.html.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walk up from `from` to the nearest directory containing `.git`. */
export function findProjectRoot(from: string = process.cwd()): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

/**
 * Copy the SPA from the extension package into the served data dir.
 * Idempotent — re-running refreshes the deployed copy.
 */
export function installApp(srcAppDir: string, projectRoot: string): string {
  const dest = join(projectRoot, ".ezcorp", "extension-data", "graded-card-scanner", "app");
  mkdirSync(dest, { recursive: true });
  cpSync(srcAppDir, dest, { recursive: true });
  return dest;
}

/** Entry point — deploy this package's app/ into the current project. */
export function main(root: string = findProjectRoot(), log: (msg: string) => void = console.log): string {
  const dest = installApp(join(import.meta.dir, "..", "app"), root);
  log(`Graded Card Scanner app installed at ${dest}`);
  return dest;
}

if (import.meta.main) main();
