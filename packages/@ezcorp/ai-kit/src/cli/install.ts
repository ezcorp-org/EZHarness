/**
 * `ai-kit install <target>` — writes harness-appropriate MCP config and copies
 * skills into place. All operations are idempotent and respect --dry-run.
 */

import * as nodePath from "node:path";
import * as nodeFs from "node:fs";

export type InstallTarget = "claude-code" | "cursor" | "zed" | "windsurf" | "ezcorp";

export interface InstallOptions {
  /** Override $HOME for testability. */
  home?: string;
  /** cwd to use when looking for project roots (ezcorp target). */
  cwd?: string;
  /** If true, print diffs without writing anything. */
  dryRun?: boolean;
  /** For claude-code: write to project-scope .claude.json instead of user scope. */
  project?: boolean;
  /** For ezcorp target: explicit project root path. */
  projectPath?: string;
}

// ── shared MCP entry ──────────────────────────────────────────────────────────

function mcpEntry() {
  return {
    command: "bunx",
    args: ["@ezcorp/ai-kit", "mcp"],
    env: {
      EZCORP_BASE_URL: process.env.EZCORP_BASE_URL ?? "http://localhost:5173",
      EZCORP_API_KEY: process.env.EZCORP_API_KEY ?? "<your-api-key>",
    },
  };
}

