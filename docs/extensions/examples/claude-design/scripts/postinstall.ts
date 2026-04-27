#!/usr/bin/env bun
// Postinstall — scaffolds the claude-design data directory under the
// project's `.ezcorp/extension-data/claude-design/`. Idempotent: runs
// on every install/reload, but only creates dirs that don't yet exist.

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

function findProjectRoot(from: string = process.cwd()): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

const projectRoot = findProjectRoot();
const dataDir = join(projectRoot, ".ezcorp", "extension-data", "claude-design");

for (const sub of ["projects", "handoffs"]) {
  mkdirSync(join(dataDir, sub), { recursive: true });
}

const configPath = join(dataDir, "config.json");
if (!existsSync(configPath)) {
  writeFileSync(
    configPath,
    JSON.stringify({ version: 1, defaultMode: "conformant" }, null, 2) + "\n",
  );
}

console.log(`[claude-design] data dir scaffolded at ${dataDir}`);
