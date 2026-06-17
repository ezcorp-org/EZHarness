import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProposal,
  replayJournal,
  restoreFromQuarantine,
  hardDeleteTrash,
  _applierInternals,
  type ApplierContext,
  type ApplierProposal,
} from "../extensions/file-organizer-applier";
import type { PermissionEngine } from "../extensions/permission-engine";
import type { AuthorizeContext } from "../extensions/permission-engine";
import type { CapabilitySet } from "../extensions/capability-types";

// ── A permission engine fake that records authorize() calls ─────────

function fakeEngine(decision: "allow" | "deny" = "allow"): PermissionEngine & { calls: Array<{ value?: string }> } {
  const calls: Array<{ value?: string }> = [];
  return {
    calls,
    authorize: async (_ctx: AuthorizeContext, needed: CapabilitySet) => {
      calls.push({ value: needed[0]?.value });
      return decision === "allow"
        ? { decision: "allow", auditId: "audit-1" }
        : { decision: "deny", reason: "denied by test", auditId: "audit-deny" };
    },
  } as unknown as PermissionEngine & { calls: Array<{ value?: string }> };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fo-applier-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function ctxFor(watchedRoot: string, engine?: PermissionEngine): Promise<ApplierContext> {
  const dataDir = join(root, ".ezcorp", "extension-data", "file-organizer");
  await mkdir(join(dataDir, ".trash"), { recursive: true });
  return {
    extensionId: "ext-fo",
    userId: null,
    conversationId: null,
    engine: engine ?? fakeEngine("allow"),
    trashRoot: join(dataDir, ".trash"),
    journalPath: join(dataDir, "journal.json"),
    watchedRoot,
    dataDirRoot: dataDir,
  };
}

function moveProposal(src: string, dst: string, size: number): ApplierProposal {
  return { id: "p1", kind: "move", src, dst, snapshot: { size, mtimeMs: 0, isSymlink: false, nlink: 1 } };
}

describe("applyProposal — move", () => {
  test("copy+verify+unlink: dst written, src gone, audit row written", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const src = join(watched, "a.txt");
    await writeFile(src, "hello");
    const engine = fakeEngine("allow");
    const ctx = await ctxFor(watched, engine);
    const outcome = await applyProposal(moveProposal(src, join(watched, "sub", "a.txt"), 5), ctx);
    expect(outcome.status).toBe("applied");
    expect(await readFile(outcome.resolvedPath!, "utf8")).toBe("hello");
    expect(await _applierInternals.pathExists(src)).toBe(false);
    expect(engine.calls.length).toBe(1); // audit row on every apply
    expect(outcome.auditId).toBe("audit-1");
  });

  test("never overwrites — collision gets a (2) suffix", async () => {
    const watched = join(root, "w");
    await mkdir(join(watched, "sub"), { recursive: true });
    const src = join(watched, "a.txt");
    await writeFile(src, "new");
    await writeFile(join(watched, "sub", "a.txt"), "existing");
    const ctx = await ctxFor(watched);
    const outcome = await applyProposal(moveProposal(src, join(watched, "sub", "a.txt"), 3), ctx);
    expect(outcome.resolvedPath).toBe(join(watched, "sub", "a (2).txt"));
    expect(await readFile(join(watched, "sub", "a.txt"), "utf8")).toBe("existing");
  });

  test("destination escaping the watched root is blocked", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const src = join(watched, "a.txt");
    await writeFile(src, "x");
    const ctx = await ctxFor(watched);
    const outcome = await applyProposal(moveProposal(src, join(root, "escape.txt"), 1), ctx);
    expect(outcome.status).toBe("blocked");
    expect(await _applierInternals.pathExists(src)).toBe(true); // original intact
  });

  test("destination targeting .ezcorp/data is blocked", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const src = join(watched, "a.txt");
    await writeFile(src, "x");
    const ctx = await ctxFor(watched);
    // craft a dst inside the watched root but with .ezcorp/data segment
    const evil = join(watched, ".ezcorp", "data", "a.txt");
    const outcome = await applyProposal(moveProposal(src, evil, 1), ctx);
    expect(outcome.status).toBe("blocked");
  });

  test("engine deny ⇒ blocked, original intact, no copy", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const src = join(watched, "a.txt");
    await writeFile(src, "x");
    const ctx = await ctxFor(watched, fakeEngine("deny"));
    const outcome = await applyProposal(moveProposal(src, join(watched, "sub", "a.txt"), 1), ctx);
    expect(outcome.status).toBe("blocked");
    expect(await _applierInternals.pathExists(src)).toBe(true);
  });

  test("size-mismatch (torn copy) aborts: original intact, dst removed", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const src = join(watched, "a.txt");
    await writeFile(src, "hello"); // 5 bytes
    const ctx = await ctxFor(watched);
    // claim the wrong expected size → verify fails
    const outcome = await applyProposal(moveProposal(src, join(watched, "sub", "a.txt"), 999), ctx);
    expect(outcome.status).toBe("failed");
    expect(await _applierInternals.pathExists(src)).toBe(true);
    expect(await _applierInternals.pathExists(join(watched, "sub", "a.txt"))).toBe(false);
  });

  test("stale source ⇒ stale-source (no mutation)", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const ctx = await ctxFor(watched);
    const outcome = await applyProposal(moveProposal(join(watched, "gone.txt"), join(watched, "sub", "gone.txt"), 1), ctx);
    expect(outcome.status).toBe("stale-source");
  });

  test("symlink ⇒ skipped (never followed)", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const target = join(watched, "target.txt");
    await writeFile(target, "secret");
    const link = join(watched, "link.txt");
    await symlink(target, link);
    const ctx = await ctxFor(watched);
    const p: ApplierProposal = { id: "p", kind: "move", src: link, dst: join(watched, "sub", "x"), snapshot: { size: 0, mtimeMs: 0, isSymlink: true, nlink: 1 } };
    const outcome = await applyProposal(p, ctx);
    expect(outcome.status).toBe("skipped");
    expect(await _applierInternals.pathExists(target)).toBe(true);
  });
});

