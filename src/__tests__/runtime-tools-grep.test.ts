import { test, expect, describe, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { createGrepTool } from "../runtime/tools/grep";
import { TOOL_OUTPUT_LIMITS } from "../runtime/tools/output-limits";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { resolve } from "path";
import { tmpdir } from "os";

function getText(result: any): string {
  return result.content[0].text;
}

function det(result: any): any {
  return result.details;
}

const HAS_RG = Bun.which("rg") !== null;
const ORIGINAL_GREP_CAP = TOOL_OUTPUT_LIMITS.grep;

/**
 * Keep the child real while making its stdout delivery deterministic. This
 * reproduces the hosted boundary where the first read was exactly the cap.
 */
function splitStdoutEvery(
  stream: ReadableStream<Uint8Array>,
  chunkBytes: number,
): ReadableStream<Uint8Array> {
  let pending = new Uint8Array();
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const joined = new Uint8Array(pending.byteLength + chunk.byteLength);
        joined.set(pending);
        joined.set(chunk, pending.byteLength);
        let offset = 0;
        while (joined.byteLength - offset >= chunkBytes) {
          controller.enqueue(joined.slice(offset, offset + chunkBytes));
          offset += chunkBytes;
        }
        pending = joined.slice(offset);
      },
      flush(controller) {
        if (pending.byteLength > 0) controller.enqueue(pending);
      },
    }),
  );
}

function withSplitGrepStdout(chunkBytes: number) {
  const realSpawn = Bun.spawn;
  let childExited = false;
  const spy = spyOn(Bun, "spawn").mockImplementation(((
    command: string[] | string,
    options?: Parameters<typeof Bun.spawn>[1],
  ) => {
    const child = realSpawn(command as string[], options);
    if (!Array.isArray(command) || command[0] !== "grep" || !(child.stdout instanceof ReadableStream)) return child;
    void child.exited.then(() => {
      childExited = true;
    });
    const stdout = splitStdoutEvery(child.stdout, chunkBytes);
    return new Proxy(child, {
      get(target, property) {
        return property === "stdout" ? stdout : Reflect.get(target, property);
      },
    });
  }) as typeof Bun.spawn);
  return { spy, childExited: () => childExited };
}

async function withForcedFirstChunk(
  content: string,
  check: (result: any, childExited: boolean) => void | Promise<void>,
): Promise<void> {
  TOOL_OUTPUT_LIMITS.grep = 4 * 1024;
  process.env.EZCORP_GREP_BACKEND = "grep";
  const split = withSplitGrepStdout(4 * 1024);
  const filename = resolve(projectPath, "forced-first-cap.txt");
  try {
    await writeFile(filename, content);
    const result = await createGrepTool(projectPath).execute("1", {
      pattern: "needle",
      path: "forced-first-cap.txt",
    });
    await check(result, split.childExited());
  } finally {
    split.spy.mockRestore();
    await rm(filename, { force: true });
  }
}

let projectPath: string;

beforeAll(async () => {
  projectPath = await mkdtemp(resolve(tmpdir(), "grep-test-"));
  await mkdir(resolve(projectPath, "src"), { recursive: true });
  await writeFile(
    resolve(projectPath, "src/hello.ts"),
    "const greeting = 'Hello World';\nconst farewell = 'Goodbye World';",
  );
  await writeFile(
    resolve(projectPath, "src/utils.ts"),
    "export function hello() { return 'hello'; }\nexport function HELLO() { return 'HELLO'; }",
  );
  await writeFile(resolve(projectPath, "readme.txt"), "This has no matching content.");
});

