/**
 * Filesystem discovery of slash-command markdown files.
 *
 * Roots scanned:
 *   project:claude-commands   <root>/.claude/commands/**\/*.md
 *   project:claude-agents     <root>/.claude/agents/**\/*.md
 *   project:codex-prompts     <root>/.codex/prompts/**\/*.md
 *   project:agents            <root>/agents/**\/*.md
 *   user:claude-commands      ~/.claude/commands/**\/*.md
 *   user:claude-agents        ~/.claude/agents/**\/*.md
 *   user:codex-prompts        ~/.codex/prompts/**\/*.md
 *   user:agents               ~/agents/**\/*.md
 *
 * Safety posture: every file is resolved through `realpath` and must stay
 * inside its configured root — symlinks that escape the scope are dropped.
 * Individual files over COMMAND_BODY_MAX_BYTES are skipped, and each scope
 * (= one root) is capped at COMMAND_COUNT_MAX entries to defend discovery
 * against a directory full of adversarial files.
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseCommandFile } from "./parser";
import { EXCLUDED_DIR_NAMES, realpathInsideRoot } from "../fs/scan-fs";

export const COMMAND_BODY_MAX_BYTES = 64 * 1024;
export const COMMAND_COUNT_MAX = 500;

// A `SKILL.md` is the root marker of a Claude skill *bundle*, not a
// loose slash-command. The import wizard's skill-bundle scanner
// (src/runtime/import/skill-bundle.ts) owns these; the command walk
// must never surface one as a command named "SKILL", otherwise an
// imported skill would double-import as a junk command too.
export const SKILL_BUNDLE_FILENAME = "SKILL.md";
// EXCLUDED_DIR_NAMES is now imported from runtime/fs/scan-fs so the
// scanner, the @[file:…] autocomplete, and slash-command discovery all
// share one exclusion list. Adding `dist` or `build` etc. updates every
// call site at once. (Audit defect C11 close-out — pre-existing
// duplication, byte-identical to the shared module's export.)

export type CommandSource =
  | "project:claude-commands"
  | "project:claude-agents"
  | "project:codex-prompts"
  | "project:agents"
  | "user:claude-commands"
  | "user:claude-agents"
  | "user:codex-prompts"
  | "user:agents"
  | "user:db";

export interface CommandRecord {
  /** Stem of the filename, e.g. `review.md` → `review`. */
  name: string;
  /** `source` prefix as a namespace so collisions stay visible. */
  namespace: string;
  /** Frontmatter `description` (may be empty). */
  description: string;
  /** Raw body after frontmatter. */
  body: string;
  /** Parsed frontmatter fields (may be empty). */
  frontmatter: Record<string, string>;
  source: CommandSource;
  /** Absolute path on disk. */
  path: string;
}

const PROJECT_ROOTS: Array<{ rel: string; source: CommandSource }> = [
  { rel: ".claude/commands", source: "project:claude-commands" },
  { rel: ".claude/agents", source: "project:claude-agents" },
  { rel: ".codex/prompts", source: "project:codex-prompts" },
  { rel: "agents", source: "project:agents" },
];

const HOME_ROOTS: Array<{ rel: string; source: CommandSource }> = [
  { rel: ".claude/commands", source: "user:claude-commands" },
  { rel: ".claude/agents", source: "user:claude-agents" },
  { rel: ".codex/prompts", source: "user:codex-prompts" },
  { rel: "agents", source: "user:agents" },
];

// `insideRoot` is now an alias for `realpathInsideRoot` from
// runtime/fs/scan-fs — the previous local implementation was
// byte-identical to the shared one. Retained as a local name so the
// existing call sites below read unchanged. (Audit C11.)
const insideRoot = realpathInsideRoot;

/**
 * Recursively collect `.md` files inside `dir`, constrained to the resolved
 * root `realRoot`. Returns absolute paths (caller parses).
 */
async function collectMarkdown(
  realRoot: string,
  dir: string,
  out: string[],
  remaining: { count: number },
): Promise<void> {
  if (remaining.count <= 0) return;
  if (!(await insideRoot(realRoot, dir))) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (remaining.count <= 0) return;
    if (entry.name.startsWith(".")) continue;
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;

    const abs = join(dir, entry.name);
    if (!(await insideRoot(realRoot, abs))) continue;

    if (entry.isDirectory()) {
      await collectMarkdown(realRoot, abs, out, remaining);
      continue;
    }

    if (!entry.name.endsWith(".md")) continue;
    if (entry.name === SKILL_BUNDLE_FILENAME) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    out.push(abs);
    remaining.count--;
  }
}

async function parseOne(
  absPath: string,
  source: CommandSource,
): Promise<CommandRecord | null> {
  // Enforce size cap *before* reading into memory.
  let size: number;
  try {
    size = (await stat(absPath)).size;
  } catch {
    return null;
  }
  if (size > COMMAND_BODY_MAX_BYTES) return null;

  let raw: string;
  try {
    raw = await Bun.file(absPath).text();
  } catch {
    return null;
  }

  const { frontmatter, body } = parseCommandFile(raw);
  const name = basename(absPath).replace(/\.md$/, "");
  if (name.length === 0) return null;

  return {
    name,
    namespace: source,
    description: frontmatter.description ?? "",
    body,
    frontmatter,
    source,
    path: absPath,
  };
}

async function scanRoot(
  absRootDir: string,
  source: CommandSource,
): Promise<CommandRecord[]> {
  let realRoot: string;
  try {
    realRoot = await realpath(absRootDir);
  } catch {
    return [];
  }

  const paths: string[] = [];
  const remaining = { count: COMMAND_COUNT_MAX };
  await collectMarkdown(realRoot, realRoot, paths, remaining);

  const out: CommandRecord[] = [];
  for (const p of paths) {
    const rec = await parseOne(p, source);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Scan a project directory for commands under its well-known subfolders.
 * Returns merged results across roots, deduplicated only within each
 * source (collisions across sources are preserved and namespaced).
 */
export async function discoverProjectCommands(
  projectPath: string,
): Promise<CommandRecord[]> {
  const out: CommandRecord[] = [];
  for (const { rel, source } of PROJECT_ROOTS) {
    const recs = await scanRoot(join(projectPath, rel), source);
    out.push(...recs);
  }
  return out;
}

/**
 * Scan a user-home directory for commands under well-known coding-agent
 * locations. Caller is responsible for gating this on the deployment's
 * multi-tenancy policy (see `EZCORP_SCAN_GLOBAL_COMMANDS`).
 */
export async function discoverHomeCommands(
  homePath: string,
): Promise<CommandRecord[]> {
  const out: CommandRecord[] = [];
  for (const { rel, source } of HOME_ROOTS) {
    const recs = await scanRoot(join(homePath, rel), source);
    out.push(...recs);
  }
  return out;
}
