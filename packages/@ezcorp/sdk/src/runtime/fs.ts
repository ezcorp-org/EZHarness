// ── Filesystem helpers ──────────────────────────────────────────
//
// Two surfaces live in this module:
//
//   1. Local helpers (Bun-only): `findProjectRoot`, `getExtensionDataDir`,
//      `atomicWrite`, `atomicRead`, `loadJSON`, `saveJSON`. These predate
//      Phase 3 and use Bun.file / Bun.write / `node:fs` sync primitives.
//      They run on the HOST side (web/server, install scripts, codegen) —
//      NOT inside the extension subprocess. Inside a subprocess these
//      primitives are poisoned by the sandbox-preload (Phase 3); calling
//      them throws a clean error pointing here.
//
//   2. Phase 3 host-mediated helpers: `fsRead`, `fsWrite`, `fsList`,
//      `fsStat`, `fsExists`, `fsMkdir`, `fsUnlink`. These call the host's
//      `ezcorp/fs.{read,write,list,stat,exists,mkdir,unlink}` reverse-RPC
//      via the channel, so they work INSIDE a subprocess and are the
//      ONLY supported path for fs IO from extension code.
//
// Calling site selection:
//   - Inside an extension subprocess → use the Phase 3 helpers below.
//   - Outside (host bootstrap, build scripts) → use the Bun-only helpers
//     above.

import { dirname, join } from "node:path";

import { getChannel, JsonRpcError } from "./channel";
import { getToolContext } from "./tool-context";

