import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as nodePath from "node:path";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import { install } from "../../src/cli/install";

// ── tmpdir helpers ────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ai-kit-test-"));
}

function rmTmpDir(dir: string) {
  nodeFs.rmSync(dir, { recursive: true, force: true });
}

async function readJson(filePath: string): Promise<unknown> {
  const text = await Bun.file(filePath).text();
  return JSON.parse(text);
}

function fileExists(p: string): boolean {
  return nodeFs.existsSync(p);
}

// ── claude-code ───────────────────────────────────────────────────────────────

describe("install claude-code (user scope)", () => {
  let home: string;

  beforeEach(() => { home = makeTmpDir(); });
  afterEach(() => rmTmpDir(home));

  test("writes ~/.claude.json with mcpServers entry", async () => {
    await install("claude-code", { home, dryRun: false });

    const cfg = await readJson(nodePath.join(home, ".claude.json")) as Record<string, unknown>;
    expect(cfg).toHaveProperty("mcpServers");
    const servers = cfg["mcpServers"] as Record<string, unknown>;
    expect(servers).toHaveProperty("ezcorp-ai-kit");
    const entry = servers["ezcorp-ai-kit"] as Record<string, unknown>;
    expect(entry["command"]).toBe("bunx");
    expect(entry["args"]).toEqual(["@ezcorp/ai-kit", "mcp"]);
    expect(entry).toHaveProperty("env");
  });

  test("idempotent — running twice produces identical config", async () => {
    await install("claude-code", { home, dryRun: false });
    const first = await readJson(nodePath.join(home, ".claude.json"));

    await install("claude-code", { home, dryRun: false });
    const second = await readJson(nodePath.join(home, ".claude.json"));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("merges into existing config without clobbering other keys", async () => {
    const cfgPath = nodePath.join(home, ".claude.json");
    await Bun.write(cfgPath, JSON.stringify({ existingKey: "keep-me", mcpServers: { other: { command: "x" } } }));

    await install("claude-code", { home, dryRun: false });

    const cfg = await readJson(cfgPath) as Record<string, unknown>;
    expect(cfg["existingKey"]).toBe("keep-me");
    const servers = cfg["mcpServers"] as Record<string, unknown>;
    expect(servers).toHaveProperty("other");
    expect(servers).toHaveProperty("ezcorp-ai-kit");
  });

  test("dry-run does NOT write any files", async () => {
    await install("claude-code", { home, dryRun: true });
    expect(fileExists(nodePath.join(home, ".claude.json"))).toBe(false);
  });
});

describe("install claude-code (project scope --project)", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = makeTmpDir();
    cwd = makeTmpDir();
  });
  afterEach(() => { rmTmpDir(home); rmTmpDir(cwd); });

  test("writes .claude.json in cwd, not in home", async () => {
    await install("claude-code", { home, cwd, dryRun: false, project: true });

    expect(fileExists(nodePath.join(cwd, ".claude.json"))).toBe(true);
    expect(fileExists(nodePath.join(home, ".claude.json"))).toBe(false);

    const cfg = await readJson(nodePath.join(cwd, ".claude.json")) as Record<string, unknown>;
    const servers = cfg["mcpServers"] as Record<string, unknown>;
    expect(servers).toHaveProperty("ezcorp-ai-kit");
  });

  test("idempotent in project scope", async () => {
    await install("claude-code", { home, cwd, dryRun: false, project: true });
    const first = await readJson(nodePath.join(cwd, ".claude.json"));

    await install("claude-code", { home, cwd, dryRun: false, project: true });
    const second = await readJson(nodePath.join(cwd, ".claude.json"));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("dry-run project scope does NOT write", async () => {
    await install("claude-code", { home, cwd, dryRun: true, project: true });
    expect(fileExists(nodePath.join(cwd, ".claude.json"))).toBe(false);
  });
});

// ── cursor ────────────────────────────────────────────────────────────────────

describe("install cursor", () => {
  let home: string;

  beforeEach(() => { home = makeTmpDir(); });
  afterEach(() => rmTmpDir(home));

  test("writes ~/.cursor/mcp.json with mcpServers entry", async () => {
    await install("cursor", { home, dryRun: false });

    const cfgPath = nodePath.join(home, ".cursor", "mcp.json");
    expect(fileExists(cfgPath)).toBe(true);
    const cfg = await readJson(cfgPath) as Record<string, unknown>;
    const servers = cfg["mcpServers"] as Record<string, unknown>;
    expect(servers).toHaveProperty("ezcorp-ai-kit");
    const entry = servers["ezcorp-ai-kit"] as Record<string, unknown>;
    expect(entry["command"]).toBe("bunx");
  });

  test("idempotent", async () => {
    await install("cursor", { home, dryRun: false });
    const first = await readJson(nodePath.join(home, ".cursor", "mcp.json"));

    await install("cursor", { home, dryRun: false });
    const second = await readJson(nodePath.join(home, ".cursor", "mcp.json"));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("dry-run does not write", async () => {
    await install("cursor", { home, dryRun: true });
    expect(fileExists(nodePath.join(home, ".cursor", "mcp.json"))).toBe(false);
  });
});

// ── zed ───────────────────────────────────────────────────────────────────────

describe("install zed", () => {
  let home: string;

  beforeEach(() => { home = makeTmpDir(); });
  afterEach(() => rmTmpDir(home));

  test("writes ~/.config/zed/settings.json with context_servers entry", async () => {
    await install("zed", { home, dryRun: false });

    const cfgPath = nodePath.join(home, ".config", "zed", "settings.json");
    expect(fileExists(cfgPath)).toBe(true);
    const cfg = await readJson(cfgPath) as Record<string, unknown>;
    const servers = cfg["context_servers"] as Record<string, unknown>;
    expect(servers).toHaveProperty("ezcorp-ai-kit");
    const entry = servers["ezcorp-ai-kit"] as Record<string, unknown>;
    expect(entry["command"]).toBe("bunx");
  });

  test("idempotent", async () => {
    await install("zed", { home, dryRun: false });
    const first = await readJson(nodePath.join(home, ".config", "zed", "settings.json"));

    await install("zed", { home, dryRun: false });
    const second = await readJson(nodePath.join(home, ".config", "zed", "settings.json"));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("dry-run does not write", async () => {
    await install("zed", { home, dryRun: true });
    expect(fileExists(nodePath.join(home, ".config", "zed", "settings.json"))).toBe(false);
  });

  test("merges with existing zed settings", async () => {
    const cfgPath = nodePath.join(home, ".config", "zed", "settings.json");
    nodeFs.mkdirSync(nodePath.dirname(cfgPath), { recursive: true });
    await Bun.write(cfgPath, JSON.stringify({ theme: "dark", context_servers: { other: {} } }));

    await install("zed", { home, dryRun: false });

    const cfg = await readJson(cfgPath) as Record<string, unknown>;
    expect(cfg["theme"]).toBe("dark");
    const servers = cfg["context_servers"] as Record<string, unknown>;
    expect(servers).toHaveProperty("other");
    expect(servers).toHaveProperty("ezcorp-ai-kit");
  });
});

// ── windsurf ──────────────────────────────────────────────────────────────────

describe("install windsurf", () => {
  let home: string;

  beforeEach(() => { home = makeTmpDir(); });
  afterEach(() => rmTmpDir(home));

  test("writes ~/.codeium/windsurf/mcp_config.json with mcpServers entry", async () => {
    await install("windsurf", { home, dryRun: false });

    const cfgPath = nodePath.join(home, ".codeium", "windsurf", "mcp_config.json");
    expect(fileExists(cfgPath)).toBe(true);
    const cfg = await readJson(cfgPath) as Record<string, unknown>;
    const servers = cfg["mcpServers"] as Record<string, unknown>;
    expect(servers).toHaveProperty("ezcorp-ai-kit");
    const entry = servers["ezcorp-ai-kit"] as Record<string, unknown>;
    expect(entry["command"]).toBe("bunx");
    expect(entry["args"]).toEqual(["@ezcorp/ai-kit", "mcp"]);
  });

  test("idempotent", async () => {
    await install("windsurf", { home, dryRun: false });
    const first = await readJson(nodePath.join(home, ".codeium", "windsurf", "mcp_config.json"));

    await install("windsurf", { home, dryRun: false });
    const second = await readJson(nodePath.join(home, ".codeium", "windsurf", "mcp_config.json"));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("dry-run does not write", async () => {
    await install("windsurf", { home, dryRun: true });
    expect(fileExists(nodePath.join(home, ".codeium", "windsurf", "mcp_config.json"))).toBe(false);
  });
});

// ── ezcorp ────────────────────────────────────────────────────────────────────

describe("install ezcorp", () => {
  let home: string;
  let projectRoot: string;

  beforeEach(() => {
    home = makeTmpDir();
    projectRoot = makeTmpDir();
    // Make it look like a git project root
    nodeFs.mkdirSync(nodePath.join(projectRoot, ".git"), { recursive: true });
  });
  afterEach(() => { rmTmpDir(home); rmTmpDir(projectRoot); });

  test("creates symlink at <root>/.ezcorp/extensions/ai-kit", async () => {
    await install("ezcorp", { home, cwd: projectRoot, dryRun: false, projectPath: projectRoot });

    const linkPath = nodePath.join(projectRoot, ".ezcorp", "extensions", "ai-kit");
    expect(fileExists(linkPath)).toBe(true);
    expect(nodeFs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  test("idempotent — second install replaces existing symlink cleanly", async () => {
    await install("ezcorp", { home, cwd: projectRoot, dryRun: false, projectPath: projectRoot });
    await install("ezcorp", { home, cwd: projectRoot, dryRun: false, projectPath: projectRoot });

    const linkPath = nodePath.join(projectRoot, ".ezcorp", "extensions", "ai-kit");
    expect(nodeFs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  test("dry-run does not create symlink", async () => {
    await install("ezcorp", { home, cwd: projectRoot, dryRun: true, projectPath: projectRoot });

    const linkPath = nodePath.join(projectRoot, ".ezcorp", "extensions", "ai-kit");
    expect(fileExists(linkPath)).toBe(false);
  });

  test("throws when no git root found and no projectPath given", async () => {
    const isolated = makeTmpDir(); // no .git
    try {
      await expect(
        install("ezcorp", { home, cwd: isolated, dryRun: false }),
      ).rejects.toThrow("Could not find a project root");
    } finally {
      rmTmpDir(isolated);
    }
  });
});

// ── unknown target ────────────────────────────────────────────────────────────

describe("install unknown target", () => {
  test("throws with helpful message", async () => {
    await expect(install("vscode", {})).rejects.toThrow("Unknown install target");
  });
});

// ── MCP entry shape ───────────────────────────────────────────────────────────

describe("MCP entry shape across all file-based targets", () => {
  const targets = ["claude-code", "cursor", "zed", "windsurf"] as const;

  for (const target of targets) {
    test(`${target}: entry has command=bunx, args=[@ezcorp/ai-kit,mcp], env keys`, async () => {
      const home = makeTmpDir();
      try {
        await install(target, { home, dryRun: false });

        let cfg: Record<string, unknown>;
        if (target === "claude-code") {
          cfg = await readJson(nodePath.join(home, ".claude.json")) as Record<string, unknown>;
        } else if (target === "cursor") {
          cfg = await readJson(nodePath.join(home, ".cursor", "mcp.json")) as Record<string, unknown>;
        } else if (target === "zed") {
          cfg = await readJson(nodePath.join(home, ".config", "zed", "settings.json")) as Record<string, unknown>;
        } else {
          cfg = await readJson(nodePath.join(home, ".codeium", "windsurf", "mcp_config.json")) as Record<string, unknown>;
        }

        const serverKey = target === "zed" ? "context_servers" : "mcpServers";
        const servers = cfg[serverKey] as Record<string, Record<string, unknown>>;
        const entry = servers["ezcorp-ai-kit"]!;
        expect(entry["command"]).toBe("bunx");
        expect(entry["args"]).toEqual(["@ezcorp/ai-kit", "mcp"]);
        const env = entry["env"] as Record<string, string>;
        expect(env).toHaveProperty("EZCORP_BASE_URL");
        expect(env).toHaveProperty("EZCORP_API_KEY");
      } finally {
        rmTmpDir(home);
      }
    });
  }
});
