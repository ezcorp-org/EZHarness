import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { createBuiltinTools, getBuiltinToolDefs } from "./index";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  TOOL_OUTPUT_LIMITS,
  getToolOutputLimit,
  formatBytes,
  describeOutputCap,
  truncateText,
  buildTruncationMarker,
} from "./output-limits";
import { resolve } from "path";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";

function getText(result: any): string {
  return result.content[0].text;
}

async function createTempProject() {
  return mkdtemp(resolve(tmpdir(), "tools-test-"));
}

// ── Shell tool ──

describe("shell tool", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await createTempProject();
  });

  afterAll(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  test("executes a simple command and returns stdout", async () => {
    const tools = getBuiltinToolDefs(projectPath);
    const shell = tools.find(t => t.name === "shell")!;
    const result = await shell.execute("1", { command: "echo hello" });
    expect(getText(result).trim()).toBe("hello");
  });

  test("returns exit code in details", async () => {
    const tools = getBuiltinToolDefs(projectPath);
    const shell = tools.find(t => t.name === "shell")!;
    const result = await shell.execute("1", { command: "echo ok" });
    expect(result.details.exitCode).toBe(0);

    const result2 = await shell.execute("1", { command: "cat nonexistent_file_xyz 2>/dev/null; exit 1" });
    expect(result2.details.exitCode).toBe(1);
  });

  test("truncates output exceeding 1MB with shared marker format", async () => {
    const tools = getBuiltinToolDefs(projectPath);
    const shell = tools.find(t => t.name === "shell")!;
    // Generate >1MB output
    const result = await shell.execute("1", { command: "dd if=/dev/zero bs=1024 count=1100 2>/dev/null | base64" });
    const text = getText(result);
    expect(text).toContain("[output truncated:");
    expect(text).toContain("shell cap is 1 MB");
    // Marker is small; the kept content stays at/just above 1MB.
    expect(text.length).toBeLessThanOrEqual(1024 * 1024 + 500);
  });

  test("respects timeout", async () => {
    const tools = getBuiltinToolDefs(projectPath);
    const shell = tools.find(t => t.name === "shell")!;
    const start = Date.now();
    const result = await shell.execute("1", { command: "sleep 10", timeout: 1500 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    const text = getText(result);
    expect(text.toLowerCase()).toContain("timed out");
  });
});

// ── Grep tool ──

describe("grep tool", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await createTempProject();
    await mkdir(resolve(projectPath, "src"), { recursive: true });
    await writeFile(resolve(projectPath, "src/hello.ts"), "const greeting = 'Hello World';\nconst farewell = 'Goodbye World';");
    await writeFile(resolve(projectPath, "src/utils.ts"), "export function hello() { return 'hello'; }\nexport function HELLO() { return 'HELLO'; }");
    await writeFile(resolve(projectPath, "readme.txt"), "This has no matching content.");
  });

  afterAll(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  test("finds pattern in files and returns match count", async () => {
    const tools = getBuiltinToolDefs(projectPath);
    const grep = tools.find(t => t.name === "grep")!;
    const result = await grep.execute("1", { pattern: "hello", path: "." });
    expect(result.details.matchCount).toBeGreaterThan(0);
    expect(getText(result)).toContain("hello");
  });

  test("returns 'No matches found' for no results", async () => {
    const tools = getBuiltinToolDefs(projectPath);
    const grep = tools.find(t => t.name === "grep")!;
    const result = await grep.execute("1", { pattern: "zzz_nonexistent_pattern_zzz", path: "." });
    expect(getText(result)).toContain("No matches found");
  });

  test("respects caseSensitive flag", async () => {
    const tools = getBuiltinToolDefs(projectPath);
    const grep = tools.find(t => t.name === "grep")!;

    // Case sensitive (default) - should only match lowercase
    const sensitive = await grep.execute("1", { pattern: "hello", path: "src", caseSensitive: true });
    const sensitiveText = getText(sensitive);

    // Case insensitive - should match both hello and HELLO
    const insensitive = await grep.execute("1", { pattern: "hello", path: "src", caseSensitive: false });
    expect(insensitive.details.matchCount).toBeGreaterThan(sensitive.details.matchCount);
  });
});

// ── Glob tool ──

