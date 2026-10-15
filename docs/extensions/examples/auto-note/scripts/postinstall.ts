#!/usr/bin/env bun
// auto-note postinstall — create vault directory scaffold

import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveProjectRoot } from "@ezcorp/sdk/runtime";

const root = resolveProjectRoot();
// Convention: all extension data goes under .ezcorp/extension-data/<ext-name>/
const vaultRoot = join(root, ".ezcorp", "extension-data", "auto-note", "vault");
const categories = ["ideas", "tasks", "decisions", "references", "journal", "meetings"];

for (const cat of categories) {
  mkdirSync(join(vaultRoot, cat), { recursive: true });
}

// Create initial _index.md if it doesn't exist
const indexPath = join(vaultRoot, "_index.md");
if (!existsSync(indexPath)) {
  writeFileSync(
    indexPath,
    [
      "# Vault Index",
      "",
      "> Auto-generated — 0 notes total",
      "",
      "## Categories",
      "",
      ...categories.map((c) => `- **${c}/** — 0 notes`),
      "",
      "## Recent Notes",
      "",
      "_No notes yet. Use `auto-note.capture` to add your first note._",
      "",
    ].join("\n"),
  );
}

console.log(`Auto Note vault initialized at ${vaultRoot}`);
