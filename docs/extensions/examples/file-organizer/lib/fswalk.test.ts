import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_HASH_BYTES,
  UNSTABLE_SUFFIXES,
  buildDuplicateIndex,
  hashDecision,
  isUnstableName,
  joinRoot,
  tickStability,
  updateHashCache,
  walk,
  type DirReader,
  type HashCache,
  type WalkDirent,
} from "./fswalk";

// ── In-memory tree reader ───────────────────────────────────────────

function dirent(path: string, opts: Partial<WalkDirent> = {}): WalkDirent {
  const name = path.split("/").pop() ?? path;
  return {
    name,
    path,
    isDirectory: false,
    isFile: true,
    isSymlink: false,
    inodeKey: path,
    size: 1,
    mtimeMs: 0,
    nlink: 1,
    ...opts,
  };
}

function memReader(tree: Record<string, WalkDirent[]>): DirReader {
  return { read: async (dir) => tree[dir] ?? [] };
}

const opts = (over: Partial<Parameters<typeof walk>[2]> = {}) => ({
  maxDepth: 10,
  budget: 1000,
  isIgnored: () => false,
  ...over,
});

describe("walk", () => {
  test("collects files, descends dirs, sets complete", async () => {
    const reader = memReader({
      "/r": [dirent("/r/a.txt"), dirent("/r/sub", { isDirectory: true, isFile: false })],
      "/r/sub": [dirent("/r/sub/b.txt")],
    });
    const res = await walk("/r", reader, opts());
    expect(res.files.map((f) => f.path).sort()).toEqual(["/r/a.txt", "/r/sub/b.txt"]);
    expect(res.complete).toBe(true);
    expect(res.cursor).toBeNull();
  });

  test("depth bound stops descent", async () => {
    const reader = memReader({
      "/r": [dirent("/r/sub", { isDirectory: true, isFile: false })],
      "/r/sub": [dirent("/r/sub/deep", { isDirectory: true, isFile: false })],
      "/r/sub/deep": [dirent("/r/sub/deep/x.txt")],
    });
    const res = await walk("/r", reader, opts({ maxDepth: 1 }));
    expect(res.files.map((f) => f.path)).not.toContain("/r/sub/deep/x.txt");
  });

  test("ignore predicate prunes a subtree", async () => {
    const reader = memReader({
      "/r": [dirent("/r/keep.txt"), dirent("/r/node_modules", { isDirectory: true, isFile: false })],
      "/r/node_modules": [dirent("/r/node_modules/x.txt")],
    });
    const res = await walk("/r", reader, opts({ isIgnored: (p) => p.includes("node_modules") }));
    expect(res.files.map((f) => f.path)).toEqual(["/r/keep.txt"]);
  });

  test("symlinked directories are not descended; symlinked files are reported", async () => {
    const reader = memReader({
      "/r": [dirent("/r/link", { isDirectory: true, isFile: false, isSymlink: true }), dirent("/r/flink", { isSymlink: true })],
      "/r/link": [dirent("/r/link/should-not-see.txt")],
    });
    const res = await walk("/r", reader, opts());
    const paths = res.files.map((f) => f.path);
    expect(paths).toContain("/r/flink");
    expect(paths).not.toContain("/r/link/should-not-see.txt");
  });

  test("visited inode loop break (shared inodeKey)", async () => {
    const reader = memReader({
      "/r": [dirent("/r/a", { inodeKey: "I" }), dirent("/r/b", { inodeKey: "I" })],
    });
    const res = await walk("/r", reader, opts());
    expect(res.files).toHaveLength(1);
  });

  test("budget exhaustion returns a cursor (incomplete)", async () => {
    const reader = memReader({
      "/r": [dirent("/r/a.txt"), dirent("/r/b.txt"), dirent("/r/c.txt")],
    });
    const res = await walk("/r", reader, opts({ budget: 2 }));
    expect(res.complete).toBe(false);
    expect(res.cursor).toBe("/r/b.txt");
    expect(res.visited).toBe(2);
  });

  test("resumeAfter cursor skips already-seen entries", async () => {
    const reader = memReader({
      "/r": [dirent("/r/a.txt"), dirent("/r/b.txt"), dirent("/r/c.txt")],
    });
    const res = await walk("/r", reader, opts({ resumeAfter: "/r/b.txt" }));
    expect(res.files.map((f) => f.path)).toEqual(["/r/c.txt"]);
  });

  test("a read error skips the dir (never treated as deleted)", async () => {
    const reader: DirReader = {
      read: async (dir) => {
        if (dir === "/r/bad") throw new Error("ESTALE");
        if (dir === "/r") return [dirent("/r/ok.txt"), dirent("/r/bad", { isDirectory: true, isFile: false })];
        return [];
      },
    };
    const res = await walk("/r", reader, opts());
    expect(res.files.map((f) => f.path)).toEqual(["/r/ok.txt"]);
    expect(res.complete).toBe(true);
  });
});

