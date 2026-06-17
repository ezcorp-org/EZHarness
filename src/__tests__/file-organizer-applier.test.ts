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

  test("an unclassified proposal is skipped (not directly applyable)", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const src = join(watched, "mystery.dat");
    await writeFile(src, "x");
    const ctx = await ctxFor(watched);
    const p: ApplierProposal = { id: "u", kind: "unclassified", src, dst: null, snapshot: { size: 1, mtimeMs: 0, isSymlink: false, nlink: 1 } };
    const outcome = await applyProposal(p, ctx);
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("not directly applyable");
    expect(await _applierInternals.pathExists(src)).toBe(true); // untouched
  });

  test("an engine 'prompt' decision fails closed (blocked, never applied)", async () => {
    const watched = join(root, "w");
    await mkdir(watched, { recursive: true });
    const src = join(watched, "a.txt");
    await writeFile(src, "x");
    // Bundled grants auto-allow, so a prompt is unexpected — the applier
    // must treat it as a deny (fail-closed) rather than apply on an
    // unresolved prompt.
    const promptEngine = {
      authorize: async () => ({ decision: "prompt", reason: "needs user" }),
    } as unknown as PermissionEngine;
    const ctx = await ctxFor(watched, promptEngine);
    const outcome = await applyProposal(moveProposal(src, join(watched, "sub", "a.txt"), 1), ctx);
    expect(outcome.status).toBe("blocked");
    expect(await _applierInternals.pathExists(src)).toBe(true);
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

  test("a corrupt (non-JSON) journal is read as empty (fail-safe)", async () => {
    const journalPath = join(root, "corrupt-journal.json");
    await writeFile(journalPath, "{ not valid json");
    // readJournal swallows the parse error and returns [] — replay is then
    // a clean no-op rather than a crash on a torn write.
    expect(await _applierInternals.readJournal(journalPath)).toEqual([]);
    const res = await replayJournal(journalPath);
    expect(res).toEqual({ finished: 0, rolledBack: 0 });
  });

  test("a non-array journal payload is read as empty", async () => {
    const journalPath = join(root, "obj-journal.json");
    await writeFile(journalPath, JSON.stringify({ not: "an array" }));
    expect(await _applierInternals.readJournal(journalPath)).toEqual([]);
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
  test("isWithin / touchesDataDir (loose substring fallback)", () => {
    expect(_applierInternals.isWithin("/a", "/a/b")).toBe(true);
    expect(_applierInternals.isWithin("/a", "/ab")).toBe(false);
    expect(_applierInternals.touchesDataDir("/x/.ezcorp/data/y")).toBe(true);
    expect(_applierInternals.touchesDataDir("/x/Downloads/y")).toBe(false);
  });

  test("touchesDataDir anchors to the real dataDirRoot's project .ezcorp/data", () => {
    // dataDirRoot = <proj>/.ezcorp/extension-data/file-organizer ⇒ the
    // protected dir is <proj>/.ezcorp/data (its .ezcorp sibling).
    const proj = "/home/dev/proj";
    const dataDirRoot = join(proj, ".ezcorp", "extension-data", "file-organizer");
    expect(_applierInternals.touchesDataDir(join(proj, ".ezcorp", "data", "ez.db"), dataDirRoot)).toBe(true);
    expect(_applierInternals.touchesDataDir(join(proj, ".ezcorp", "data"), dataDirRoot)).toBe(true);
    // A sibling that merely shares the `.ezcorp` parent but is NOT data/ is fine.
    expect(_applierInternals.touchesDataDir(join(proj, ".ezcorp", "extension-data", "x"), dataDirRoot)).toBe(false);
    // The anchored check is in addition to the loose fallback — a path under
    // a DIFFERENT project's .ezcorp/data still trips the substring guard.
    expect(_applierInternals.touchesDataDir("/other/.ezcorp/data/y", dataDirRoot)).toBe(true);
  });

  test("resolveNonOverwrite walks suffixes on disk", async () => {
    const d = join(root, "no");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "f.txt"), "1");
    expect(await _applierInternals.resolveNonOverwrite(join(d, "f.txt"))).toBe(join(d, "f (2).txt"));
    expect(await _applierInternals.resolveNonOverwrite(join(d, "free.txt"))).toBe(join(d, "free.txt"));
    void stat; // silence unused import in some toolchains
  });

  test("resolveNonOverwrite handles dotfiles (no ext) and multi-dot names", async () => {
    const d = join(root, "dot");
    await mkdir(d, { recursive: true });
    // A dotfile collision: `.bashrc` has NO extension — the suffix must
    // land on the stem, not split as ext=".bashrc" → " (2).bashrc".
    await writeFile(join(d, ".bashrc"), "1");
    expect(await _applierInternals.resolveNonOverwrite(join(d, ".bashrc"))).toBe(join(d, ".bashrc (2)"));
    // A multi-dot name keeps only the final ext segment.
    await writeFile(join(d, "archive.tar.gz"), "1");
    expect(await _applierInternals.resolveNonOverwrite(join(d, "archive.tar.gz"))).toBe(join(d, "archive.tar (2).gz"));
    // A dotfile WITH an ext (`.config.json`) splits at the last dot.
    await writeFile(join(d, ".config.json"), "1");
    expect(await _applierInternals.resolveNonOverwrite(join(d, ".config.json"))).toBe(join(d, ".config (2).json"));
  });
});
