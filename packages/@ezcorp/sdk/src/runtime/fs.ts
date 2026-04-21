// ── Filesystem helpers ──────────────────────────────────────────
//
// Bun-only (no `node:fs/promises` async API — sync primitives only).
// Pattern matches the inline helpers previously duplicated across every
// example extension (auto-note, task-stack, etc.).

import { dirname, join } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

/**
 * Walk up from `from` (default `process.cwd()`) looking for a `.git`
 * directory. Returns the first containing project root. Throws if none is
 * found (i.e. the search hit the filesystem root without ever seeing .git).
 *
 * Matches the pattern that has been duplicated in several extension `lib/`
 * files. Having a single canonical implementation means `.ezcorp/` always
 * lands at the same place regardless of where the extension is invoked
 * from.
 */
export function findProjectRoot(from: string = process.cwd()): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`findProjectRoot: no .git ancestor found starting from ${from}`);
    }
    dir = parent;
  }
}

/**
 * Returns the canonical data directory for an extension:
 *   `<projectRoot>/.ezcorp/extension-data/<extensionName>`
 * Creates it (and all parents) if missing. See `docs/extensions/data-storage.md`.
 */
export function getExtensionDataDir(
  extensionName: string,
  opts?: { projectRoot?: string },
): string {
  const root = opts?.projectRoot ?? findProjectRoot();
  const dir = join(root, ".ezcorp", "extension-data", extensionName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Atomic write: write to a sibling tmp file first, then rename over the
 * target. Ensures readers never see a half-written file. Parent directory
 * is created if missing.
 */
export async function atomicWrite(
  absPath: string,
  content: string | Uint8Array,
): Promise<void> {
  mkdirSync(dirname(absPath), { recursive: true });
  // randomBytes-ish suffix avoids collision when two concurrent writes to
  // the same path race — renameSync is atomic per-file so the "last writer
  // wins" semantics are preserved.
  const rand = Math.random().toString(36).slice(2, 10);
  const tmp = `${absPath}.tmp-${rand}`;
  await Bun.write(tmp, content);
  renameSync(tmp, absPath);
}

/**
 * Returns the file content as a string, or `null` if the file does not
 * exist. Other filesystem errors (EACCES, EISDIR, etc.) are rethrown —
 * callers should not silently swallow unexpected failures.
 */
export async function atomicRead(absPath: string): Promise<string | null> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) return null;
  return await file.text();
}

/**
 * Read + JSON-parse a file. Returns `fallback` if:
 *   - the file does not exist, or
 *   - parsing fails (parse error is logged to stderr).
 */
export async function loadJSON<T>(absPath: string, fallback: T): Promise<T> {
  const text = await atomicRead(absPath);
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[@ezcorp/sdk] loadJSON: parse error in ${absPath}: ${msg}\n`);
    return fallback;
  }
}

/** JSON.stringify with 2-space indent, written atomically. */
export async function saveJSON(absPath: string, data: unknown): Promise<void> {
  await atomicWrite(absPath, JSON.stringify(data, null, 2));
}
