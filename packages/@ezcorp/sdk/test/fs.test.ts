// fs.test.ts — 100% line + branch coverage for runtime/fs.ts
//
// Bun-only. Uses fs.mkdtempSync for a temp-dir root then Bun.file / Bun.write
// for everything else (project rule: no node:fs/promises).

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  atomicRead,
  atomicWrite,
  findProjectRoot,
  getExtensionDataDir,
  loadJSON,
  saveJSON,
} from "../src/runtime/fs";

// ── Temp-dir scaffolding ───────────────────────────────────────────

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ezcorp-sdk-fs-"));
});

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ── findProjectRoot ────────────────────────────────────────────────

describe("findProjectRoot", () => {
  test("returns dir containing .git when called from that dir", () => {
    mkdirSync(join(workDir, ".git"));
    expect(findProjectRoot(workDir)).toBe(workDir);
  });

  test("walks up from a nested dir until it finds .git", () => {
    mkdirSync(join(workDir, ".git"));
    const nested = join(workDir, "sub", "deep");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(workDir);
  });

  test("throws when no .git ancestor exists up to filesystem root", () => {
    // Sanity: if the system /.git exists this assumption is invalid.
    // Walk the workDir's chain to confirm no ancestor has .git.
    let cur = workDir;
    while (true) {
      if (existsSync(join(cur, ".git"))) {
        throw new Error(
          `precondition violated: ${join(cur, ".git")} exists — this test assumes no .git in tmpdir ancestry`,
        );
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }

    expect(() => findProjectRoot(workDir)).toThrow(/no \.git ancestor found/);
  });

  test("uses process.cwd() when called with no argument", () => {
    // The repo this test runs in has a .git, so the default-arg branch
    // resolves successfully.
    const root = findProjectRoot();
    expect(typeof root).toBe("string");
    expect(existsSync(join(root, ".git"))).toBe(true);
  });
});

// ── getExtensionDataDir ────────────────────────────────────────────

describe("getExtensionDataDir", () => {
  test("composes <root>/.ezcorp/extension-data/<name> using opts.projectRoot", () => {
    const dir = getExtensionDataDir("my-ext", { projectRoot: workDir });
    expect(dir).toBe(join(workDir, ".ezcorp", "extension-data", "my-ext"));
  });

  test("creates the dir if missing", () => {
    const dir = getExtensionDataDir("auto-note", { projectRoot: workDir });
    expect(existsSync(dir)).toBe(true);
  });

  test("is idempotent on a second call", () => {
    const a = getExtensionDataDir("again", { projectRoot: workDir });
    const b = getExtensionDataDir("again", { projectRoot: workDir });
    expect(a).toBe(b);
    expect(existsSync(a)).toBe(true);
  });

  test("falls back to findProjectRoot() when opts is undefined", () => {
    // Default branch — no opts. We can't easily isolate findProjectRoot here,
    // but the call must succeed because the test runs inside the repo.
    const dir = getExtensionDataDir("__sdk_unit_test_fallback__");
    try {
      expect(dir.endsWith(join(".ezcorp", "extension-data", "__sdk_unit_test_fallback__"))).toBe(
        true,
      );
      expect(existsSync(dir)).toBe(true);
    } finally {
      // Tidy up the dir we leaked into the real repo.
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── atomicWrite ────────────────────────────────────────────────────

describe("atomicWrite", () => {
  test("writes content to the target path", async () => {
    const target = join(workDir, "out.txt");
    await atomicWrite(target, "hello");
    expect(await Bun.file(target).text()).toBe("hello");
  });

  test("overwrites an existing file", async () => {
    const target = join(workDir, "out.txt");
    await Bun.write(target, "old");
    await atomicWrite(target, "new");
    expect(await Bun.file(target).text()).toBe("new");
  });

  test("creates the parent directory if missing", async () => {
    const target = join(workDir, "deeper", "nested", "out.txt");
    await atomicWrite(target, "x");
    expect(existsSync(dirname(target))).toBe(true);
    expect(await Bun.file(target).text()).toBe("x");
  });

  test("tmp sibling file is gone after success", async () => {
    const target = join(workDir, "out.txt");
    await atomicWrite(target, "done");
    const stale = readdirSync(workDir).filter((f) => f.startsWith("out.txt.tmp-"));
    expect(stale).toEqual([]);
  });

  test("does not leave a partial when Bun.write throws", async () => {
    const target = join(workDir, "out.txt");
    const spy = spyOn(Bun, "write").mockImplementation(() => {
      throw new Error("synthetic write failure");
    });
    try {
      await expect(atomicWrite(target, "doomed")).rejects.toThrow("synthetic write failure");
    } finally {
      spy.mockRestore();
    }
    // Target was never written; no `*.tmp-*` sibling should be left.
    expect(existsSync(target)).toBe(false);
    const stale = readdirSync(workDir).filter((f) => f.startsWith("out.txt.tmp-"));
    expect(stale).toEqual([]);
  });

  test("accepts a Uint8Array body", async () => {
    const target = join(workDir, "bin.dat");
    const body = new TextEncoder().encode("binary-ish");
    await atomicWrite(target, body);
    expect(await Bun.file(target).text()).toBe("binary-ish");
  });
});

// ── atomicRead ─────────────────────────────────────────────────────

describe("atomicRead", () => {
  test("returns the content for an existing file", async () => {
    const target = join(workDir, "in.txt");
    await Bun.write(target, "payload");
    expect(await atomicRead(target)).toBe("payload");
  });

  test("returns null when the file does not exist", async () => {
    expect(await atomicRead(join(workDir, "missing.txt"))).toBeNull();
  });

  test("rethrows on unexpected fs errors (e.g. EACCES from .text())", async () => {
    // Bun.file(...).text() can fail with EACCES, EISDIR, EIO etc. atomicRead
    // must surface those — only the missing-file case is allowed to be
    // swallowed (returns null). We synthesize a failing file handle via spy
    // to keep the test platform-independent.
    const target = join(workDir, "blocked.txt");
    const fakeFile = {
      exists: async () => true,
      text: async () => {
        throw new Error("EACCES: synthesized");
      },
    } as unknown as ReturnType<typeof Bun.file>;
    const spy = spyOn(Bun, "file").mockImplementation(() => fakeFile);
    try {
      await expect(atomicRead(target)).rejects.toThrow("EACCES: synthesized");
    } finally {
      spy.mockRestore();
    }
  });
});

// ── loadJSON ───────────────────────────────────────────────────────

describe("loadJSON", () => {
  test("returns the parsed object for a valid JSON file", async () => {
    const target = join(workDir, "data.json");
    await Bun.write(target, JSON.stringify({ a: 1, b: [2, 3] }));
    const result = await loadJSON<{ a: number; b: number[] }>(target, { a: 0, b: [] });
    expect(result).toEqual({ a: 1, b: [2, 3] });
  });

  test("returns the fallback when the file is missing", async () => {
    const fallback = { hello: "world" };
    const result = await loadJSON(join(workDir, "missing.json"), fallback);
    expect(result).toBe(fallback);
  });

  test("returns the fallback on malformed JSON and warns to stderr", async () => {
    const target = join(workDir, "bad.json");
    await Bun.write(target, "{ this is not valid json");
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await loadJSON(target, { fallback: true });
      expect(result).toEqual({ fallback: true });
      expect(stderrSpy).toHaveBeenCalled();
      const written = String(stderrSpy.mock.calls[0]?.[0] ?? "");
      expect(written).toContain("[@ezcorp/sdk] loadJSON: parse error");
      expect(written).toContain(target);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("logs String(err) when JSON.parse throws a non-Error", async () => {
    const target = join(workDir, "weird.json");
    await Bun.write(target, "{}");
    const parseSpy = spyOn(JSON, "parse").mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw "raw string failure";
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await loadJSON(target, "FB");
      expect(result).toBe("FB");
      expect(stderrSpy).toHaveBeenCalled();
      const written = String(stderrSpy.mock.calls[0]?.[0] ?? "");
      expect(written).toContain("raw string failure");
    } finally {
      parseSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

// ── saveJSON ───────────────────────────────────────────────────────

describe("saveJSON", () => {
  test("round-trips with loadJSON", async () => {
    const target = join(workDir, "rt.json");
    const data = { x: 1, nested: { y: [true, false, "z"] } };
    await saveJSON(target, data);
    const back = await loadJSON<typeof data | null>(target, null);
    expect(back).toEqual(data);
  });

  test("writes 2-space indent", async () => {
    const target = join(workDir, "indented.json");
    await saveJSON(target, { a: { b: 1 } });
    const text = await Bun.file(target).text();
    expect(text).toBe('{\n  "a": {\n    "b": 1\n  }\n}');
  });
});