// `node:fs` is lazy-loaded (not statically imported) because Phase 3
// sandbox-preload blocks `require("fs")` to harden the extension
// subprocess. A static import here would fire at SDK module-load time
// — even for subprocess code that only calls Phase-3 host-mediated
// helpers (`fsRead`/`fsWrite`/...) and never touches the legacy
// host-side helpers below. Lazy-loading keeps the legacy helpers
// usable on the HOST (where the require-block isn't installed) while
// avoiding the subprocess crash. See sandbox-preload.ts FS_MODULES.
function loadFsSync(): typeof import("node:fs") {
  // Resolved fresh each call — the cost is negligible compared to the
  // syscall, and avoiding a module-scope cache means we never hold a
  // poisoned-fs reference if the host ever rebinds the module.
  return require("node:fs") as typeof import("node:fs");
}

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
  const fs = loadFsSync();
  let dir = from;
  while (true) {
    if (fs.existsSync(join(dir, ".git"))) return dir;
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
  loadFsSync().mkdirSync(dir, { recursive: true });
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
  const fs = loadFsSync();
  fs.mkdirSync(dirname(absPath), { recursive: true });
  // randomBytes-ish suffix avoids collision when two concurrent writes to
  // the same path race — renameSync is atomic per-file so the "last writer
  // wins" semantics are preserved.
  const rand = Math.random().toString(36).slice(2, 10);
  const tmp = `${absPath}.tmp-${rand}`;
  await Bun.write(tmp, content);
  fs.renameSync(tmp, absPath);
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

// ════════════════════════════════════════════════════════════════════
// Phase 3: host-mediated fs helpers
// ════════════════════════════════════════════════════════════════════
//
// These helpers wrap the `ezcorp/fs.{read,write,list,stat,exists,mkdir,
// unlink}` reverse-RPC. They MUST be used inside extension subprocess
// code — raw `Bun.file` / `Bun.write` / `node:fs` are poisoned by the
// sandbox-preload.
//
// Pre-flight: when `EZCORP_FS_ALLOWED` is missing from the subprocess
// env, the host did NOT grant any filesystem access; the helpers
// fail-fast with a clear error before round-tripping to the host.
// The flag is informational — the sandbox-preload deniers fire
// regardless of it; this short-circuit just spares a JSON-RPC round
// trip for extensions with no grant at all.

// 5 minutes: image-gen and similar slow tools can leave the host event
// loop busy when the fs round-trip fires, so the cap needs headroom over
// the actual fs op (mkdir/write are themselves near-instant).
const FS_TIMEOUT_MS = 300_000;
/** Streaming reads can be slow on large files; allow more headroom. */
const FS_READ_TIMEOUT_MS = 300_000;
/**
 * Mirror of host's `MAX_BYTES_PER_OP` — kept in sync manually. The
 * client-side guard (N1) prevents 100MB+ Uint8Array → base64 inflation
 * from running before the host's same-cap rejection round-trips.
 */
const FS_MAX_BYTES_PER_OP = 100 * 1024 * 1024;

function ensureFsAllowed(opName: string): void {
  if (process.env.EZCORP_FS_ALLOWED !== "1") {
    throw new Error(
      `[@ezcorp/sdk] ${opName} unavailable: extension has no filesystem grant. ` +
        "Declare `permissions.filesystem` in your manifest and ask the user to " +
        "grant the path at install time.",
    );
  }
}

/**
 * Pull the active tool name from the SDK's ALS (set by the
 * `tools/call` dispatcher in channel.ts via `withToolContext`). Used
 * to forward `_toolName` on every fs RPC so the host can apply
 * per-tool `capabilities.filesystem.mode` narrowing (M5).
 *
 * Returns an empty object when no tool context is active (extension
 * boot, raw RPC) — the spread leaves the wire params untouched. The
 * host treats absent `_toolName` as "no narrowing, extension-wide
 * grant applies".
 */
function activeToolNameField(): { _toolName?: string } {
  const t = getToolContext()?.toolName;
  return t === undefined ? {} : { _toolName: t };
}

/**
 * Read a file via host-mediated `ezcorp/fs.read`. The host realpaths
 * the path BEFORE PDP authorize so symlink swaps can't escape the
 * grant (TOCTOU mitigation).
 *
 * @param path  Absolute path inside the extension's filesystem grant.
 * @param opts  `encoding`: "utf-8" (default) returns a string; "binary"
 *              returns a Uint8Array.
 * @returns     Either a string (utf-8) or Uint8Array (binary).
 *
 * Errors surface as `Error` with the host's message. Streaming
 * reads (>1MB) are reassembled by the channel before this resolves.
 */
export async function fsRead(
  path: string,
  opts?: { encoding?: "utf-8" | "binary" },
): Promise<string | Uint8Array> {
  ensureFsAllowed("fsRead");
  const encoding = opts?.encoding ?? "utf-8";
  type ReadResult = { encoding: "utf-8" | "binary"; body: string; bytes: number; resolvedPath: string };
  const result = await getChannel().request<ReadResult>(
    "ezcorp/fs.read",
    { path, encoding, ...activeToolNameField() },
    FS_READ_TIMEOUT_MS,
  );
  const decoded = Uint8Array.from(atob(result.body), (c) => c.charCodeAt(0));
  if (encoding === "binary") return decoded;
  return new TextDecoder().decode(decoded);
}

/**
 * Write a file via host-mediated `ezcorp/fs.write`. Content is
 * base64-encoded on the wire when `encoding: "binary"` is passed.
 *
 * @param path     Absolute path inside the extension's filesystem grant.
 * @param content  string (utf-8) or Uint8Array (binary).
 * @returns        bytes written, host-resolved canonical path.
 */
export async function fsWrite(
  path: string,
  content: string | Uint8Array,
): Promise<{ bytes: number; resolvedPath: string }> {
  ensureFsAllowed("fsWrite");
  const isBinary = content instanceof Uint8Array;
  // N1: pre-base64 size guard. The host enforces the same 100MB
  // ceiling, but inflating a 100MB+ Uint8Array to base64 client-side
  // first allocates ~133MB of string before failing — a real OOM
  // risk on memory-constrained extensions. Check raw byte length up
  // front so we throw before the allocation.
  const rawBytes = isBinary
    ? content.byteLength
    : new TextEncoder().encode(content as string).byteLength;
  if (rawBytes > FS_MAX_BYTES_PER_OP) {
    throw new Error(
      `[@ezcorp/sdk] fsWrite content exceeds ${FS_MAX_BYTES_PER_OP / (1024 * 1024)}MB limit (${rawBytes} bytes)`,
    );
  }
  // Base64-encode binary payloads without spreading every byte as a
  // function argument. The previous form (`String.fromCharCode.apply
  // (null, Array.from(content))`) crashed with `Maximum call stack
  // size exceeded` for any payload beyond ~65k bytes — every JS engine
  // caps positional arguments at roughly that count. Real images
  // (1024×1024 PNG ≈ 0.5–2 MB) tripped this on the first write. Buffer
  // is global in Bun (the extension subprocess runtime) and does the
  // encode in O(n) without the argument-spread.
  const wireContent = isBinary
    ? Buffer.from(content as Uint8Array).toString("base64")
    : (content as string);
  const params: Record<string, unknown> = {
    path,
    content: wireContent,
    encoding: isBinary ? "binary" : "utf-8",
    ...activeToolNameField(),
  };
  return getChannel().request<{ bytes: number; resolvedPath: string }>(
    "ezcorp/fs.write",
    params,
    FS_TIMEOUT_MS,
  );
}

export interface FsListEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * List directory entries via host-mediated `ezcorp/fs.list`. Entry
 * shape mirrors `node:fs.Dirent.{name, isFile(), isDirectory()}`.
 */
export async function fsList(path: string): Promise<FsListEntry[]> {
  ensureFsAllowed("fsList");
  const result = await getChannel().request<{ entries: FsListEntry[] }>(
    "ezcorp/fs.list",
    { path, ...activeToolNameField() },
    FS_TIMEOUT_MS,
  );
  return result.entries;
}

export interface FsStatResult {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  resolvedPath: string;
}

/** Stat via host-mediated `ezcorp/fs.stat`. */
export async function fsStat(path: string): Promise<FsStatResult> {
  ensureFsAllowed("fsStat");
  return getChannel().request<FsStatResult>(
    "ezcorp/fs.stat",
    { path, ...activeToolNameField() },
    FS_TIMEOUT_MS,
  );
}

/**
 * Existence check via host-mediated `ezcorp/fs.exists`. Returns false
 * for non-existent paths inside the grant; throws for paths outside.
 * (Existence-of-out-of-grant is a permission deny, not a leak — see
 * the host fs-handler test matrix.)
 */
export async function fsExists(path: string): Promise<boolean> {
  ensureFsAllowed("fsExists");
  const result = await getChannel().request<{ exists: boolean }>(
    "ezcorp/fs.exists",
    { path, ...activeToolNameField() },
    FS_TIMEOUT_MS,
  );
  return result.exists;
}

/**
 * Mkdir via host-mediated `ezcorp/fs.mkdir`. `recursive: true` makes
 * intermediate directories AND is idempotent on existing paths;
 * `recursive: false` (default) errors with EEXIST if the path exists.
 */
export async function fsMkdir(
  path: string,
  opts?: { recursive?: boolean },
): Promise<{ resolvedPath: string }> {
  ensureFsAllowed("fsMkdir");
  return getChannel().request<{ resolvedPath: string }>(
    "ezcorp/fs.mkdir",
    { path, recursive: opts?.recursive === true, ...activeToolNameField() },
    FS_TIMEOUT_MS,
  );
}

/**
 * Unlink via host-mediated `ezcorp/fs.unlink`.
 *
 * POSIX-correct symlink semantics (M1): the host operates on the
 * LINK, not the target. Calling `fsUnlink("/grant/link")` where
 * `link → /etc/critical` removes the link and leaves the target
 * intact, matching `unlink(2)` semantics.
 */
export async function fsUnlink(path: string): Promise<{ resolvedPath: string }> {
  ensureFsAllowed("fsUnlink");
  return getChannel().request<{ resolvedPath: string }>(
    "ezcorp/fs.unlink",
    { path, ...activeToolNameField() },
    FS_TIMEOUT_MS,
  );
}

// Re-export JsonRpcError so tests + callers can branch on host error
// codes without importing channel.ts directly.
export { JsonRpcError };
