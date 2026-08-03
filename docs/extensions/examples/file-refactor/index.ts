#!/usr/bin/env bun
// file-refactor - Preview file renames to match a naming convention

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";
import { fsList, fsStat } from "@ezcorp/sdk/runtime";
import { resolve, normalize, basename, dirname, join, extname } from "node:path";

const cwd = process.cwd();

function isUnderCwd(filePath: string): boolean {
  const resolved = resolve(cwd, normalize(filePath));
  return resolved.startsWith(cwd + "/") || resolved === cwd;
}

function errorResponse(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function successResponse(id: number | string, text: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } };
}

// Naming convention converters
function toCamelCase(name: string): string {
  return name
    .replace(/[-_]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toLowerCase());
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

function toPascalCase(name: string): string {
  return name
    .replace(/[-_]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toUpperCase());
}

function convertName(name: string, convention: string): string {
  const ext = extname(name);
  const base = basename(name, ext);
  let converted: string;
  switch (convention) {
    case "camelCase": converted = toCamelCase(base); break;
    case "snake_case": converted = toSnakeCase(base); break;
    case "kebab-case": converted = toKebabCase(base); break;
    case "PascalCase": converted = toPascalCase(base); break;
    default: converted = base;
  }
  return converted + ext;
}

function matchesGlob(filePath: string, pattern: string): boolean {
  return filePath.includes(pattern) || basename(filePath) === pattern;
}

/** Directories the walk NEVER descends into, at any depth. Build/VCS
 *  artifacts plus `.ezcorp` — the platform's own state directory, whose
 *  `data` / `backups` children the host reserves and hard-denies
 *  regardless of the `$CWD` grant (`src/extensions/permissions.ts`). */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".ezcorp",
]);

/** Directories skipped ONLY when they sit directly under the walk root.
 *  In the shipped Docker image the PGlite datadir is `<root>/data/ezcorp`
 *  and its snapshot sibling `<root>/data/backups` (Dockerfile:
 *  `EZCORP_DB_PATH=/app/data/ezcorp`, project root `/app`), both
 *  host-reserved. Root-anchored on purpose: a nested `src/data/` is
 *  ordinary source a rename preview must still see. */
export const SKIP_ROOT_DIRS: ReadonlySet<string> = new Set(["data"]);

/**
 * Walk `dir`, collecting files. `root` anchors {@link SKIP_ROOT_DIRS}
 * and the relative paths pushed onto `skipped`.
 *
 * A directory the host refuses to list is REPORTED, not thrown. The host
 * denies its own reserved DB/secret dir to every extension — including
 * one holding a legitimate whole-project `$CWD` grant — so a walk that
 * let the rejection escape turned the platform protecting itself into a
 * hard `rename-files` failure. A vanished-mid-walk directory takes the
 * same path.
 */
async function collectFiles(
  dir: string,
  excludes: string[],
  root: string,
  skipped: string[],
): Promise<string[]> {
  const results: string[] = [];
  let entries: Awaited<ReturnType<typeof fsList>>;
  try {
    entries = await fsList(dir);
  } catch {
    skipped.push(dir === root ? "." : dir.slice(root.length + 1));
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (excludes.some((p) => matchesGlob(fullPath, p))) continue;
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (dir === root && SKIP_ROOT_DIRS.has(entry.name)) continue;
      results.push(...(await collectFiles(fullPath, excludes, root, skipped)));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

async function handleRenameFiles(
  id: number | string,
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const sourcePath = args.sourcePath as string;
  if (!sourcePath) return errorResponse(id, -32602, "Missing required argument: sourcePath");
  if (!isUnderCwd(sourcePath)) return errorResponse(id, -32000, "Path is outside project directory");

  const convention = args.convention as string;
  if (!convention) return errorResponse(id, -32602, "Missing required argument: convention");

  const excludePatterns = (args.excludePatterns as string[]) ?? [];
  const resolved = resolve(cwd, normalize(sourcePath));

  const skipped: string[] = [];
  try {
    const info = await fsStat(resolved);
    const files = info.isDirectory
      ? await collectFiles(resolved, excludePatterns, resolved, skipped)
      : [resolved];

    const renames: { from: string; to: string }[] = [];
    for (const file of files) {
      const name = basename(file);
      const converted = convertName(name, convention);
      if (converted !== name) {
        const rel = file.slice(cwd.length + 1);
        renames.push({ from: rel, to: join(dirname(rel), converted) });
      }
    }

    // Surfaced so an unreadable subtree is visible in the preview rather
    // than silently narrowing the result set.
    const skipNote =
      skipped.length > 0
        ? `\n\nSkipped ${skipped.length} unreadable director${skipped.length === 1 ? "y" : "ies"}: ${skipped.join(", ")}`
        : "";

    if (renames.length === 0) {
      return successResponse(
        id,
        `All ${files.length} file(s) already match ${convention} convention.${skipNote}`,
      );
    }

    const lines = renames.map((r) => `  ${r.from} -> ${r.to}`);
    return successResponse(
      id,
      `Found ${renames.length} file(s) to rename (out of ${files.length}):\n${lines.join("\n")}\n\n(Preview only — no files were renamed)${skipNote}`,
    );
  } catch (err) {
    return errorResponse(id, -32000, `Failed: ${(err as Error).message}`);
  }
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (req.method === "tools/call") {
    const toolName = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};
    switch (toolName) {
      case "rename-files": return handleRenameFiles(req.id, args);
      default: return errorResponse(req.id, -32601, `Unknown tool: ${toolName}`);
    }
  }
  return errorResponse(req.id, -32601, `Unknown method: ${req.method}`);
}

// --- Production wiring ---
//
// `Bun.stdin.stream().getReader()` moved INSIDE `main()` and the call is
// gated on `import.meta.main`: at module scope both opened stdin the
// moment anything imported this file, so `index.test.ts` could not load
// it without hanging on a read that never resolves. Same shape as
// todo-tracker (`export function start()` + `if (import.meta.main)`).
export async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const req: JsonRpcRequest = JSON.parse(line);
        const res = await handleRequest(req);
        process.stdout.write(JSON.stringify(res) + "\n");
      } catch { /* ignore malformed */ }
    }
  }
}

/** Exported for `index.test.ts` — the dispatch + walk surface, driven
 *  directly with a stubbed host channel. Mirrors claude-design's
 *  `_internals` convention. */
export const _internals = {
  handleRequest,
  handleRenameFiles,
  collectFiles,
  convertName,
  matchesGlob,
  isUnderCwd,
  cwd,
};

if (import.meta.main) void main();