describe("applyProposal — quarantine", () => {
  test("moves to trash, audit row written, original gone", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const src = join(watched, "junk.tmp");
    await writeFile(src, "junk");
    const ctx = await ctxFor(watched);
    const p: ApplierProposal = { id: "p", kind: "delete-quarantine", src, dst: null, quarantineId: "q1", snapshot: { size: 4, mtimeMs: 0, isSymlink: false, nlink: 1 } };
    const outcome = await applyProposal(p, ctx);
    expect(outcome.status).toBe("applied");
    expect(outcome.quarantineId).toBe("q1");
    expect(await _applierInternals.pathExists(src)).toBe(false);
    expect(await readFile(outcome.resolvedPath!, "utf8")).toBe("junk");
  });

  test("engine deny ⇒ blocked (file stays)", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const src = join(watched, "junk.tmp");
    await writeFile(src, "j");
    const ctx = await ctxFor(watched, fakeEngine("deny"));
    const p: ApplierProposal = { id: "p", kind: "delete-quarantine", src, dst: null, snapshot: { size: 1, mtimeMs: 0, isSymlink: false, nlink: 1 } };
    const outcome = await applyProposal(p, ctx);
    expect(outcome.status).toBe("blocked");
    expect(await _applierInternals.pathExists(src)).toBe(true);
  });
});

