import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveFileMentions,
  formatFileMentionSystemNotes,
} from "../runtime/mention-wiring";

let projectRoot: string;

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "file-mention-wiring-"));
  // Layout:
  //   projectRoot/
  //     foo.ts
  //     README.md
  //     src/
  //       app.ts
  await writeFile(join(projectRoot, "foo.ts"), "// foo\n");
  await writeFile(join(projectRoot, "README.md"), "# readme\n");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "app.ts"), "// app\n");
});

afterAll(async () => {
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
});

describe("resolveFileMentions", () => {
  test("happy path: resolves a root-level file", async () => {
    const result = await resolveFileMentions(
      "read @[file:foo.ts] please",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("file");
    expect(result[0]!.relPath).toBe("foo.ts");
    expect(result[0]!.absPath).toBe(resolve(projectRoot, "foo.ts"));
    expect(result[0]!.exists).toBe(true);
  });

  test("resolves a subdirectory file", async () => {
    const result = await resolveFileMentions(
      "look at @[file:src/app.ts]",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.relPath).toBe("src/app.ts");
    expect(result[0]!.absPath).toBe(resolve(projectRoot, "src/app.ts"));
    expect(result[0]!.exists).toBe(true);
  });

  test("returns empty when no file mentions", async () => {
    const result = await resolveFileMentions("hello there", projectRoot);
    expect(result).toEqual([]);
  });

  test("returns empty when only !-sigil mentions are present", async () => {
    const result = await resolveFileMentions(
      "![agent:Bot] ![ext:lint] ![team:Dev]",
      projectRoot,
    );
    expect(result).toEqual([]);
  });

  test("missing file returns entry with exists=false (does not throw)", async () => {
    const result = await resolveFileMentions(
      "see @[file:ghost.ts]",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.relPath).toBe("ghost.ts");
    expect(result[0]!.exists).toBe(false);
  });

  test("path traversal `../..` is rejected (skipped)", async () => {
    const result = await resolveFileMentions(
      "try @[file:../../etc/passwd]",
      projectRoot,
    );
    expect(result).toEqual([]);
  });

  test("absolute paths are rejected", async () => {
    const result = await resolveFileMentions(
      "try @[file:/etc/passwd]",
      projectRoot,
    );
    expect(result).toEqual([]);
  });

  test("undefined projectPath returns empty array without throwing", async () => {
    const result = await resolveFileMentions("@[file:foo.ts]", undefined);
    expect(result).toEqual([]);
  });

  test("empty projectPath returns empty array", async () => {
    const result = await resolveFileMentions("@[file:foo.ts]", "");
    expect(result).toEqual([]);
  });

  test("deduplicates repeated same-file mentions", async () => {
    const result = await resolveFileMentions(
      "first @[file:foo.ts] again @[file:foo.ts]",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.relPath).toBe("foo.ts");
  });

  test("resolves multiple distinct file mentions", async () => {
    const result = await resolveFileMentions(
      "@[file:foo.ts] and @[file:README.md]",
      projectRoot,
    );
    expect(result).toHaveLength(2);
    const paths = result.map((r) => r.relPath).sort();
    expect(paths).toEqual(["README.md", "foo.ts"]);
  });

  test("mixed content (! + @): returns only file mentions", async () => {
    const result = await resolveFileMentions(
      "![agent:Bot] reads @[file:foo.ts] with ![ext:lint]",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.relPath).toBe("foo.ts");
  });

  test("ignores legacy @[agent:…] tokens", async () => {
    const result = await resolveFileMentions(
      "@[agent:Old] hello @[file:foo.ts]",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.relPath).toBe("foo.ts");
  });

  test("empty file name inside token is skipped", async () => {
    // parseMentions itself rejects @[file:] because the inner group requires
    // at least one char, so this produces no tokens.
    const result = await resolveFileMentions("@[file:]", projectRoot);
    expect(result).toEqual([]);
  });
});

describe("resolveFileMentions — @[dir:…] support", () => {
  test("resolves an existing directory with kind='dir'", async () => {
    const result = await resolveFileMentions(
      "store output in @[dir:src] please",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("dir");
    expect(result[0]!.relPath).toBe("src");
    expect(result[0]!.absPath).toBe(resolve(projectRoot, "src"));
    expect(result[0]!.exists).toBe(true);
  });

  test("missing directory returns exists=false (not thrown)", async () => {
    const result = await resolveFileMentions(
      "@[dir:does-not-exist]",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("dir");
    expect(result[0]!.exists).toBe(false);
  });

  test("@[dir:src] against a file-not-dir path reports exists=false", async () => {
    // `foo.ts` exists as a file, not a directory — the dir assertion should fail.
    const result = await resolveFileMentions(
      "@[dir:foo.ts]",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("dir");
    expect(result[0]!.exists).toBe(false);
  });

  test("@[file:src] against a directory reports exists=false (kind mismatch)", async () => {
    // Mirror of above: file token pointing at a directory — should not pass.
    const result = await resolveFileMentions(
      "@[file:src]",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("file");
    expect(result[0]!.exists).toBe(false);
  });

  test("trailing slash on a dir path is stripped before validation", async () => {
    const result = await resolveFileMentions(
      "@[dir:src/]",
      projectRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.relPath).toBe("src");
    expect(result[0]!.exists).toBe(true);
  });

  test("mixed file + dir mentions resolve independently", async () => {
    const result = await resolveFileMentions(
      "read @[file:foo.ts] and list @[dir:src]",
      projectRoot,
    );
    expect(result).toHaveLength(2);
    const byKind = Object.fromEntries(result.map((r) => [r.kind, r]));
    expect(byKind.file!.relPath).toBe("foo.ts");
    expect(byKind.dir!.relPath).toBe("src");
    expect(byKind.file!.exists).toBe(true);
    expect(byKind.dir!.exists).toBe(true);
  });

  test("absolute dir path is rejected", async () => {
    const result = await resolveFileMentions(
      "@[dir:/etc]",
      projectRoot,
    );
    expect(result).toEqual([]);
  });

  test("path traversal on dir is rejected", async () => {
    const result = await resolveFileMentions(
      "@[dir:../../etc]",
      projectRoot,
    );
    expect(result).toEqual([]);
  });

  test("dedupes same (kind, relPath) pair but allows file+dir at same relPath", async () => {
    // `src` is both a real dir and could theoretically be referenced as a file;
    // the dedupe should not collapse them across kinds.
    const result = await resolveFileMentions(
      "@[dir:src] and again @[dir:src] and @[file:src]",
      projectRoot,
    );
    expect(result).toHaveLength(2);
    const kinds = result.map((r) => r.kind).sort();
    expect(kinds).toEqual(["dir", "file"]);
  });
});

describe("formatFileMentionSystemNotes", () => {
  test("returns empty string for no mentions", () => {
    expect(formatFileMentionSystemNotes([])).toBe("");
  });

  test("formats one file mention on a single line", () => {
    expect(
      formatFileMentionSystemNotes([
        { kind: "file", relPath: "foo.ts", absPath: "/proj/foo.ts", exists: true },
      ]),
    ).toBe("[User referenced file: foo.ts at /proj/foo.ts]");
  });

  test("joins multiple file mentions with newlines", () => {
    const text = formatFileMentionSystemNotes([
      { kind: "file", relPath: "a.ts", absPath: "/proj/a.ts", exists: true },
      { kind: "file", relPath: "b/c.ts", absPath: "/proj/b/c.ts", exists: true },
    ]);
    expect(text).toBe(
      "[User referenced file: a.ts at /proj/a.ts]\n[User referenced file: b/c.ts at /proj/b/c.ts]",
    );
  });

  test("marks missing files with a suffix", () => {
    expect(
      formatFileMentionSystemNotes([
        { kind: "file", relPath: "ghost.ts", absPath: "/proj/ghost.ts", exists: false },
      ]),
    ).toBe("[User referenced file: ghost.ts at /proj/ghost.ts (not found)]");
  });

  test("formats dir mention with list/store-target wording", () => {
    const text = formatFileMentionSystemNotes([
      { kind: "dir", relPath: "src/output", absPath: "/proj/src/output", exists: true },
    ]);
    expect(text).toContain("User referenced directory: src/output at /proj/src/output");
    expect(text).toContain("list files");
    expect(text).toContain("target for new files");
  });

  test("marks missing directories with a suffix too", () => {
    const text = formatFileMentionSystemNotes([
      { kind: "dir", relPath: "ghost", absPath: "/proj/ghost", exists: false },
    ]);
    expect(text).toContain("ghost");
    expect(text).toContain("(not found)");
  });

  test("mixed file + dir entries are both rendered", () => {
    const text = formatFileMentionSystemNotes([
      { kind: "file", relPath: "a.ts", absPath: "/proj/a.ts", exists: true },
      { kind: "dir", relPath: "src", absPath: "/proj/src", exists: true },
    ]);
    expect(text).toContain("referenced file: a.ts");
    expect(text).toContain("referenced directory: src");
  });
});