describe("glob tool", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await createTempProject();
    await mkdir(resolve(projectPath, "src/components"), { recursive: true });
    await writeFile(resolve(projectPath, "src/index.ts"), "");
    await writeFile(resolve(projectPath, "src/utils.ts"), "");
    await writeFile(resolve(projectPath, "src/components/Button.svelte"), "");
    await writeFile(resolve(projectPath, "readme.md"), "");
  });

  afterAll(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  test("finds files matching pattern", async () => {
    const tools = getBuiltinToolDefs(projectPath);
    const glob = tools.find(t => t.name === "glob")!;
    const result = await glob.execute("1", { pattern: "**/*.ts" });
    const text = getText(result);
    expect(text).toContain("index.ts");
    expect(text).toContain("utils.ts");
    expect(text).not.toContain("Button.svelte");
  });

  test("respects maxResults truncation", async () => {
    const tools = getBuiltinToolDefs(projectPath);
    const glob = tools.find(t => t.name === "glob")!;
    const result = await glob.execute("1", { pattern: "**/*", maxResults: 2 });
    expect(result.details.truncated).toBe(true);
    expect(result.details.fileCount).toBe(2);
  });
});

// ── Registry ──

describe("createBuiltinTools registry", () => {
  test("createBuiltinTools returns all 7 tools with correct names", () => {
    const tools = createBuiltinTools("/tmp/test-project");
    expect(tools).toHaveLength(7);
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual(["editFile", "glob", "grep", "listFiles", "readDirectory", "readFile", "shell"].sort());
  });

  test("each tool has category and cardType set", () => {
    const defs = getBuiltinToolDefs("/tmp/test-project");
    for (const def of defs) {
      expect(def.category).toBeDefined();
      expect(["read", "write", "execute"]).toContain(def.category);
      expect(def.cardType).toBeDefined();
      expect(["terminal", "diff", "search-results", "table", "default"]).toContain(def.cardType);
    }
  });

  test("each AgentTool from createBuiltinTools has required properties", () => {
    const tools = createBuiltinTools("/tmp/test-project");
    for (const tool of tools) {
      expect(tool.name).toBeString();
      expect(tool.label).toBeString();
      expect(tool.description).toBeString();
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeFunction();
    }
  });

  test("every def has maxOutputBytes populated", () => {
    const defs = getBuiltinToolDefs("/tmp/test-project");
    for (const def of defs) {
      expect(def.maxOutputBytes).toBe(getToolOutputLimit(def.name));
    }
  });

  test("every def's description advertises its output cap", () => {
    const defs = getBuiltinToolDefs("/tmp/test-project");
    for (const def of defs) {
      expect(def.description).toContain("Output is capped at");
      expect(def.description).toContain(formatBytes(getToolOutputLimit(def.name)));
    }
  });

  test("shell's description advertises the 1 MB cap, not the default 8 MB", () => {
    const defs = getBuiltinToolDefs("/tmp/test-project");
    const shell = defs.find(d => d.name === "shell")!;
    expect(shell.description).toContain("1 MB");
    expect(shell.description).not.toContain("8 MB");
    expect(shell.maxOutputBytes).toBe(1024 * 1024);
  });
});

// ── Output truncation (the fix for OpenAI's 10 MiB input-string limit) ──

describe("readFile truncation", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await mkdtemp(resolve(tmpdir(), "tools-readfile-trunc-"));
  });

  afterAll(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  test("small files are returned verbatim with no truncation marker", async () => {
    await writeFile(resolve(projectPath, "small.txt"), "hello world");
    const tools = getBuiltinToolDefs(projectPath);
    const readFile = tools.find(t => t.name === "readFile")!;
    const result = await readFile.execute("1", { path: "small.txt" });
    expect(getText(result)).toBe("hello world");
    expect(result.details.truncated).toBeUndefined();
  });

  test("files larger than the cap are truncated with the shared marker", async () => {
    // Temporarily override the readFile cap to something small so we don't
    // have to write 8+ MB to disk in a unit test.
    const originalCap = TOOL_OUTPUT_LIMITS.readFile;
    TOOL_OUTPUT_LIMITS.readFile = 4 * 1024; // 4 KB
    try {
      const big = "A".repeat(10 * 1024); // 10 KB of 'A'
      await writeFile(resolve(projectPath, "big.txt"), big);
      const tools = getBuiltinToolDefs(projectPath);
      const readFile = tools.find(t => t.name === "readFile")!;
      const result = await readFile.execute("1", { path: "big.txt" });
      const text = getText(result);
      expect(text.startsWith("AAAA")).toBe(true);
      expect(text).toContain("[output truncated:");
      expect(text).toContain("readFile cap is 4 KB");
      expect(result.details.truncated).toBe(true);
      expect(result.details.originalBytes).toBe(10 * 1024);
    } finally {
      if (originalCap === undefined) delete TOOL_OUTPUT_LIMITS.readFile;
      else TOOL_OUTPUT_LIMITS.readFile = originalCap;
    }
  });
});

