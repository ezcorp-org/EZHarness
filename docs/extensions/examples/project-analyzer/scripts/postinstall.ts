#!/usr/bin/env bun
// postinstall - Runs after extension installation

import { resolve } from "node:path";

const configPath = resolve(import.meta.dir, "..", ".project-analyzer-config");

const file = Bun.file(configPath);
if (!(await file.exists())) {
  await Bun.write(configPath, JSON.stringify({ initialized: true, createdAt: new Date().toISOString() }, null, 2));
  console.log("project-analyzer: created default config");
}

console.log("project-analyzer installed successfully");
