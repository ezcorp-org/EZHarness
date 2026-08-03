// file-refactor — walk + convention + dispatch coverage.
//
// This file previously had NO tests, so `docs/extensions/examples/*/index.ts`
// (threshold 90) never gated it: the catch-all key only measures files that
// appear in lcov, and nothing imported this one. A threshold that looks like
// it gates a file and doesn't.
//
// The bug that motivated the tests: `collectFiles` had no exclusion list AND
// no try/catch, so a host-denied `fs.list` propagated out of `handleRenameFiles`
// and turned `rename-files` into `Failed: …`. The host denies its OWN reserved
// dirs — the PGlite datadir + secret store — to every extension, including one
// holding a legitimate whole-project `$CWD` grant. In the shipped Docker image
// that datadir is `<projectRoot>/data/ezcorp` (Dockerfile:
// `EZCORP_DB_PATH=/app/data/ezcorp`, project root `/app`), i.e. INSIDE the
// grant and therefore inside the walk. A fixture built on the dev default
// (`$HOME/ez-corp/.data`) would prove nothing: that path is outside the
// project root, so the walk never reaches it.
//
// Stub contract mirrors the production host (same shape todo-tracker's
// index.test.ts uses):
//   - `ezcorp/fs.list` → `{ entries: FsListEntry[] }`
//   - `ezcorp/fs.stat` → `{ size, mtimeMs, isFile, isDirectory, resolvedPath }`
// Anything unregistered THROWS, so "the walk descended somewhere it shouldn't"
// is a loud failure rather than a silent pass.

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getChannel } from "@ezcorp/sdk/runtime";
import { _internals, SKIP_DIRS, SKIP_ROOT_DIRS } from "./index";
import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

const cwd = _internals.cwd;

type Entry = { name: string; isFile: boolean; isDirectory: boolean };
const dir = (name: string): Entry => ({ name, isFile: false, isDirectory: true });
const file = (name: string): Entry => ({ name, isFile: true, isDirectory: false });

// Synthetic project root, shaped like the Docker image:
//   <cwd>/MyFile.ts            → renameable
//   <cwd>/other_file.ts        → renameable
//   <cwd>/src/NestedThing.ts   → renameable (nested walk)
//   <cwd>/src/data/Keep.ts     → renameable — NESTED `data` is real source
//   <cwd>/data                 → RESERVED parent (Docker datadir) — never listed
//   <cwd>/.ezcorp              → RESERVED platform state    — never listed
//   <cwd>/node_modules|.git    → skipped at any depth
const FILES: Record<string, Entry[]> = {
  [cwd]: [
    file("MyFile.ts"),
    file("other_file.ts"),
    dir("src"),
    dir("lib"),
    dir("data"),
    dir(".ezcorp"),
    dir("node_modules"),
    dir(".git"),
  ],
  [`${cwd}/src`]: [file("NestedThing.ts"), dir("data")],
  [`${cwd}/src/data`]: [file("Keep.ts")],
  [`${cwd}/lib`]: [file("Alpha.ts")],
};

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;

beforeAll(() => {
  // SDK's `ensureFsAllowed` gate reads this env; the stub IS the host, so
  // the gate is satisfied without granting real filesystem permission.
  process.env.EZCORP_FS_ALLOWED = "1";
});

afterAll(() => {
  if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
  else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
});

/**
 * Install the synthetic host. `denyList` names paths whose `fs.list`
 * rejects the way the real host rejects a reserved carve-out; `statFile`
 * names paths `fs.stat` should report as a FILE rather than a directory.
 */