describe("grep truncation", () => {
  let projectPath: string;

  beforeAll(async () => {
    projectPath = await mkdtemp(resolve(tmpdir(), "tools-grep-trunc-"));
  });

  afterAll(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  test("grep output larger than the cap is truncated", async () => {
    // Write a file full of very long matching lines, then drop the cap.
    const longLine = "needle " + "x".repeat(2000);
    const content = Array.from({ length: 50 }, () => longLine).join("\n");
    await writeFile(resolve(projectPath, "hits.txt"), content);

    const originalCap = TOOL_OUTPUT_LIMITS.grep;
    TOOL_OUTPUT_LIMITS.grep = 4 * 1024; // 4 KB
    try {
      const tools = getBuiltinToolDefs(projectPath);
      const grep = tools.find(t => t.name === "grep")!;
      const result = await grep.execute("1", { pattern: "needle", path: "." });
      const text = getText(result);
      expect(text).toContain("[output truncated:");
      expect(text).toContain("grep cap is 4 KB");
      expect(result.details.truncated).toBe(true);
      expect(result.details.matchCount).toBeGreaterThan(0);
    } finally {
      if (originalCap === undefined) delete TOOL_OUTPUT_LIMITS.grep;
      else TOOL_OUTPUT_LIMITS.grep = originalCap;
    }
  });
});

describe("output-limits helpers", () => {
  test("default cap sits safely under OpenAI's 10 MiB hard limit", () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThan(10 * 1024 * 1024);
    // Headroom of at least 1 MB so the marker + per-message overhead can't blow the budget.
    expect(10 * 1024 * 1024 - DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });

  test("getToolOutputLimit returns per-tool overrides and falls back to default", () => {
    expect(getToolOutputLimit("shell")).toBe(1024 * 1024);
    expect(getToolOutputLimit("readFile")).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(getToolOutputLimit("nonexistent")).toBe(DEFAULT_MAX_OUTPUT_BYTES);
  });

  test("formatBytes renders MB/KB/B cleanly", () => {
    expect(formatBytes(8 * 1024 * 1024)).toBe("8 MB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
    expect(formatBytes(4 * 1024)).toBe("4 KB");
    expect(formatBytes(256)).toBe("256 B");
  });

  test("describeOutputCap surfaces the cap in a human sentence", () => {
    expect(describeOutputCap("shell")).toContain("1 MB");
    expect(describeOutputCap("readFile")).toContain("8 MB");
  });

  test("truncateText passes short text through unchanged", () => {
    const r = truncateText("hello", 100, "readFile");
    expect(r.text).toBe("hello");
    expect(r.truncated).toBe(false);
    expect(r.originalBytes).toBe(5);
  });

  test("truncateText truncates to byte count and appends a marker with accurate numbers", () => {
    const input = "A".repeat(10_000);
    const r = truncateText(input, 1000, "readFile");
    expect(r.truncated).toBe(true);
    expect(r.originalBytes).toBe(10_000);
    expect(r.text.startsWith("A".repeat(1000))).toBe(true);
    expect(r.text).toContain("readFile cap is");
    expect(r.text).toContain("[output truncated:");
  });

  test("truncateText survives a cut inside a multi-byte UTF-8 sequence", () => {
    // "é" is 2 UTF-8 bytes. Capping at an odd byte count must not throw.
    const input = "é".repeat(500);
    const r = truncateText(input, 101, "readFile");
    expect(r.truncated).toBe(true);
    // Decoder is non-fatal so a split multi-byte char is replaced with U+FFFD
    // (replacement char) rather than throwing — verify no throw and marker is present.
    expect(r.text).toContain("[output truncated:");
  });

  test("buildTruncationMarker produces the shared format consumed by both paths", () => {
    const marker = buildTruncationMarker("shell", 2 * 1024, 3 * 1024, 1024);
    expect(marker).toContain("shell cap is 1 KB");
    expect(marker).toContain("2 KB omitted of 3 KB total");
  });
});