afterAll(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

// Several tests pin the backend / timeout via env. Always restore so a
// forced backend can't leak into an unrelated test.
afterEach(() => {
  delete process.env.EZCORP_GREP_BACKEND;
  delete process.env.EZCORP_GREP_TIMEOUT_MS;
  if (ORIGINAL_GREP_CAP === undefined) delete TOOL_OUTPUT_LIMITS.grep;
  else TOOL_OUTPUT_LIMITS.grep = ORIGINAL_GREP_CAP;
});

describe("createGrepTool", () => {
  test("finds matches across files and reports a positive matchCount", async () => {
    const tool = createGrepTool(projectPath);
    const result = await tool.execute("1", { pattern: "hello", path: "." });
    expect(det(result).matchCount).toBeGreaterThan(0);
    expect(getText(result)).toContain("hello");
    expect(det(result).pattern).toBe("hello");
  });

  test("returns 'No matches found.' when nothing matches", async () => {
    const tool = createGrepTool(projectPath);
    const result = await tool.execute("1", { pattern: "zzz_never_present_zzz", path: "." });
    expect(getText(result)).toContain("No matches found");
    expect(det(result).matchCount).toBe(0);
  });

  test("case-insensitive search finds more hits than case-sensitive", async () => {
    const tool = createGrepTool(projectPath);
    const sensitive = await tool.execute("1", { pattern: "hello", path: "src", caseSensitive: true });
    const insensitive = await tool.execute("1", { pattern: "hello", path: "src", caseSensitive: false });
    expect(det(insensitive).matchCount).toBeGreaterThan(det(sensitive).matchCount);
  });

  test("rejects path traversal", async () => {
    const tool = createGrepTool(projectPath);
    const result = await tool.execute("1", { pattern: "hello", path: "../.." });
    expect(getText(result)).toContain("Path traversal");
    expect(det(result).isError).toBe(true);
  });

  test("truncates output exceeding the grep cap and flags details.truncated", async () => {
    const longLine = "needle " + "x".repeat(2000);
    const content = Array.from({ length: 50 }, () => longLine).join("\n");
    await writeFile(resolve(projectPath, "hits.txt"), content);

    TOOL_OUTPUT_LIMITS.grep = 4 * 1024; // 4 KB
    try {
      const tool = createGrepTool(projectPath);
      const result = await tool.execute("1", { pattern: "needle", path: "." });
      const text = getText(result);
      expect(text).toContain("[output truncated:");
      expect(text).toContain("grep cap is 4 KB");
      expect(det(result).truncated).toBe(true);
      expect(det(result).matchCount).toBeGreaterThan(0);
    } finally {
      await rm(resolve(projectPath, "hits.txt"), { force: true });
    }
  });

  test("marks an exact-cap first stdout chunk as truncated without mocking grep", async () => {
    // One finite real grep result is larger than two 4 KiB chunks. The spy
    // changes only stdout chunking; argv, stderr, exit and child stay real.
    await withForcedFirstChunk(`needle ${"x".repeat(9 * 1024)}\n`, (result, childExited) => {
      expect(getText(result)).toContain("[output truncated:");
      expect(det(result).truncated).toBe(true);
      expect(childExited).toBe(true);
    });
  });

  test("does not mark an exact-cap EOF as truncated", async () => {
    const cap = 4 * 1024;
    // GNU grep prints `1:` for this one file, then the matching line and LF.
    const prefix = "1:needle ";
    await withForcedFirstChunk(`needle ${"x".repeat(cap - prefix.length - 1)}\n`, (result, childExited) => {
      expect(getText(result).length).toBe(cap - 1);
      expect(getText(result)).not.toContain("[output truncated:");
      expect(det(result).truncated).toBeUndefined();
      expect(childExited).toBe(true);
    });
  });

  test("keeps a valid UTF-8 prefix when truncation splits a code point", async () => {
    const cap = 4 * 1024;
    const prefix = "1:needle ";
    // The first byte of é is at the cap boundary; the reader must not emit a
    // replacement character when it cancels the overflowing stream.
    await withForcedFirstChunk(
      `needle ${"x".repeat(cap - prefix.length - 1)}é trailing\n`,
      (result, childExited) => {
        expect(getText(result)).toContain("[output truncated:");
        expect(getText(result)).not.toContain("\uFFFD");
        expect(det(result).truncated).toBe(true);
        expect(childExited).toBe(true);
      },
    );
  });

  test("surfaces a real search error (invalid regex) instead of masking it as no-match", async () => {
    process.env.EZCORP_GREP_BACKEND = "grep";
    const tool = createGrepTool(projectPath);
    // Unclosed bracket → invalid BRE → grep exits 2 with no stdout.
    const result = await tool.execute("1", { pattern: "[", path: "src" });
    expect(getText(result)).toContain("Error:");
    expect(det(result).isError).toBe(true);
    expect(det(result).matchCount).toBe(0);
  });

  test("reports the backend used in details", async () => {
    process.env.EZCORP_GREP_BACKEND = "grep";
    const tool = createGrepTool(projectPath);
    const result = await tool.execute("1", { pattern: "hello", path: "src" });
    expect(det(result).backend).toBe("grep");
  });
});

describe("createGrepTool — ignore handling", () => {
  let ignProject: string;

  beforeAll(async () => {
    ignProject = await mkdtemp(resolve(tmpdir(), "grep-ign-"));
    await mkdir(resolve(ignProject, "src"), { recursive: true });
    await mkdir(resolve(ignProject, "node_modules", "pkg"), { recursive: true });
    await writeFile(resolve(ignProject, "src/app.ts"), "const NEEDLE_TOKEN = 1;");
    await writeFile(
      resolve(ignProject, "node_modules", "pkg", "vendor.ts"),
      "const NEEDLE_TOKEN = 2;",
    );
    // ripgrep always honours `.ignore` (no git repo required), so this is
    // the deterministic way to assert default ignore behaviour.
    await writeFile(resolve(ignProject, ".ignore"), "node_modules/\n");
  });

  afterAll(async () => {
    await rm(ignProject, { recursive: true, force: true });
  });

  test.skipIf(!HAS_RG)(
    "ripgrep skips ignored dirs by default",
    async () => {
      process.env.EZCORP_GREP_BACKEND = "rg";
      const tool = createGrepTool(ignProject);
      const result = await tool.execute("1", { pattern: "NEEDLE_TOKEN", path: "." });
      const text = getText(result);
      expect(text).toContain("app.ts");
      expect(text).not.toContain("node_modules");
      expect(det(result).matchCount).toBe(1);
    },
  );

  test.skipIf(!HAS_RG)(
    "ripgrep noIgnore:true also searches ignored dirs",
    async () => {
      process.env.EZCORP_GREP_BACKEND = "rg";
      const tool = createGrepTool(ignProject);
      const result = await tool.execute("1", {
        pattern: "NEEDLE_TOKEN",
        path: ".",
        noIgnore: true,
      });
      expect(getText(result)).toContain("node_modules");
      expect(det(result).matchCount).toBe(2);
    },
  );

  test("GNU grep fallback skips node_modules via --exclude-dir", async () => {
    process.env.EZCORP_GREP_BACKEND = "grep";
    const tool = createGrepTool(ignProject);
    const result = await tool.execute("1", { pattern: "NEEDLE_TOKEN", path: "." });
    const text = getText(result);
    expect(text).toContain("app.ts");
    expect(text).not.toContain("node_modules");
    expect(det(result).matchCount).toBe(1);
    expect(det(result).backend).toBe("grep");
  });

  test("GNU grep noIgnore:true drops the excludes and finds node_modules", async () => {
    process.env.EZCORP_GREP_BACKEND = "grep";
    const tool = createGrepTool(ignProject);
    const result = await tool.execute("1", {
      pattern: "NEEDLE_TOKEN",
      path: ".",
      noIgnore: true,
    });
    expect(getText(result)).toContain("node_modules");
    expect(det(result).matchCount).toBe(2);
  });
});

describe("createGrepTool — graceful early exit (no run-kill)", () => {
  let fifoProject: string;
  let fifoRel: string;

  beforeAll(async () => {
    fifoProject = await mkdtemp(resolve(tmpdir(), "grep-fifo-"));
    fifoRel = "blocking.fifo";
    const mk = Bun.spawn(["mkfifo", resolve(fifoProject, fifoRel)]);
    await mk.exited;
  });

  afterAll(async () => {
    await rm(fifoProject, { recursive: true, force: true });
  });

  test("AbortSignal → graceful 'Search aborted.' instead of a wedged run", async () => {
    // Target the fifo directly: with no writer, grep blocks on read
    // forever, so the abort branch deterministically wins the race.
    process.env.EZCORP_GREP_BACKEND = "grep";
    const tool = createGrepTool(fifoProject);
    const ctrl = new AbortController();
    const p = tool.execute("1", { pattern: "anything", path: fifoRel }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 100);
    const result = await p;
    expect(getText(result)).toBe("Search aborted.");
    expect(det(result).aborted).toBe(true);
    expect(det(result).isError).toBe(true);
  });

  test("soft timeout → graceful timeout message, not a watchdog kill", async () => {
    process.env.EZCORP_GREP_BACKEND = "grep";
    process.env.EZCORP_GREP_TIMEOUT_MS = "1000"; // floor
    const tool = createGrepTool(fifoProject);
    const start = Date.now();
    const result = await tool.execute("1", { pattern: "anything", path: fifoRel });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
    expect(getText(result).toLowerCase()).toContain("timed out");
    expect(det(result).timeout).toBe(true);
    expect(det(result).isError).toBe(true);
  });

  test("callTimeoutMs sits a margin above the soft timeout", () => {
    process.env.EZCORP_GREP_TIMEOUT_MS = "1000";
    const tool = createGrepTool(fifoProject);
    // Margin guarantees the tool's own graceful return always fires
    // before the executor watchdog would preempt it.
    expect(tool.callTimeoutMs).toBe(1000 + 15000);
  });
});
