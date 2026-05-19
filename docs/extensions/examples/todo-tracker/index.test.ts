// Phase post-perm-cleanup, task B5 — unit tests for `parseTodoLine`.
//
// `parseTodoLine` is a pure regex/string-parsing function — no fs IO,
// no channel calls. These tests pin the metadata extraction surface
// (priority / tags / deadline) so a future regex tweak can't silently
// drop a recognized field.
//
// Coverage:
//   - bare TODO / FIXME / HACK
//   - priority parsing (case-insensitive value normalize to lowercase)
//   - tags single + multi
//   - deadline (and `due:` alias)
//   - all metadata combined
//   - unmatched line returns null
//   - case-insensitive comment marker
//   - text trimming
//
// scanTodos integration filter coverage was added in the same phase
// (validator coverage gap) — see the second describe block below.

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { parseTodoLine, tools } from "./index";
import { getChannel } from "@ezcorp/sdk/runtime";

describe("parseTodoLine", () => {
  test("returns null for non-comment lines", () => {
    expect(parseTodoLine("const x = 1;", "src/x.ts", 5)).toBeNull();
    expect(parseTodoLine("// not a todo", "src/x.ts", 5)).toBeNull();
    expect(parseTodoLine("", "src/x.ts", 5)).toBeNull();
  });

  test("parses bare TODO/FIXME/HACK markers", () => {
    const todo = parseTodoLine("// TODO: write docs", "a.ts", 1)!;
    expect(todo).not.toBeNull();
    expect(todo.type).toBe("TODO");
    expect(todo.text).toBe("write docs");
    expect(todo.priority).toBe("");
    expect(todo.tags).toEqual([]);
    expect(todo.deadline).toBe("");
    expect(todo.file).toBe("a.ts");
    expect(todo.line).toBe(1);

    const fixme = parseTodoLine("// FIXME: broken", "b.ts", 2)!;
    expect(fixme.type).toBe("FIXME");
    expect(fixme.text).toBe("broken");

    const hack = parseTodoLine("// HACK: temporary fix", "c.ts", 3)!;
    expect(hack.type).toBe("HACK");
    expect(hack.text).toBe("temporary fix");
  });

  test("normalizes type to uppercase regardless of source casing", () => {
    const todo = parseTodoLine("// todo: lowercase marker", "x.ts", 1)!;
    expect(todo.type).toBe("TODO");

    const fixme = parseTodoLine("// FixMe: mixed case", "x.ts", 2)!;
    expect(fixme.type).toBe("FIXME");
  });

  test("parses priority metadata, lowercased", () => {
    const todo = parseTodoLine(
      "// TODO(priority:HIGH): urgent",
      "x.ts",
      1,
    )!;
    expect(todo.priority).toBe("high");
    expect(todo.text).toBe("urgent");
  });

  test("parses single + multi tags via tags: alias", () => {
    const single = parseTodoLine(
      "// TODO(tags:bug): one tag",
      "x.ts",
      1,
    )!;
    expect(single.tags).toEqual(["bug"]);

    // Multiple tags use `|` as in-value separator (commas are taken
    // by the metadata-pair separator). Mirrors the regex in index.ts.
    const multi = parseTodoLine(
      "// TODO(tags:bug|perf): twin tag",
      "x.ts",
      2,
    )!;
    expect(multi.tags).toEqual(["bug", "perf"]);
  });

  test("accepts both `tag:` and `tags:` keys", () => {
    const tag = parseTodoLine("// TODO(tag:bug): singular key", "x.ts", 1)!;
    expect(tag.tags).toEqual(["bug"]);
  });

  test("parses deadline metadata via deadline + due aliases", () => {
    const dl = parseTodoLine(
      "// TODO(deadline:2026-12-31): due soon",
      "x.ts",
      1,
    )!;
    expect(dl.deadline).toBe("2026-12-31");

    const due = parseTodoLine(
      "// TODO(due:2026-06-15): also due",
      "x.ts",
      2,
    )!;
    expect(due.deadline).toBe("2026-06-15");
  });

  test("parses all metadata fields combined", () => {
    const todo = parseTodoLine(
      "// FIXME(priority:critical, tags:bug|perf, deadline:2026-12-31): kitchen sink",
      "lib/store.ts",
      42,
    )!;
    expect(todo.type).toBe("FIXME");
    expect(todo.priority).toBe("critical");
    expect(todo.tags).toEqual(["bug", "perf"]);
    expect(todo.deadline).toBe("2026-12-31");
    expect(todo.text).toBe("kitchen sink");
    expect(todo.file).toBe("lib/store.ts");
    expect(todo.line).toBe(42);
  });

  test("trims text and tolerates missing colon after marker / metadata", () => {
    const noColon = parseTodoLine("// TODO no colon", "x.ts", 1)!;
    expect(noColon.text).toBe("no colon");

    const colonAfterMeta = parseTodoLine(
      "// TODO(priority:high) no inner colon",
      "x.ts",
      2,
    )!;
    expect(colonAfterMeta.priority).toBe("high");
    expect(colonAfterMeta.text).toBe("no inner colon");
  });

  test("ignores malformed metadata pieces (missing key or value)", () => {
    // `:high` has empty key → skip; `priority:` has empty value → skip.
    const todo = parseTodoLine(
      "// TODO(:orphan, priority:, tags:bug): partial",
      "x.ts",
      1,
    )!;
    expect(todo.priority).toBe("");
    expect(todo.tags).toEqual(["bug"]);
    expect(todo.text).toBe("partial");
  });
});

