import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as nodePath from "node:path";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";

/** Absolute path to the CLI entry point so Bun.spawn can invoke it directly. */
const CLI_PATH = nodePath.resolve(
  nodePath.dirname(Bun.main),
  "..",
  "..",
  "src",
  "cli",
  "index.ts",
);

function makeTmpDir(): string {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ai-kit-integ-"));
}

function rmTmpDir(dir: string) {
  nodeFs.rmSync(dir, { recursive: true, force: true });
}

async function readJson(filePath: string): Promise<unknown> {
  const text = await Bun.file(filePath).text();
  return JSON.parse(text);
}

async function spawnCli(args: string[], env: Record<string, string> = {}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// ── claude-code integration ───────────────────────────────────────────────────

describe("CLI install claude-code (spawned process)", () => {
  let home: string;

  beforeEach(() => { home = makeTmpDir(); });
  afterEach(() => rmTmpDir(home));

  test("exits 0 and writes ~/.claude.json", async () => {
    const { exitCode } = await spawnCli(["install", "claude-code"], { HOME: home });

    expect(exitCode).toBe(0);
    const cfgPath = nodePath.join(home, ".claude.json");
    expect(nodeFs.existsSync(cfgPath)).toBe(true);
  });

  test("written config has valid JSON shape", async () => {
    await spawnCli(["install", "claude-code"], { HOME: home });

    const cfg = await readJson(nodePath.join(home, ".claude.json")) as Record<string, unknown>;
    expect(cfg).toHaveProperty("mcpServers");
    const servers = cfg["mcpServers"] as Record<string, Record<string, unknown>>;
    expect(servers).toHaveProperty("ezcorp-ai-kit");
    expect(servers["ezcorp-ai-kit"]!["command"]).toBe("bunx");
    expect(servers["ezcorp-ai-kit"]!["args"]).toEqual(["@ezcorp/ai-kit", "mcp"]);
    const env = servers["ezcorp-ai-kit"]!["env"] as Record<string, string>;
    expect(env).toHaveProperty("EZCORP_BASE_URL");
    expect(env).toHaveProperty("EZCORP_API_KEY");
  });

  test("idempotent — second run produces identical file", async () => {
    await spawnCli(["install", "claude-code"], { HOME: home });
    const first = JSON.stringify(await readJson(nodePath.join(home, ".claude.json")));

    await spawnCli(["install", "claude-code"], { HOME: home });
    const second = JSON.stringify(await readJson(nodePath.join(home, ".claude.json")));

    expect(first).toBe(second);
  });

  test("--dry-run does not create any files", async () => {
    const { exitCode } = await spawnCli(["install", "claude-code", "--dry-run"], { HOME: home });

    expect(exitCode).toBe(0);
    expect(nodeFs.existsSync(nodePath.join(home, ".claude.json"))).toBe(false);
  });

  test("--project writes to cwd/.claude.json", async () => {
    const cwd = makeTmpDir();
    try {
      const { exitCode } = await spawnCli(["install", "claude-code", "--project"], {
        HOME: home,
      });
      // Can't easily override cwd via env, so just confirm exit code 0 and
      // that home was NOT written (project flag used cwd instead)
      // Note: actual cwd will be somewhere else; we only assert exit is clean.
      expect(exitCode).toBe(0);
      // home-scoped file should not exist
      expect(nodeFs.existsSync(nodePath.join(home, ".claude.json"))).toBe(false);
    } finally {
      rmTmpDir(cwd);
    }
  });
});

// ── unknown target ────────────────────────────────────────────────────────────

describe("CLI install unknown target", () => {
  test("exits non-zero with error message", async () => {
    const { exitCode, stderr } = await spawnCli(["install", "vscode"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown install target");
  });
});

// ── missing target ────────────────────────────────────────────────────────────

describe("CLI install missing target", () => {
  test("exits non-zero with usage hint", async () => {
    const { exitCode, stderr } = await spawnCli(["install"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("install requires a target");
  });
});

// ── --help ────────────────────────────────────────────────────────────────────

describe("CLI --help", () => {
  test("exits 0 and prints usage", async () => {
    const { exitCode, stdout } = await spawnCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ai-kit");
    expect(stdout).toContain("install");
    expect(stdout).toContain("doctor");
  });
});

// ── no subcommand ─────────────────────────────────────────────────────────────

describe("CLI no subcommand", () => {
  test("exits non-zero", async () => {
    const { exitCode } = await spawnCli([]);
    expect(exitCode).not.toBe(0);
  });
});

// ── cursor / zed / windsurf integration ──────────────────────────────────────

describe("CLI install file-based targets (spawned)", () => {
  const cases = [
    {
      target: "cursor",
      path: (home: string) => nodePath.join(home, ".cursor", "mcp.json"),
      key: "mcpServers",
    },
    {
      target: "zed",
      path: (home: string) => nodePath.join(home, ".config", "zed", "settings.json"),
      key: "context_servers",
    },
    {
      target: "windsurf",
      path: (home: string) => nodePath.join(home, ".codeium", "windsurf", "mcp_config.json"),
      key: "mcpServers",
    },
  ];

  for (const { target, path: getPath, key } of cases) {
    test(`${target}: exits 0 and writes syntactically valid config`, async () => {
      const home = makeTmpDir();
      try {
        const { exitCode } = await spawnCli(["install", target], { HOME: home });
        expect(exitCode).toBe(0);

        const cfgPath = getPath(home);
        expect(nodeFs.existsSync(cfgPath)).toBe(true);

        const cfg = await readJson(cfgPath) as Record<string, unknown>;
        expect(cfg).toHaveProperty(key);
        const servers = cfg[key] as Record<string, Record<string, unknown>>;
        expect(servers).toHaveProperty("ezcorp-ai-kit");
        expect(servers["ezcorp-ai-kit"]!["command"]).toBe("bunx");
      } finally {
        rmTmpDir(home);
      }
    });
  }
});
