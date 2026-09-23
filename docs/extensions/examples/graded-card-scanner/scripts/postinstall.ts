#!/usr/bin/env bun
// graded-card-scanner postinstall — ship the scanner SPA into the
// extension-data dir so the platform's static-file route serves it at
// /api/extensions/graded-card-scanner/data/app/index.html.

import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "@ezcorp/sdk/runtime";

/** The nearest git repository root above `from`, or `from` itself. */
export const findProjectRoot = resolveProjectRoot;

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