// --- scanTodos filter integration ---
//
// Phase post-perm-cleanup, validator coverage gap: `parseTodoLine` is
// well-covered above as a pure function, but `scanTodos` (the actual
// tool handler exposed to the LLM) wires together `findSourceFiles` +
// per-line parsing + the `searchQuery` / `priority` / `tags` /
// `deadline` filter chain. None of that was directly exercised. These
// tests stub the host's reverse-RPC (`ezcorp/fs.list` + `ezcorp/fs.read`)
// with a synthetic file tree and pin each filter's narrowing behavior
// so a future filter-chain refactor can't silently drop one of them.
//
// Stub contract — wire shapes mirror the production host:
//   - `ezcorp/fs.list` returns `{ entries: FsListEntry[] }` (the SDK
//     unwraps to `entries`).
//   - `ezcorp/fs.read` returns `{ encoding, body, bytes, resolvedPath }`
//     where `body` is base64-encoded; the SDK `atob`s it.
// Anything else throws so test bugs are loud.

describe("scanTodos filter integration", () => {
  // Synthetic project tree under cwd:
  //   <cwd>/file-a.ts        — TODO high priority, tag:bug
  //   <cwd>/file-b.ts        — TODO medium priority, tag:perf
  //   <cwd>/file-c.ts        — TODO with deadline 2024-01-01 (past)
  //   <cwd>/file-d.ts        — TODO with deadline 2027-12-31 (future)
  //   <cwd>/sub/file-e.svelte — FIXME critical, tag:bug
  //   <cwd>/node_modules/...  — must be skipped (exercises SKIP_DIRS)
  //
  // The synthetic tree lives entirely in the stub — no real files are
  // created. `findSourceFiles` walks from `cwd` (process.cwd()) so the
  // top-level `fsList` request points there.
  const cwd = process.cwd();

  // file-a..d at <cwd>; file-e under <cwd>/sub.
  const FILES: Record<string, { name: string; isFile: boolean; isDirectory: boolean }[]> = {
    [cwd]: [
      { name: "file-a.ts", isFile: true, isDirectory: false },
      { name: "file-b.ts", isFile: true, isDirectory: false },
      { name: "file-c.ts", isFile: true, isDirectory: false },
      { name: "file-d.ts", isFile: true, isDirectory: false },
      { name: "sub", isFile: false, isDirectory: true },
      // SKIP_DIRS — must NOT be descended. If the walk forgets to skip
      // these the test will crash with "unexpected fs.list path" since
      // we don't register a stub for them.
      { name: "node_modules", isFile: false, isDirectory: true },
      { name: ".git", isFile: false, isDirectory: true },
      { name: "dist", isFile: false, isDirectory: true },
      { name: ".svelte-kit", isFile: false, isDirectory: true },
    ],
    [`${cwd}/sub`]: [
      { name: "file-e.svelte", isFile: true, isDirectory: false },
    ],
  };

  const CONTENTS: Record<string, string> = {
    [`${cwd}/file-a.ts`]:
      "const x = 1;\n// TODO(priority:high, tags:bug): fix the alpha bug\n",
    [`${cwd}/file-b.ts`]:
      "// TODO(priority:medium, tags:perf): tune the slow path\n",
    [`${cwd}/file-c.ts`]:
      "// TODO(deadline:2024-01-01): migrate before EOL\n",
    [`${cwd}/file-d.ts`]:
      "// TODO(deadline:2027-12-31): future cleanup\n",
    [`${cwd}/sub/file-e.svelte`]:
      "// FIXME(priority:critical, tags:bug): the beta crash\n",
  };

  const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;

  beforeAll(() => {
    // SDK's `ensureFsAllowed` gate (fs.ts:161) reads this env. The stub
    // IS the host, so the gate is satisfied without granting any real
    // filesystem permission.
    process.env.EZCORP_FS_ALLOWED = "1";
  });

  afterAll(() => {
    if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
    else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
  });

  beforeEach(() => {
    // Re-install the stub on every test — preload's afterEach drops the
    // channel singleton (see src/__tests__/preload.ts:74 +
    // task-stack/index.test.ts:30 for the full rationale).
    const ch = getChannel();
    spyOn(ch, "request").mockImplementation((async (
      method: string,
      params: unknown,
    ): Promise<unknown> => {
      const p = (params ?? {}) as Record<string, unknown>;
      const path = p.path as string;
      if (method === "ezcorp/fs.list") {
        const entries = FILES[path];
        if (entries === undefined) {
          throw new Error(`todo-tracker test stub: unexpected fs.list path ${path}`);
        }
        return { entries };
      }
      if (method === "ezcorp/fs.read") {
        const text = CONTENTS[path];
        if (text === undefined) {
          throw new Error(`todo-tracker test stub: unexpected fs.read path ${path}`);
        }
        // SDK `fsRead` does `atob(result.body)`, so we encode here.
        return {
          encoding: "utf-8",
          body: btoa(text),
          bytes: text.length,
          resolvedPath: path,
        };
      }
      throw new Error(`todo-tracker test stub: unexpected RPC method ${method}`);
    }) as ReturnType<typeof getChannel>["request"]);
  });

  // The handler's success result is `toolResult(text)` →
  // `{ content: [{ type: "text", text }], isError: undefined }`.
  // We extract the rendered report string for assertions.
  async function runScan(args: Record<string, unknown> = {}): Promise<string> {
    const handler = tools["scan-todos"]!;
    const result = await handler(args);
    if (result.isError) {
      throw new Error("scan-todos returned isError");
    }
    const first = result.content[0];
    if (!first || first.type !== "text") {
      throw new Error("scan-todos returned non-text content");
    }
    return first.text;
  }

  test("no filters: reports all 5 TODOs (and ignores SKIP_DIRS)", async () => {
    const text = await runScan();
    // All 5 synthetic todos should be present (file-a..d + file-e).
    expect(text).toContain("Found 5 TODO(s)");
    expect(text).toContain("file-a.ts");
    expect(text).toContain("file-b.ts");
    expect(text).toContain("file-c.ts");
    expect(text).toContain("file-d.ts");
    expect(text).toContain("file-e.svelte");
    // SKIP_DIRS were never descended — proven by the stub not
    // throwing "unexpected fs.list path" for them.
  });

  test("searchQuery narrows to text-substring matches (case-insensitive)", async () => {
    const text = await runScan({ searchQuery: "alpha" });
    expect(text).toContain("Found 1 TODO");
    expect(text).toContain("file-a.ts");
    // Other files' text must not be matched.
    expect(text).not.toContain("file-b.ts");
    expect(text).not.toContain("file-e.svelte");
  });

  test("priority:high filter excludes other priorities", async () => {
    const text = await runScan({ priority: "high" });
    expect(text).toContain("Found 1 TODO");
    expect(text).toContain("file-a.ts"); // priority:high
    expect(text).not.toContain("file-b.ts"); // priority:medium
    expect(text).not.toContain("file-e.svelte"); // priority:critical
  });

  test("tags:[bug] filter narrows to tagged entries (across files)", async () => {
    const text = await runScan({ tags: ["bug"] });
    // file-a (tags:bug) + file-e (tags:bug) match; file-b (perf) doesn't.
    expect(text).toContain("Found 2 TODO");
    expect(text).toContain("file-a.ts");
    expect(text).toContain("file-e.svelte");
    expect(text).not.toContain("file-b.ts");
  });

  test("deadline filter excludes past-deadline AND no-deadline TODOs", async () => {
    // deadline = 2024-06-01: only entries with a deadline ON OR BEFORE
    // that date match (file-c: 2024-01-01). file-d (2027-12-31) is
    // past the cutoff. file-a/b/e have no deadline → also excluded
    // (the implementation requires `t.deadline` truthy + valid).
    const text = await runScan({ deadline: "2024-06-01" });
    expect(text).toContain("Found 1 TODO");
    expect(text).toContain("file-c.ts");
    expect(text).not.toContain("file-a.ts");
    expect(text).not.toContain("file-d.ts");
    expect(text).not.toContain("file-e.svelte");
  });

  test("filter combinations narrow further than either alone", async () => {
    // priority:high + tags:[bug] — file-a matches both (high + bug);
    // file-e is critical (not high) so it's excluded.
    const text = await runScan({ priority: "high", tags: ["bug"] });
    expect(text).toContain("Found 1 TODO");
    expect(text).toContain("file-a.ts");
    expect(text).not.toContain("file-e.svelte");
  });
});
