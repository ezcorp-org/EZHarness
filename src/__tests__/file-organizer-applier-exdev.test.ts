// EXDEV (cross-device) fallback coverage for the host applier.
//
// `applyQuarantine` and `restoreFromQuarantine` both try `rename()` first
// and fall back to copy+fsync+verify+unlink when the kernel returns
// `EXDEV` (source and trash/restore live on different devices — common
// when the watched folder is a bind-mount and `.ezcorp/data` is the
// container layer). A single-device temp dir can never produce a real
// EXDEV, so we stub `node:fs/promises.rename` to throw `{code:"EXDEV"}`
// and assert the copy path completes (bytes durable, original gone).
//
// The stub is a DELEGATING wrapper: every other fs op (copyFile, stat,
// unlink, mkdir, lstat, open, realpath, rm) forwards to the real module,
// so only the rename branch is altered. The applier is dynamically
// imported AFTER the mock is registered so its top-level
// `import { rename } from "node:fs/promises"` binds to the stub. This
// file runs in its own bun process (per-file isolation) so the
// mock.module override can't contaminate any other suite.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionEngine } from "../extensions/permission-engine";

// Capture the REAL implementations by value BEFORE registering the mock.
// bun's mock.module mutates the existing module namespace in place, so a
// captured *namespace* (`realFsp.rename`) would resolve back to the stub
// → infinite recursion. Snapshotting the function refs avoids that.
const realFsp = await import("node:fs/promises");
const realRename = realFsp.rename;
const realCopyFile = realFsp.copyFile;
const realFspSnapshot = { ...realFsp };

// When true, the next rename() throws EXDEV (forcing the copy fallback).
let forceExdev = false;
// When true, copyFile() throws ENOSPC (disk full) — the move/quarantine
// must abort with the original intact (never unlink before a verified copy).
let forceEnospc = false;

mock.module("node:fs/promises", () => ({
  ...realFspSnapshot,
  default: realFspSnapshot,
  rename: async (...args: Parameters<typeof realRename>) => {
    // Only force EXDEV on the REAL file rename (quarantine/restore). The
    // atomic-write helpers (journal/manifest) rename a `*.tmp-xxxx` temp
    // into place via this same fn — forcing EXDEV there would wrongly fail
    // the bookkeeping write rather than the move under test.
    const src = String(args[0]);
    const isAtomicTemp = /\.tmp-[a-z0-9]+$/.test(src);
    if (forceExdev && !isAtomicTemp) {
      const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    }
    return realRename(...args);
  },
  copyFile: async (...args: Parameters<typeof realCopyFile>) => {
    if (forceEnospc) {
      const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    }
    return realCopyFile(...args);
  },
}));

// Import the applier AFTER the mock is registered so it binds the stub.
const { applyProposal, restoreFromQuarantine } = await import("../extensions/file-organizer-applier");
type ApplierContext = import("../extensions/file-organizer-applier").ApplierContext;
type ApplierProposal = import("../extensions/file-organizer-applier").ApplierProposal;

function fakeEngine(): PermissionEngine {
  return {
    authorize: async () => ({ decision: "allow", auditId: "a" }),
  } as unknown as PermissionEngine;
}

let root: string;
let dataDir: string;
let watched: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fo-exdev-"));
  dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
  watched = join(root, "watched");
  await mkdir(join(dataDir, ".trash"), { recursive: true });
  await mkdir(watched, { recursive: true });
  forceExdev = false;
  forceEnospc = false;
});
afterEach(async () => {
  forceExdev = false;
  forceEnospc = false;
  await rm(root, { recursive: true, force: true });
});

function ctx(): ApplierContext {
  return {
    extensionId: "ext-fo",
    userId: null,
    conversationId: null,
    engine: fakeEngine(),
    trashRoot: join(dataDir, ".trash"),
    journalPath: join(dataDir, "journal.json"),
    watchedRoot: watched,
    dataDirRoot: dataDir,
  };
}

describe("applyQuarantine — EXDEV fallback (copy+fsync+verify+unlink)", () => {
  test("a cross-device rename falls back to copy; original is gone, trash holds the bytes", async () => {
    const src = join(watched, "junk.tmp");
    await writeFile(src, "abandoned-junk");
    forceExdev = true; // the rename into .trash will throw EXDEV
    const p: ApplierProposal = {
      id: "p",
      kind: "delete-quarantine",
      src,
      dst: null,
      quarantineId: "q1",
      snapshot: { size: 14, mtimeMs: 0, isSymlink: false, nlink: 1 },
    };
    const outcome = await applyProposal(p, ctx());
    expect(outcome.status).toBe("applied");
    expect(outcome.quarantineId).toBe("q1");
    // Original removed by the unlink that follows the verified copy.
    expect(await Bun.file(src).exists()).toBe(false);
    // Trash copy is byte-identical.
    expect(await readFile(outcome.resolvedPath!, "utf8")).toBe("abandoned-junk");
  });
});

describe("applyMove — ENOSPC abort (disk full) leaves the original intact", () => {
  test("a copy that fails with ENOSPC aborts the move; src kept, dst absent", async () => {
    const src = join(watched, "a.txt");
    await writeFile(src, "precious");
    forceEnospc = true; // the copyVerified() copyFile throws ENOSPC
    const p: ApplierProposal = {
      id: "p",
      kind: "move",
      src,
      dst: join(watched, "sub", "a.txt"),
      snapshot: { size: 8, mtimeMs: 0, isSymlink: false, nlink: 1 },
    };
    const outcome = await applyProposal(p, ctx());
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("ENOSPC");
    // Never unlink before a verified copy — the original survives a full disk.
    expect(await readFile(src, "utf8")).toBe("precious");
    expect(await Bun.file(join(watched, "sub", "a.txt")).exists()).toBe(false);
  });
});

describe("restoreFromQuarantine — EXDEV fallback", () => {
  test("a cross-device restore falls back to copy; trash emptied, file back", async () => {
    const trashDir = join(dataDir, ".trash", "q1");
    await mkdir(trashDir, { recursive: true });
    const trashed = join(trashDir, "a.txt");
    await writeFile(trashed, "restored-bytes");
    const restorePath = join(watched, "a.txt");
    forceExdev = true;
    const outcome = await restoreFromQuarantine({ trashPath: trashed, restorePath }, ctx());
    expect(outcome.status).toBe("applied");
    expect(await readFile(restorePath, "utf8")).toBe("restored-bytes");
    // Copy fallback unlinks the trashed source.
    expect(await Bun.file(trashed).exists()).toBe(false);
  });
});
