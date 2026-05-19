#!/usr/bin/env bun
/**
 * ai-kit CLI entry point.
 * Usage:
 *   ai-kit install <target> [--dry-run] [--project] [--project-path <path>]
 *   ai-kit doctor [--base-url <url>] [--api-key <key>]
 *   ai-kit --help
 */

import { install } from "./install";
import { doctor } from "./doctor";

const USAGE = `
ai-kit — EZCorp integration kit CLI

USAGE
  ai-kit install <target> [options]
  ai-kit doctor [options]
  ai-kit --help

INSTALL TARGETS
  claude-code   Write MCP entry to ~/.claude.json + copy skills to ~/.claude/skills/
  cursor        Write MCP entry to ~/.cursor/mcp.json
  zed           Write MCP entry to ~/.config/zed/settings.json (context_servers)
  windsurf      Write MCP entry to ~/.codeium/windsurf/mcp_config.json
  ezcorp        Symlink package into <project>/.ezcorp/extensions/ + run postinstall

INSTALL OPTIONS
  --dry-run           Print changes without writing
  --project           (claude-code only) Write to ./.claude.json instead of ~/
  --project-path <p>  (ezcorp only) Explicit project root path

DOCTOR OPTIONS
  --base-url <url>    Override EZCORP_BASE_URL
  --api-key <key>     Override EZCORP_API_KEY

ENVIRONMENT
  EZCORP_BASE_URL     Backend URL (default: http://localhost:5173)
  EZCORP_API_KEY      API key for authenticated endpoints
`.trim();

function parseArgs(argv: string[]): {
  subcommand: string | undefined;
  rest: string[];
  flags: Record<string, string | boolean>;
} {
  const args = argv.slice(2); // strip "bun" and script path
  const subcommand = args[0];
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") {
      flags["dry-run"] = true;
    } else if (a === "--project") {
      flags["project"] = true;
    } else if (a === "--project-path" && args[i + 1]) {
      flags["project-path"] = args[++i]!;
    } else if (a === "--base-url" && args[i + 1]) {
      flags["base-url"] = args[++i]!;
    } else if (a === "--api-key" && args[i + 1]) {
      flags["api-key"] = args[++i]!;
    } else if (!a.startsWith("--")) {
      rest.push(a);
    }
  }

  return { subcommand, rest, flags };
}

async function main(): Promise<void> {
  const { subcommand, rest, flags } = parseArgs(process.argv);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(USAGE);
    process.exit(subcommand ? 0 : 1);
  }

  if (subcommand === "install") {
    const target = rest[0];
    if (!target) {
      console.error("Error: install requires a target.\n");
      console.error(USAGE);
      process.exit(1);
    }
    try {
      await install(target, {
        dryRun: flags["dry-run"] === true,
        project: flags["project"] === true,
        projectPath: typeof flags["project-path"] === "string" ? flags["project-path"] : undefined,
      });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  if (subcommand === "doctor") {
    const ok = await doctor({
      baseUrl: typeof flags["base-url"] === "string" ? flags["base-url"] : undefined,
      apiKey: typeof flags["api-key"] === "string" ? flags["api-key"] : undefined,
    });
    process.exit(ok ? 0 : 1);
    return;
  }

  console.error(`Error: unknown subcommand "${subcommand}".\n`);
  console.error(USAGE);
  process.exit(1);
}

main();
