// The host applier's protected-dir guard for the platform dirs that do
// NOT look like `.ezcorp/data`.
//
// The applier's two path-shaped layers (the `dataDirRoot`-anchored check
// and the `.ezcorp/data` SEGMENT fallback) only recognize a project-root
// layout. The shipped container does not use one: `Dockerfile:253` sets
// `EZCORP_DB_PATH=/app/data/ezcorp`, and the pre-boot snapshot dir is
// `<projectRoot>/.ezcorp/backups` — neither contains a `.ezcorp/data`
// segment, so both layers miss the real database and the real snapshots.
// `isReservedSensitivePath()` (`src/extensions/permissions.ts`) is the
// platform's canonical answer and knows about both; this file pins that
// the applier consults it.
//
// It needs its OWN bun process — and `scripts/test.sh` gives one per
// file — because it pins `EZCORP_PROJECT_ROOT`, which `getProjectRoot()`
// caches for the lifetime of the process, and because it imports
// `src/db/connection.ts` (which captures `EZCORP_DB_PATH` at module
// load) to read the datadir the run is actually configured with.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDbMaskDirs } from "../db/connection";
import {
  applyProposal,
  _applierInternals,
  type ApplierContext,
  type ApplierProposal,
} from "../extensions/file-organizer-applier";
import type { PermissionEngine } from "../extensions/permission-engine";

// Pin the project root BEFORE anything can call (and cache) it. The env
// override is validated — the dir must exist and carry the bundled
// example tree — so mint both synchronously at module load.
const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "fo-reserved-")));
mkdirSync(join(projectRoot, "docs", "extensions", "examples"), { recursive: true });
process.env.EZCORP_PROJECT_ROOT = projectRoot;

const dataDirRoot = join(projectRoot, ".ezcorp", "extension-data", "file-organizer");
const watched = join(projectRoot, "Downloads");

function fakeEngine(): PermissionEngine {
  return { authorize: async () => ({ decision: "allow", auditId: "a" }) } as unknown as PermissionEngine;
}

function ctx(watchedRoot: string): ApplierContext {
  return {
    extensionId: "ext-fo",
    userId: null,
    conversationId: null,
    engine: fakeEngine(),
    trashRoot: join(dataDirRoot, ".trash"),
    journalPath: join(dataDirRoot, "journal.json"),
    watchedRoot,
    dataDirRoot,
  };
}

beforeAll(async () => {
  await mkdir(join(dataDirRoot, ".trash"), { recursive: true });
  await mkdir(watched, { recursive: true });
  await mkdir(join(projectRoot, ".ezcorp", "backups"), { recursive: true });
});
afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("touchesProtectedDir covers the reserved dirs that are not `.ezcorp/data`", () => {
  test("the configured EZCORP_DB_PATH datadir is protected", async () => {
    // The pool's preload pins EZCORP_DB_PATH to a temp datadir — the same
    // shape the container uses (`/app/data/ezcorp`), with no
    // `.ezcorp/data` segment anywhere in it. (An external-Postgres run
    // has no on-disk DB and would publish nothing here.)
    const maskDirs = getDbMaskDirs();
    expect(maskDirs.length).toBe(2); // [datadir, backups]
    for (const dir of maskDirs) {
      expect(dir).not.toContain("/.ezcorp/data");
      expect(await _applierInternals.touchesProtectedDir(dir, dataDirRoot)).toBe(true);
      expect(await _applierInternals.touchesProtectedDir(join(dir, "base", "16384"), dataDirRoot)).toBe(true);
    }
    // A SIBLING of the datadir stays writable — the deny is the datadir
    // itself, never its parent (`/app/data` also holds `extensions/`).
    expect(await _applierInternals.touchesProtectedDir(`${maskDirs[0]}-sibling/x`, dataDirRoot)).toBe(false);
  });

  test("the project's `.ezcorp/backups` snapshot dir is protected", async () => {
    // Only the reserved-path layer can answer this one: `backups` is a
    // sibling of `data`, so neither the anchored check nor the
    // `.ezcorp/data` segment fallback sees it.
    const snapshot = join(projectRoot, ".ezcorp", "backups", "pre-boot.tar");
    expect(snapshot).not.toContain(join(".ezcorp", "data"));
    expect(await _applierInternals.touchesProtectedDir(snapshot, dataDirRoot)).toBe(true);
  });

  test("a proposal whose SRC is a pre-boot snapshot is BLOCKED end-to-end", async () => {
    const snapshot = join(projectRoot, ".ezcorp", "backups", "pre-boot.tar");
    await writeFile(snapshot, "db-snapshot-bytes");
    const p: ApplierProposal = {
      id: "p",
      kind: "delete-quarantine",
      src: snapshot,
      dst: null,
      snapshot: { size: 17, mtimeMs: 0, isSymlink: false, nlink: 1 },
    };
    // Watched root = the project root, so ONLY the protected-dir deny
    // stands between this proposal and the platform's own snapshots.
    const outcome = await applyProposal(p, ctx(projectRoot));
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toContain("protected");
    expect(await readFile(snapshot, "utf8")).toBe("db-snapshot-bytes");
  });

  test("a proposal whose DST is a pre-boot snapshot dir is BLOCKED end-to-end", async () => {
    const src = join(watched, "a.txt");
    await writeFile(src, "x");
    const p: ApplierProposal = {
      id: "p",
      kind: "move",
      src,
      dst: join(projectRoot, ".ezcorp", "backups", "planted.tar"),
      snapshot: { size: 1, mtimeMs: 0, isSymlink: false, nlink: 1 },
    };
    const outcome = await applyProposal(p, ctx(projectRoot));
    expect(outcome.status).toBe("blocked");
    expect(await readFile(src, "utf8")).toBe("x");
    expect(await _applierInternals.pathExists(join(projectRoot, ".ezcorp", "backups", "planted.tar"))).toBe(false);
  });

  test("an ordinary watched file is untouched by the deny (guard is not a wall)", async () => {
    const src = join(watched, "ordinary.txt");
    await writeFile(src, "hello");
    const outcome = await applyProposal(
      { id: "m", kind: "move", src, dst: join(watched, "Docs", "ordinary.txt"), snapshot: { size: 5, mtimeMs: 0, isSymlink: false, nlink: 1 } },
      ctx(watched),
    );
    expect(outcome.status).toBe("applied");
    expect(await readFile(join(watched, "Docs", "ordinary.txt"), "utf8")).toBe("hello");
  });
});
