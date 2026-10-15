#!/usr/bin/env bun
// Postinstall — scaffolds the claude-design data directory under the
// project's `.ezcorp/extension-data/claude-design/`. Idempotent: runs
// on every install/reload, but only creates dirs that don't yet exist.

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "@ezcorp/sdk/runtime";

const projectRoot = resolveProjectRoot();
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
