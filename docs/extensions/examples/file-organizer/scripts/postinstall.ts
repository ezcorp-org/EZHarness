#!/usr/bin/env bun
// file-organizer postinstall — scaffold the data dir + watch root.
//
// Runs HOST-SIDE (raw node:fs is fine here — the sandbox-preload is not
// installed in the install path). Idempotent: re-running never clobbers
// existing user state (config.json, quarantine, the override example).

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

const root = findProjectRoot();
const dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
const trashDir = join(dataDir, ".trash");
// A default, ready-to-mount host watch root. The README explains the
// docker-compose.override.yml convention for exposing it inside the
// container.
const watchedDir = join(root, "watched");

mkdirSync(dataDir, { recursive: true });
mkdirSync(trashDir, { recursive: true });
mkdirSync(watchedDir, { recursive: true });

// Default config: ask-everything, zero folders, no destructive rules —
// strictly opt-in. Nothing moves until the user configures a folder.
const configPath = join(dataDir, "config.json");
if (!existsSync(configPath)) {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        folders: [],
        globalIgnore: [".ezcorp/data", ".git", "node_modules"],
        schemaVersion: 1,
      },
      null,
      2,
    ),
  );
}

// Commented docker-compose.override.yml example — exposing a host parent
// folder to the container is a one-time mount step (see README). We never
// overwrite a user's existing override.
const overridePath = join(root, "docker-compose.override.yml.example");
if (!existsSync(overridePath)) {
  writeFileSync(
    overridePath,
    [
      "# Copy to docker-compose.override.yml (gitignored, auto-merged) to expose",
      "# a host folder to the EZCorp container so file-organizer can watch it.",
      "#",
      "#   EZCORP_WATCH_DIR=~/  docker compose up -d --force-recreate",
      "#",
      "# Then watch /watched/Desktop, /watched/Downloads, … from the Hub —",
      "# adding/removing subfolders is pure UI, no restart. :rw is REQUIRED",
      "# (organizing moves + deletes). In prod the container runs as uid 1000;",
      "# the mounted folder must be writable by uid 1000 or you'll get EACCES.",
      "#",
      "# services:",
      "#   app:",
      "#     volumes:",
      "#       - ${EZCORP_WATCH_DIR:-~/}:/watched:rw",
      "",
    ].join("\n"),
  );
}

console.log(`file-organizer scaffolded: ${dataDir} (+ ${watchedDir})`);