function installStub(
  denyList: ReadonlySet<string> = new Set(),
  statFiles: ReadonlySet<string> = new Set(),
): void {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.list") {
      if (denyList.has(path)) {
        throw new Error(
          "Filesystem access denied: reserved by the EZCorp platform (database / secret store)",
        );
      }
      const entries = FILES[path];
      if (entries === undefined) {
        throw new Error(`file-refactor test stub: unexpected fs.list path ${path}`);
      }
      return { entries };
    }
    if (method === "ezcorp/fs.stat") {
      const isFile = statFiles.has(path);
      return {
        size: 0,
        mtimeMs: 0,
        isFile,
        isDirectory: !isFile,
        resolvedPath: path,
      };
    }
    throw new Error(`file-refactor test stub: unexpected RPC method ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
}

beforeEach(() => {
  // preload's afterEach drops the channel singleton, so re-install per test.
  installStub();
});

/** Drive the real dispatcher and return the rendered text. */
async function renameFiles(args: Record<string, unknown>): Promise<string> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "rename-files", arguments: args },
  };
  const res = (await _internals.handleRequest(req)) as JsonRpcResponse;
  if (res.error) throw new Error(`rename-files errored: ${res.error.message}`);
  const content = (res.result as { content: { type: string; text: string }[] }).content;
  return content[0]!.text;
}

/** Drive the dispatcher expecting a JSON-RPC error. */
async function renameFilesError(args: Record<string, unknown>): Promise<{ code: number; message: string }> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "rename-files", arguments: args },
  };
  const res = (await _internals.handleRequest(req)) as JsonRpcResponse;
  if (!res.error) throw new Error("expected an error response");
  return res.error;
}

describe("convertName", () => {
  const { convertName } = _internals;

  test("camelCase", () => {
    expect(convertName("my-file.ts", "camelCase")).toBe("myFile.ts");
    expect(convertName("my_file.ts", "camelCase")).toBe("myFile.ts");
  });

  test("snake_case", () => {
    expect(convertName("MyFile.ts", "snake_case")).toBe("my_file.ts");
    expect(convertName("my-file.ts", "snake_case")).toBe("my_file.ts");
  });

  test("kebab-case", () => {
    expect(convertName("MyFile.ts", "kebab-case")).toBe("my-file.ts");
    expect(convertName("my_file.ts", "kebab-case")).toBe("my-file.ts");
  });

  test("PascalCase", () => {
    expect(convertName("my-file.ts", "PascalCase")).toBe("MyFile.ts");
    expect(convertName("my_file.ts", "PascalCase")).toBe("MyFile.ts");
  });

  test("an unknown convention leaves the basename alone (extension preserved)", () => {
    expect(convertName("My-File.ts", "SCREAMING_SNAKE")).toBe("My-File.ts");
  });
});

describe("matchesGlob / isUnderCwd", () => {
  test("matchesGlob matches on substring OR exact basename", () => {
    expect(_internals.matchesGlob("/a/b/skip-me.ts", "skip-me")).toBe(true);
    expect(_internals.matchesGlob("/a/b/skip-me.ts", "skip-me.ts")).toBe(true);
    expect(_internals.matchesGlob("/a/b/keep.ts", "skip-me")).toBe(false);
  });

  test("isUnderCwd accepts cwd and its descendants, rejects siblings", () => {
    expect(_internals.isUnderCwd(".")).toBe(true);
    expect(_internals.isUnderCwd("src/x.ts")).toBe(true);
    expect(_internals.isUnderCwd("../elsewhere/x.ts")).toBe(false);
  });
});

describe("rename-files — argument validation", () => {
  test("missing sourcePath is -32602", async () => {
    const err = await renameFilesError({ convention: "camelCase" });
    expect(err.code).toBe(-32602);
    expect(err.message).toContain("sourcePath");
  });

  test("missing convention is -32602", async () => {
    const err = await renameFilesError({ sourcePath: "." });
    expect(err.code).toBe(-32602);
    expect(err.message).toContain("convention");
  });

  test("a path outside the project is -32000", async () => {
    const err = await renameFilesError({ sourcePath: "../elsewhere", convention: "camelCase" });
    expect(err.code).toBe(-32000);
    expect(err.message).toContain("outside project directory");
  });
});

describe("rename-files — the walk", () => {
  test("walks nested dirs and previews renames without touching disk", async () => {
    const text = await renameFiles({ sourcePath: ".", convention: "kebab-case" });
    expect(text).toContain("MyFile.ts -> my-file.ts");
    expect(text).toContain("src/NestedThing.ts -> src/nested-thing.ts");
    expect(text).toContain("(Preview only — no files were renamed)");
  });

  test("a NESTED data/ is still walked (skip is root-anchored, not blanket)", async () => {
    // Over-block guard: skipping every directory named `data` at any depth
    // would silently drop real source from a rename preview.
    const text = await renameFiles({ sourcePath: ".", convention: "kebab-case" });
    expect(text).toContain("src/data/Keep.ts -> src/data/keep.ts");
  });

  test("excludePatterns still filter", async () => {
    const text = await renameFiles({
      sourcePath: ".",
      convention: "kebab-case",
      excludePatterns: ["NestedThing"],
    });
    expect(text).toContain("MyFile.ts");
    expect(text).not.toContain("NestedThing");
  });

  test("a single FILE sourcePath skips the walk entirely", async () => {
    installStub(new Set(), new Set([`${cwd}/MyFile.ts`]));
    const text = await renameFiles({ sourcePath: "MyFile.ts", convention: "kebab-case" });
    expect(text).toContain("MyFile.ts -> my-file.ts");
    expect(text).toContain("out of 1");
  });

  test("already-conforming files report the no-op message", async () => {
    installStub(new Set(), new Set([`${cwd}/other_file.ts`]));
    const text = await renameFiles({ sourcePath: "other_file.ts", convention: "snake_case" });
    expect(text).toContain("already match snake_case convention");
  });
});

describe("rename-files — host-reserved carve-out (the Docker layout)", () => {
  test("top-level `data` (Docker datadir parent) is never listed", async () => {
    // `${cwd}/data` has NO stub entry, so descending it would throw
    // "unexpected fs.list path". A clean run proves the walk skipped it.
    const text = await renameFiles({ sourcePath: ".", convention: "kebab-case" });
    expect(text).toContain("MyFile.ts -> my-file.ts");
  });

  test("`.ezcorp` is never listed", async () => {
    const text = await renameFiles({ sourcePath: ".", convention: "kebab-case" });
    expect(text).toContain("MyFile.ts -> my-file.ts");
  });

  test("a host DENIAL mid-walk is reported as skipped, NOT a tool failure", async () => {
    // The regression this file exists for. Pre-fix the rejection escaped
    // `collectFiles` and `handleRenameFiles` answered `Failed: …`.
    installStub(new Set([`${cwd}/src`]));
    const text = await renameFiles({ sourcePath: ".", convention: "kebab-case" });
    // The rest of the tree still previewed …
    expect(text).toContain("MyFile.ts -> my-file.ts");
    // … and the unreadable subtree is surfaced, not swallowed.
    expect(text).toContain("Skipped 1 unreadable directory: src");
    expect(text).not.toContain("NestedThing");
  });

  test("a denial at the ROOT reports '.' and still answers successfully", async () => {
    installStub(new Set([cwd]));
    const text = await renameFiles({ sourcePath: ".", convention: "kebab-case" });
    expect(text).toContain("already match kebab-case convention");
    expect(text).toContain("Skipped 1 unreadable directory: .");
  });

  test("two denied SIBLING subtrees pluralize the note and list both", async () => {
    installStub(new Set([`${cwd}/src`, `${cwd}/lib`]));
    const text = await renameFiles({ sourcePath: ".", convention: "kebab-case" });
    expect(text).toContain("Skipped 2 unreadable directories: src, lib");
    // Root-level files still previewed.
    expect(text).toContain("MyFile.ts -> my-file.ts");
  });

  test("a non-denial fsStat failure is still a clean -32000, not a crash", async () => {
    const ch = getChannel();
    spyOn(ch, "request").mockImplementation((async (): Promise<unknown> => {
      throw new Error("upstream exploded");
    }) as ReturnType<typeof getChannel>["request"]);
    const err = await renameFilesError({ sourcePath: ".", convention: "kebab-case" });
    expect(err.code).toBe(-32000);
    expect(err.message).toContain("Failed:");
  });
});

describe("skip lists", () => {
  test("SKIP_DIRS covers the platform state dir at any depth", () => {
    expect(SKIP_DIRS.has(".ezcorp")).toBe(true);
    expect(SKIP_DIRS.has("node_modules")).toBe(true);
    expect(SKIP_DIRS.has(".git")).toBe(true);
    // NOT blanket-skipping `data` — that is root-anchored instead.
    expect(SKIP_DIRS.has("data")).toBe(false);
  });

  test("SKIP_ROOT_DIRS is exactly the Docker datadir parent", () => {
    expect([...SKIP_ROOT_DIRS]).toEqual(["data"]);
  });
});

describe("dispatch", () => {
  test("an unknown tool name is -32601", async () => {
    const res = (await _internals.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    })) as JsonRpcResponse;
    expect(res.error!.code).toBe(-32601);
    expect(res.error!.message).toContain("Unknown tool");
  });

  test("an unknown method is -32601", async () => {
    const res = (await _internals.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "nope/nope",
    })) as JsonRpcResponse;
    expect(res.error!.code).toBe(-32601);
    expect(res.error!.message).toContain("Unknown method");
  });

  test("tools/call with no params object still answers -32601 (no crash)", async () => {
    const res = (await _internals.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
    })) as JsonRpcResponse;
    expect(res.error!.code).toBe(-32601);
  });
});
