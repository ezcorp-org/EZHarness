/**
 * Grant-independent hard-deny for the EZCorp database + secret dir.
 *
 * Proves, against the REAL `checkFilesystemPermission` (read gate) and
 * the REAL `checkPrefixForWrite`-equivalent path (exercised here via the
 * exported `isReservedSensitivePath` + a covering `$CWD` grant through
 * `checkFilesystemPermission`), that:
 *
 *   • the reserved `.ezcorp/data` dir (and a file under it) is DENIED
 *     even when the grant covers the whole project root (`$CWD`);
 *   • a path under `.ezcorp/extension-data/<name>/` stays ALLOWED with
 *     the same covering grant (no over-block);
 *   • the sibling `.ezcorp/data-export` is NOT falsely denied
 *     (segment boundary);
 *   • an escape attempt that resolves INTO the reserved dir is DENIED.
 *
 * The reserved set is computed from `getProjectRoot()` + `getDbMaskDirs()`,
 * so the test stands up a throwaway project root (with the
 * `docs/extensions/examples` marker `getProjectRoot()` requires), points
 * `EZCORP_PROJECT_ROOT` at it, and resets the cached resolution.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkFilesystemPermission,
  isReservedSensitivePath,
} from "../extensions/permissions";
import { checkPrefixForWrite } from "../extensions/fs-handler";
import { __resetProjectRootCacheForTests } from "../extensions/bundled";
import type { ExtensionPermissions } from "../extensions/types";

let projectRoot: string;
let installDir: string;
const savedEnv: Record<string, string | undefined> = {};

// A covering grant: `$CWD` expands to the project root, so it nominally
// covers EVERYTHING under it — including the reserved dir. The hard-deny
// must win regardless.
const coveringGrant: ExtensionPermissions = {
  filesystem: ["$CWD"],
  grantedAt: {},
};

beforeAll(() => {
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "ezcorp-reserved-")));
  // `getProjectRoot()` only accepts an env root that looks like the repo
  // (has docs/extensions/examples). Create the marker.
  mkdirSync(join(projectRoot, "docs", "extensions", "examples"), { recursive: true });

  // Reserved: the DB + secret dir and its backups sibling.
  mkdirSync(join(projectRoot, ".ezcorp", "data"), { recursive: true });
  mkdirSync(join(projectRoot, ".ezcorp", "backups"), { recursive: true });
  writeFileSync(join(projectRoot, ".ezcorp", "data", "ezcorp-db"), "secret");

  // NOT reserved: the extension store (legit read+write) ...
  mkdirSync(join(projectRoot, ".ezcorp", "extension-data", "file-organizer"), {
    recursive: true,
  });
  writeFileSync(
    join(projectRoot, ".ezcorp", "extension-data", "file-organizer", "state.json"),
    "{}",
  );
  // ... and the segment-boundary sibling.
  mkdirSync(join(projectRoot, ".ezcorp", "data-export"), { recursive: true });
  writeFileSync(join(projectRoot, ".ezcorp", "data-export", "dump.csv"), "a,b");

  // An install dir OUTSIDE the project root so the implicit install-dir
  // allow never accidentally covers (or shadows) the reserved compare.
  installDir = realpathSync(mkdtempSync(join(tmpdir(), "ezcorp-install-")));

  savedEnv.EZCORP_PROJECT_ROOT = process.env.EZCORP_PROJECT_ROOT;
  savedEnv.EZCORP_DB_PATH = process.env.EZCORP_DB_PATH;
  savedEnv.DATABASE_URL = process.env.DATABASE_URL;
  process.env.EZCORP_PROJECT_ROOT = projectRoot;
  // Keep getDbMaskDirs() out of the picture for THIS root (no on-disk DB
  // at the default path under tmp); the `.ezcorp/data` reservation is
  // what we're proving. Clear DATABASE_URL so getDbMaskDirs isn't []
  // for the wrong reason — but point EZCORP_DB_PATH at our reserved dir
  // so the DB-path branch is also exercised.
  delete process.env.DATABASE_URL;
  process.env.EZCORP_DB_PATH = join(projectRoot, ".ezcorp", "data");
  __resetProjectRootCacheForTests();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetProjectRootCacheForTests();
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
});

describe("isReservedSensitivePath", () => {
  test("the reserved DB/.ezcorp/data dir itself is reserved", async () => {
    expect(await isReservedSensitivePath(join(projectRoot, ".ezcorp", "data"))).toBe(true);
  });

  test("a file nested under the reserved dir is reserved", async () => {
    expect(
      await isReservedSensitivePath(join(projectRoot, ".ezcorp", "data", "ezcorp-db")),
    ).toBe(true);
  });

  test("the segment-boundary sibling .ezcorp/data-export is NOT reserved", async () => {
    expect(
      await isReservedSensitivePath(join(projectRoot, ".ezcorp", "data-export")),
    ).toBe(false);
    expect(
      await isReservedSensitivePath(join(projectRoot, ".ezcorp", "data-export", "dump.csv")),
    ).toBe(false);
  });

  test("the extension store is NOT reserved", async () => {
    expect(
      await isReservedSensitivePath(
        join(projectRoot, ".ezcorp", "extension-data", "file-organizer"),
      ),
    ).toBe(false);
  });
});

describe("checkFilesystemPermission — reserved hard-deny (read gate)", () => {
  test("reading the reserved dir is DENIED despite a covering $CWD grant", async () => {
    const res = await checkFilesystemPermission(
      join(projectRoot, ".ezcorp", "data"),
      coveringGrant,
      installDir,
      "read",
    );
    expect(res.allowed).toBe(false);
  });

  test("reading a file under the reserved dir is DENIED despite $CWD grant", async () => {
    const res = await checkFilesystemPermission(
      join(projectRoot, ".ezcorp", "data", "ezcorp-db"),
      coveringGrant,
      installDir,
      "read",
    );
    expect(res.allowed).toBe(false);
  });

  test("an explicit grant of the reserved dir is STILL denied", async () => {
    const explicitGrant: ExtensionPermissions = {
      filesystem: [join(projectRoot, ".ezcorp", "data")],
      grantedAt: {},
    };
    const res = await checkFilesystemPermission(
      join(projectRoot, ".ezcorp", "data", "ezcorp-db"),
      explicitGrant,
      installDir,
      "read",
    );
    expect(res.allowed).toBe(false);
  });

  test("an escape that resolves INTO the reserved dir is DENIED", async () => {
    // .ezcorp/extension-data/file-organizer/../../data → .ezcorp/data
    const escape = join(
      projectRoot,
      ".ezcorp",
      "extension-data",
      "file-organizer",
      "..",
      "..",
      "data",
    );
    const res = await checkFilesystemPermission(escape, coveringGrant, installDir, "read");
    expect(res.allowed).toBe(false);
  });
});

describe("checkFilesystemPermission — no over-block (read gate)", () => {
  test("a file under .ezcorp/extension-data is ALLOWED with $CWD grant", async () => {
    const res = await checkFilesystemPermission(
      join(projectRoot, ".ezcorp", "extension-data", "file-organizer", "state.json"),
      coveringGrant,
      installDir,
      "read",
    );
    expect(res.allowed).toBe(true);
  });

  test("the segment-boundary sibling .ezcorp/data-export is ALLOWED with $CWD grant", async () => {
    const res = await checkFilesystemPermission(
      join(projectRoot, ".ezcorp", "data-export", "dump.csv"),
      coveringGrant,
      installDir,
      "read",
    );
    expect(res.allowed).toBe(true);
  });
});

describe("checkPrefixForWrite — reserved hard-deny (write gate)", () => {
  // checkPrefixForWrite receives an already-resolved targetPath (the
  // fs-handler realpaths / resolves the lowest existing ancestor before
  // calling it), so we pass resolved paths here to mirror production.
  test("writing the reserved dir is DENIED despite a covering $CWD grant", async () => {
    const allowed = await checkPrefixForWrite(
      join(projectRoot, ".ezcorp", "data"),
      ["$CWD"],
      installDir,
    );
    expect(allowed).toBe(false);
  });

  test("creating a NEW file under the reserved dir is DENIED ($CWD grant)", async () => {
    // Bootstrap case: target doesn't exist; resolved ancestor is the
    // reserved `.ezcorp/data` dir + tail — still inside the reserved dir.
    const allowed = await checkPrefixForWrite(
      join(projectRoot, ".ezcorp", "data", "stolen.json"),
      ["$CWD"],
      installDir,
    );
    expect(allowed).toBe(false);
  });

  test("an explicit reserved-dir grant is STILL denied on write", async () => {
    const allowed = await checkPrefixForWrite(
      join(projectRoot, ".ezcorp", "data", "ezcorp-db"),
      [join(projectRoot, ".ezcorp", "data")],
      installDir,
    );
    expect(allowed).toBe(false);
  });

  test("writing under .ezcorp/extension-data is ALLOWED ($CWD grant) — no over-block", async () => {
    const allowed = await checkPrefixForWrite(
      join(projectRoot, ".ezcorp", "extension-data", "file-organizer", "new-state.json"),
      ["$CWD"],
      installDir,
    );
    expect(allowed).toBe(true);
  });

  test("writing the segment-boundary sibling .ezcorp/data-export is ALLOWED", async () => {
    const allowed = await checkPrefixForWrite(
      join(projectRoot, ".ezcorp", "data-export", "new.csv"),
      ["$CWD"],
      installDir,
    );
    expect(allowed).toBe(true);
  });
});