// ── JSON merge helpers ────────────────────────────────────────────────────────

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const text = await Bun.file(filePath).text();
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeJsonFile(
  filePath: string,
  data: unknown,
  dryRun: boolean,
): Promise<void> {
  const text = JSON.stringify(data, null, 2) + "\n";
  if (dryRun) {
    console.log(`[dry-run] Would write ${filePath}:\n${text}`);
    return;
  }
  // Ensure parent directory exists
  const dir = nodePath.dirname(filePath);
  nodeFs.mkdirSync(dir, { recursive: true });
  await Bun.write(filePath, text);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof target[k] === "object" &&
      target[k] !== null &&
      !Array.isArray(target[k])
    ) {
      result[k] = deepMerge(
        target[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ── skills copy helper ────────────────────────────────────────────────────────

async function copySkills(destBase: string, dryRun: boolean): Promise<void> {
  // Locate the skills directory relative to this file's package root.
  // The package root is two levels up from src/cli/.
  const pkgRoot = nodePath.resolve(nodePath.dirname(Bun.main), "..", "..");
  const skillsSrc = nodePath.join(pkgRoot, "skills");

  if (!nodeFs.existsSync(skillsSrc)) {
    // skills dir might not exist in some test environments — skip silently
    return;
  }

  const entries = nodeFs.readdirSync(skillsSrc);
  for (const entry of entries) {
    if (!entry.startsWith("ezcorp-")) continue;
    const srcDir = nodePath.join(skillsSrc, entry);
    const destDir = nodePath.join(destBase, entry);
    if (!nodeFs.statSync(srcDir).isDirectory()) continue;

    const files = nodeFs.readdirSync(srcDir);
    for (const file of files) {
      const srcFile = nodePath.join(srcDir, file);
      const destFile = nodePath.join(destDir, file);
      if (dryRun) {
        console.log(`[dry-run] Would copy ${srcFile} -> ${destFile}`);
      } else {
        nodeFs.mkdirSync(destDir, { recursive: true });
        await Bun.write(destFile, Bun.file(srcFile));
      }
    }
  }
}

// ── walk up for project root ──────────────────────────────────────────────────

function findProjectRoot(startDir: string): string | null {
  let dir = nodePath.resolve(startDir);
  for (let i = 0; i < 20; i++) {
    if (nodeFs.existsSync(nodePath.join(dir, ".git"))) return dir;
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── targets ───────────────────────────────────────────────────────────────────

async function installClaudeCode(opts: Required<Pick<InstallOptions, "home" | "dryRun">> & { project?: boolean; cwd?: string }): Promise<void> {
  const entry = mcpEntry();

  if (opts.project) {
    // Project-scope: write .claude.json in cwd
    const configPath = nodePath.join(opts.cwd ?? process.cwd(), ".claude.json");
    const existing = await readJsonFile(configPath);
    const merged = deepMerge(existing, {
      mcpServers: {
        "ezcorp-ai-kit": entry,
      },
    });
    await writeJsonFile(configPath, merged, opts.dryRun);

    // Copy skills to .claude/skills/ in cwd
    const skillsDest = nodePath.join(opts.cwd ?? process.cwd(), ".claude", "skills");
    await copySkills(skillsDest, opts.dryRun);
  } else {
    // User scope: write ~/.claude.json
    const configPath = nodePath.join(opts.home, ".claude.json");
    const existing = await readJsonFile(configPath);
    const merged = deepMerge(existing, {
      mcpServers: {
        "ezcorp-ai-kit": entry,
      },
    });
    await writeJsonFile(configPath, merged, opts.dryRun);

    // Copy skills to ~/.claude/skills/
    const skillsDest = nodePath.join(opts.home, ".claude", "skills");
    await copySkills(skillsDest, opts.dryRun);
  }
  console.log("Installed: claude-code MCP config written.");
}

async function installCursor(opts: Required<Pick<InstallOptions, "home" | "dryRun">>): Promise<void> {
  const configPath = nodePath.join(opts.home, ".cursor", "mcp.json");
  const existing = await readJsonFile(configPath);
  const merged = deepMerge(existing, {
    mcpServers: {
      "ezcorp-ai-kit": mcpEntry(),
    },
  });
  await writeJsonFile(configPath, merged, opts.dryRun);
  console.log("Installed: cursor MCP config written.");
}

async function installZed(opts: Required<Pick<InstallOptions, "home" | "dryRun">>): Promise<void> {
  const configPath = nodePath.join(opts.home, ".config", "zed", "settings.json");
  const existing = await readJsonFile(configPath);
  const merged = deepMerge(existing, {
    context_servers: {
      "ezcorp-ai-kit": mcpEntry(),
    },
  });
  await writeJsonFile(configPath, merged, opts.dryRun);
  console.log("Installed: zed context_servers config written.");
}

async function installWindsurf(opts: Required<Pick<InstallOptions, "home" | "dryRun">>): Promise<void> {
  const configPath = nodePath.join(opts.home, ".codeium", "windsurf", "mcp_config.json");
  const existing = await readJsonFile(configPath);
  const merged = deepMerge(existing, {
    mcpServers: {
      "ezcorp-ai-kit": mcpEntry(),
    },
  });
  await writeJsonFile(configPath, merged, opts.dryRun);
  console.log("Installed: windsurf MCP config written.");
}

async function installEzcorp(opts: Required<Pick<InstallOptions, "home" | "dryRun" | "cwd">> & { projectPath?: string }): Promise<void> {
  const root = opts.projectPath ?? findProjectRoot(opts.cwd);
  if (!root) {
    throw new Error(
      "Could not find a project root (no .git directory found). Pass --project <path>.",
    );
  }

  const extensionsDir = nodePath.join(root, ".ezcorp", "extensions");
  const linkTarget = nodePath.join(extensionsDir, "ai-kit");

  // Locate this package's root
  const pkgRoot = nodePath.resolve(nodePath.dirname(Bun.main), "..", "..");

  if (opts.dryRun) {
    console.log(`[dry-run] Would create symlink: ${linkTarget} -> ${pkgRoot}`);
    console.log(`[dry-run] Would run: bun ${nodePath.join(pkgRoot, "scripts", "postinstall.ts")}`);
    return;
  }

  nodeFs.mkdirSync(extensionsDir, { recursive: true });

  // Remove existing symlink/dir if present (idempotent)
  if (nodeFs.existsSync(linkTarget)) {
    const stat = nodeFs.lstatSync(linkTarget);
    if (stat.isSymbolicLink()) {
      nodeFs.unlinkSync(linkTarget);
    }
  }
  nodeFs.symlinkSync(pkgRoot, linkTarget);

  // Run postinstall hook if it exists
  const postinstall = nodePath.join(pkgRoot, "scripts", "postinstall.ts");
  if (nodeFs.existsSync(postinstall)) {
    const proc = Bun.spawn(["bun", postinstall], {
      cwd: root,
      env: { ...process.env },
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }

  console.log(`Installed: ezcorp extension symlinked at ${linkTarget}`);
}

// ── main export ───────────────────────────────────────────────────────────────

export async function install(
  target: string,
  opts: InstallOptions = {},
): Promise<void> {
  const home = opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const cwd = opts.cwd ?? process.cwd();
  const dryRun = opts.dryRun ?? false;

  switch (target as InstallTarget) {
    case "claude-code":
      await installClaudeCode({ home, dryRun, project: opts.project, cwd });
      break;
    case "cursor":
      await installCursor({ home, dryRun });
      break;
    case "zed":
      await installZed({ home, dryRun });
      break;
    case "windsurf":
      await installWindsurf({ home, dryRun });
      break;
    case "ezcorp":
      await installEzcorp({ home, dryRun, cwd, projectPath: opts.projectPath });
      break;
    default:
      throw new Error(
        `Unknown install target: "${target}". Valid targets: claude-code, cursor, zed, windsurf, ezcorp`,
      );
  }
}