describe("hashDecision", () => {
  const cache: HashCache = { "/r/a": { size: 10, mtimeMs: 5, sha256: "h" } };
  test("hit when size+mtime match", () => {
    expect(hashDecision({ path: "/r/a", size: 10, mtimeMs: 5 }, cache)).toBe("hit");
  });
  test("miss when no entry", () => {
    expect(hashDecision({ path: "/r/new", size: 1, mtimeMs: 1 }, cache)).toBe("miss");
  });
  test("miss when mtime changed", () => {
    expect(hashDecision({ path: "/r/a", size: 10, mtimeMs: 6 }, cache)).toBe("miss");
  });
  test("skip when too big", () => {
    expect(hashDecision({ path: "/r/a", size: DEFAULT_MAX_HASH_BYTES + 1, mtimeMs: 5 }, cache)).toBe("skip");
  });
});

describe("hashcache update + duplicate index", () => {
  test("updateHashCache is pure", () => {
    const base: HashCache = {};
    const next = updateHashCache(base, "/x", { size: 1, mtimeMs: 1, sha256: "h" });
    expect(base["/x"]).toBeUndefined();
    expect(next["/x"]!.sha256).toBe("h");
  });
  test("buildDuplicateIndex groups by sha256", () => {
    const cache: HashCache = {
      "/a": { size: 1, mtimeMs: 1, sha256: "dup" },
      "/b": { size: 1, mtimeMs: 2, sha256: "dup" },
      "/c": { size: 1, mtimeMs: 3, sha256: "uniq" },
    };
    const idx = buildDuplicateIndex(cache);
    expect(idx.get("dup")!.sort()).toEqual(["/a", "/b"]);
    expect(idx.get("uniq")).toEqual(["/c"]);
  });
});

describe("joinRoot", () => {
  test("joins segments", () => {
    expect(joinRoot("/r", "sub", "x.txt")).toBe("/r/sub/x.txt");
  });
});

describe("stability gate", () => {
  test("isUnstableName flags partial downloads + office locks", () => {
    expect(isUnstableName("a.crdownload")).toBe(true);
    expect(isUnstableName("a.part")).toBe(true);
    expect(isUnstableName("a.partial")).toBe(true);
    expect(isUnstableName("a.download")).toBe(true);
    expect(isUnstableName("~$doc.docx")).toBe(true);
    expect(isUnstableName("final.txt")).toBe(false);
    // A bare `.tmp` is NOT unstable — it's a legitimate junk target; the
    // stability gate defers it while it's still being written.
    expect(isUnstableName("trash.tmp")).toBe(false);
    expect(UNSTABLE_SUFFIXES.length).toBeGreaterThan(0);
  });

  test("tickStability requires N quiescent ticks; a change resets", () => {
    let prev = undefined as Parameters<typeof tickStability>[0];
    let r = tickStability(prev, { size: 10, mtimeMs: 1 }, 2);
    expect(r.stable).toBe(false); // tick 1: quietTicks 0
    prev = r.state;
    r = tickStability(prev, { size: 10, mtimeMs: 1 }, 2);
    expect(r.stable).toBe(false); // tick 2: quietTicks 1
    prev = r.state;
    r = tickStability(prev, { size: 10, mtimeMs: 1 }, 2);
    expect(r.stable).toBe(true); // tick 3: quietTicks 2 >= 2

    // A size change resets the counter.
    prev = r.state;
    r = tickStability(prev, { size: 20, mtimeMs: 1 }, 2);
    expect(r.stable).toBe(false);
    expect(r.state.quietTicks).toBe(0);
  });
});