describe("restoreFromQuarantine", () => {
  test("restores to original (non-overwrite suffix on collision)", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const ctx = await ctxFor(watched);
    const trashed = join(ctx.trashRoot, "q1", "a.txt");
    await mkdir(join(ctx.trashRoot, "q1"), { recursive: true });
    await writeFile(trashed, "restored");
    const original = join(watched, "a.txt");
    await writeFile(original, "occupied"); // forces a suffix
    const outcome = await restoreFromQuarantine({ trashPath: trashed, restorePath: original }, ctx);
    expect(outcome.status).toBe("applied");
    expect(outcome.resolvedPath).toBe(join(watched, "a (2).txt"));
    expect(await readFile(outcome.resolvedPath!, "utf8")).toBe("restored");
  });

  test("missing trashed file ⇒ stale-source", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const ctx = await ctxFor(watched);
    const outcome = await restoreFromQuarantine({ trashPath: join(ctx.trashRoot, "nope", "x"), restorePath: join(watched, "x") }, ctx);
    expect(outcome.status).toBe("stale-source");
  });

  test("restore into .ezcorp/data ⇒ blocked", async () => {
    const ctx = await ctxFor(join(root, "w"));
    const trashed = join(ctx.trashRoot, "q2", "x");
    await mkdir(join(ctx.trashRoot, "q2"), { recursive: true });
    await writeFile(trashed, "x");
    const outcome = await restoreFromQuarantine({ trashPath: trashed, restorePath: join(root, ".ezcorp", "data", "x") }, ctx);
    expect(outcome.status).toBe("blocked");
  });
});

describe("journal crash-replay", () => {
  test("copy-done entry finishes the unlink idempotently", async () => {
    const watched = join(root, "w");
    await mkdir(join(watched, "sub"), { recursive: true });
    const src = join(watched, "a.txt");
    const dst = join(watched, "sub", "a.txt");
    await writeFile(src, "data"); // original still present (crash after copy)
    await writeFile(dst, "data"); // destination already written
    const journalPath = join(root, "journal.json");
    await _applierInternals.writeJournal(journalPath, [
      { op: "move", src, dst, quarantineId: null, phase: "copy-done" } as never,
    ]);
    const res = await replayJournal(journalPath);
    expect(res.finished).toBe(1);
    expect(await _applierInternals.pathExists(src)).toBe(false); // unlink completed
    expect(await _applierInternals.pathExists(dst)).toBe(true);
    expect(await _applierInternals.readJournal(journalPath)).toHaveLength(0); // cleared
  });

  test("copy-pending entry rolls back the partial dst, keeps original", async () => {
    const watched = join(root, "w");
    await mkdir(join(watched, "sub"), { recursive: true });
    const src = join(watched, "a.txt");
    const dst = join(watched, "sub", "a.txt");
    await writeFile(src, "data");
    await writeFile(dst, "partial");
    const journalPath = join(root, "journal.json");
    await _applierInternals.writeJournal(journalPath, [
      { op: "move", src, dst, quarantineId: null, phase: "copy-pending" } as never,
    ]);
    const res = await replayJournal(journalPath);
    expect(res.rolledBack).toBe(1);
    expect(await _applierInternals.pathExists(src)).toBe(true); // original kept
    expect(await _applierInternals.pathExists(dst)).toBe(false); // partial removed
  });

  test("empty journal is a no-op", async () => {
    const res = await replayJournal(join(root, "missing-journal.json"));
    expect(res).toEqual({ finished: 0, rolledBack: 0 });
  });
});

describe("hardDeleteTrash", () => {
  test("removes a trash dir recursively", async () => {
    const dir = join(root, "trash-q");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "x"), "x");
    expect(await hardDeleteTrash(dir)).toBe(true);
    expect(await _applierInternals.pathExists(dir)).toBe(false);
  });
});

describe("guards (unit)", () => {
  test("isWithin / touchesDataDir", () => {
    expect(_applierInternals.isWithin("/a", "/a/b")).toBe(true);
    expect(_applierInternals.isWithin("/a", "/ab")).toBe(false);
    expect(_applierInternals.touchesDataDir("/x/.ezcorp/data/y")).toBe(true);
    expect(_applierInternals.touchesDataDir("/x/Downloads/y")).toBe(false);
  });
  test("resolveNonOverwrite walks suffixes on disk", async () => {
    const d = join(root, "no");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "f.txt"), "1");
    expect(await _applierInternals.resolveNonOverwrite(join(d, "f.txt"))).toBe(join(d, "f (2).txt"));
    expect(await _applierInternals.resolveNonOverwrite(join(d, "free.txt"))).toBe(join(d, "free.txt"));
    void stat; // silence unused import in some toolchains
  });
});
