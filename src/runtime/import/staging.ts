/**
 * Import-wizard upload staging.
 *
 * The wizard accepts either a directory-picker upload (many parts +
 * parallel `webkitRelativePath` strings) or a single archive
 * (`.zip` / `.tar.gz` / `.tgz`). Both are materialised into a
 * short-lived per-session directory under
 *
 *   <projectRoot>/.ezcorp/import-staging/<sessionId>/
 *
 * which is gitignored (the whole `.ezcorp/` tree is) and always
 * `rm -rf`'d by the caller in a `finally`. Everything written here is
 * untrusted user input, so the module is defensive about path
 * traversal / zip-slip / escaping symlinks: every reconstructed or
 * extracted path is confined to the session dir via the same
 * `realpathInsideRoot` helper the command scanner uses.
 *
 * Per-file cap note: this is intentionally *larger* than the 64 KB
 * command-body cap. Command markdown is independently re-capped at
 * 64 KB by the scanner (`discovery.ts` `COMMAND_BODY_MAX_BYTES`);
 * staging also carries skill-bundle scripts/assets, which legitimately
 * exceed 64 KB, so a 64 KB staging cap would break the skill slice.
 *
 * Caps are parameterised (`Limits`) so callers — and tests — can pin
 * them; production omits the arg and gets `DEFAULT_LIMITS`.
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { realpathInsideRoot } from "../fs/scan-fs";

export const IMPORT_STAGING_DIRNAME = "import-staging";

/** Whole-upload byte ceiling (sum of all files / archive size). */
export const MAX_TOTAL_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Per-file byte ceiling. Generous — skill scripts/assets, not command bodies. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Hard cap on the number of files in one import. */
export const MAX_FILE_COUNT = 3000;

export interface Limits {
  maxFileBytes: number;
  maxFileCount: number;
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxFileCount: MAX_FILE_COUNT,
  maxTotalBytes: MAX_TOTAL_UPLOAD_BYTES,
};

/** Session ids are UUIDs — anything else is a traversal attempt. */
export const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Top-level dirs that mark "this is the config root, stop descending". */
const SCAN_ROOT_MARKERS: ReadonlySet<string> = new Set([
  ".claude",
  ".codex",
  "agents",
]);

const TAR_EXTS = [".tar.gz", ".tgz"];
const ZIP_EXT = ".zip";

export interface StagedUpload {
  sessionId: string;
  /** Absolute path of the per-session staging dir (extracted tree root). */
  dir: string;
  fileCount: number;
  totalBytes: number;
}

export class StagingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "StagingError";
    this.status = status;
    this.code = code;
  }
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

/** Recursive `rm -rf` that never throws — used in cleanup / `finally`. */
export async function bestEffortRm(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true }).catch(() => {});
}

/** Path-only (no IO). The `.ezcorp/import-staging` parent of one session. */
function stagingParent(projectRoot: string): string {
  return resolve(projectRoot, ".ezcorp", IMPORT_STAGING_DIRNAME);
}

/** Path-only (no IO). The per-session dir. Validates the session id. */
export function stagingDirFor(projectRoot: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new StagingError(400, "BAD_SESSION", "Invalid import session id");
  }
  return join(stagingParent(projectRoot), sessionId);
}

/**
 * Re-resolve a staging dir for the commit step. Returns the absolute
 * dir only if the (validated) session dir exists, is a directory, and
 * its realpath is confined under `<projectRoot>/.ezcorp/import-staging`.
 * Anything else → `null` ("session expired/unknown" to the caller).
 */
export async function resolveStagingDir(
  projectRoot: string,
  sessionId: string,
): Promise<string | null> {
  let dir: string;
  try {
    dir = stagingDirFor(projectRoot, sessionId);
  } catch {
    return null;
  }
  let realParent: string;
  try {
    realParent = await realpath(stagingParent(projectRoot));
  } catch {
    return null;
  }
  if (!(await realpathInsideRoot(realParent, dir))) return null;
  let isDir = false;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch {
    return null;
  }
  return isDir ? dir : null;
}

/** `rm -rf` the session dir. Swallows errors. Validates the id first. */
export async function cleanupStagingDir(
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  let dir: string;
  try {
    dir = stagingDirFor(projectRoot, sessionId);
  } catch {
    return;
  }
  await bestEffortRm(dir);
}

/**
 * Best-effort sweep of stale per-session dirs under the staging
 * parent (a preview that was never committed leaves its dir behind).
 * Removes session dirs whose mtime is older than `maxAgeMs`. Never
 * throws — called opportunistically at the top of `preview`.
 */
export async function sweepStaleStaging(
  projectRoot: string,
  maxAgeMs: number,
): Promise<number> {
  const parent = stagingParent(projectRoot);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !SESSION_ID_RE.test(e.name)) continue;
    const dir = join(parent, e.name);
    let mtime: number;
    try {
      mtime = (await stat(dir)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoff) {
      await bestEffortRm(dir);
      removed++;
    }
  }
  return removed;
}

/** Split + harden one client-supplied relative path. Throws on traversal. */
export function sanitizeRelPath(rel: string): string[] {
  const norm = rel.replace(/\\/g, "/");
  if (norm.length === 0) {
    throw new StagingError(400, "BAD_PATH", "Empty upload path");
  }
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) {
    throw new StagingError(400, "BAD_PATH", `Absolute upload path rejected: ${rel}`);
  }
  const segs: string[] = [];
  for (const raw of norm.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === ".." || raw.includes("\0")) {
      throw new StagingError(400, "BAD_PATH", `Unsafe upload path rejected: ${rel}`);
    }
    segs.push(raw);
  }
  if (segs.length === 0) {
    throw new StagingError(400, "BAD_PATH", `Upload path resolved to nothing: ${rel}`);
  }
  return segs;
}

async function mkSessionDir(
  projectRoot: string,
): Promise<{ sessionId: string; dir: string }> {
  const sessionId = newSessionId();
  const dir = stagingDirFor(projectRoot, sessionId);
  await mkdir(dir, { recursive: true });
  return { sessionId, dir };
}

/**
 * Materialise a directory-picker upload. `files[i]` is paired with
 * `paths[i]` (the browser's `webkitRelativePath`). Enforces the
 * count / per-file / total caps and confines every write to `dir`.
 */
export async function stageDirectoryUpload(opts: {
  projectRoot: string;
  files: File[];
  paths: string[];
  limits?: Limits;
}): Promise<StagedUpload> {
  const { projectRoot, files, paths } = opts;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  if (files.length !== paths.length) {
    throw new StagingError(400, "BAD_UPLOAD", "files/paths length mismatch");
  }
  if (files.length === 0) {
    throw new StagingError(400, "EMPTY_UPLOAD", "No files in upload");
  }
  if (files.length > limits.maxFileCount) {
    throw new StagingError(413, "TOO_MANY_FILES", `Too many files (max ${limits.maxFileCount})`);
  }

  const { sessionId, dir } = await mkSessionDir(projectRoot);
  let totalBytes = 0;
  let fileCount = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    if (file.size > limits.maxFileBytes) {
      throw new StagingError(413, "FILE_TOO_LARGE", `"${paths[i]}" exceeds ${limits.maxFileBytes} bytes`);
    }
    totalBytes += file.size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new StagingError(413, "UPLOAD_TOO_LARGE", `Upload exceeds ${limits.maxTotalBytes} bytes`);
    }
    const segs = sanitizeRelPath(paths[i]!);
    const target = join(dir, ...segs);
    const resolved = resolve(target);
    if (resolved !== dir && !resolved.startsWith(dir + sep)) {
      throw new StagingError(400, "BAD_PATH", `Path escapes staging dir: ${paths[i]}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, await file.arrayBuffer());
    fileCount++;
  }

  await assertConfinedAndCapped(dir, limits);
  return { sessionId, dir, fileCount, totalBytes };
}

/**
 * True when an archive member path would escape the extraction root.
 * `entry` is already trimmed + non-empty (the caller skips blanks).
 */
function archiveEntryUnsafe(entry: string): boolean {
  const norm = entry.replace(/\\/g, "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return true;
  return norm.split("/").includes("..");
}

/**
 * Pre-extraction manifest check. Lists the archive's members and
 * rejects the WHOLE upload if any entry is absolute or contains a
 * `..` segment — *before a single byte is extracted*. This makes
 * confinement a hard guarantee instead of relying on `unzip`/`tar`'s
 * own (version-dependent) traversal heuristics. Fail-closed: an
 * unreadable manifest is treated as unsafe. `assertConfinedAndCapped`
 * still runs post-extraction as defence-in-depth for escaping
 * *symlink* members (whose targets don't appear in the listing).
 */
function assertArchiveEntriesConfined(
  archivePath: string,
  isZip: boolean,
): void {
  const cmd = isZip
    ? ["unzip", "-Z1", archivePath]
    : ["tar", "-tzf", archivePath];
  const proc = Bun.spawnSync(cmd, { stdio: ["ignore", "pipe", "pipe"] });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr?.toString().trim() ?? "";
    throw new StagingError(
      400,
      "ARCHIVE_UNREADABLE",
      `Could not read archive manifest: ${stderr || `${cmd[0]} exited ${proc.exitCode}`}`,
    );
  }
  for (const line of (proc.stdout?.toString() ?? "").split("\n")) {
    const entry = line.trim();
    if (entry.length === 0) continue;
    if (archiveEntryUnsafe(entry)) {
      throw new StagingError(
        400,
        "PATH_ESCAPE",
        `Archive contains an unsafe member path: ${entry}`,
      );
    }
  }
}

/**
 * Materialise an archive upload (`.zip` / `.tar.gz` / `.tgz`). The
 * archive bytes are written to an OS tmp file (never under
 * `projectRoot`); its member list is confinement-checked *before*
 * extraction (no escaping write ever reaches disk), then it's
 * extracted into the session dir, mirroring the github-install
 * extraction in `src/extensions/installer.ts`. Post-extraction the
 * tree is re-checked + capped (defence-in-depth for symlink members).
 */
export async function stageArchiveUpload(opts: {
  projectRoot: string;
  archive: File;
  limits?: Limits;
}): Promise<StagedUpload> {
  const { projectRoot, archive } = opts;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const name = (archive.name || "").toLowerCase();
  const isZip = name.endsWith(ZIP_EXT);
  const isTar = TAR_EXTS.some((e) => name.endsWith(e));
  if (!isZip && !isTar) {
    throw new StagingError(400, "BAD_ARCHIVE", "Archive must be .zip, .tar.gz, or .tgz");
  }
  if (archive.size === 0) {
    throw new StagingError(400, "EMPTY_UPLOAD", "Archive is empty");
  }
  if (archive.size > limits.maxTotalBytes) {
    throw new StagingError(413, "UPLOAD_TOO_LARGE", `Archive exceeds ${limits.maxTotalBytes} bytes`);
  }

  const { sessionId, dir } = await mkSessionDir(projectRoot);
  const tmp = await mkdtemp(join(tmpdir(), "import-archive-"));
  try {
    const archivePath = join(tmp, isZip ? "upload.zip" : "upload.tar.gz");
    await Bun.write(archivePath, await archive.arrayBuffer());

    // Fail-closed BEFORE extracting: a malicious `../` / absolute
    // member never touches disk.
    assertArchiveEntriesConfined(archivePath, isZip);

    const cmd = isZip
      ? ["unzip", "-q", "-o", archivePath, "-d", dir]
      : ["tar", "-xzf", archivePath, "-C", dir];
    const proc = Bun.spawnSync(cmd, { stdio: ["ignore", "pipe", "pipe"] });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr?.toString().trim() ?? "";
      throw new StagingError(
        400,
        "EXTRACT_FAILED",
        `Failed to extract archive: ${stderr || `${cmd[0]} exited ${proc.exitCode}`}`,
      );
    }
  } finally {
    await bestEffortRm(tmp);
  }

  const { fileCount, totalBytes } = await assertConfinedAndCapped(dir, limits);
  return { sessionId, dir, fileCount, totalBytes };
}

/**
 * Walk the staged tree: reject any entry (incl. symlink) whose
 * realpath escapes the session dir (zip-slip / `..` tar members /
 * escaping symlinks), and re-enforce the count / per-file / total
 * caps on the *extracted* result (a compressed size says nothing
 * about expanded size). Throws `StagingError` on the first violation;
 * the caller's `finally` cleans the dir.
 *
 * Exported for direct branch-level testing — production callers reach
 * it through `stageDirectoryUpload` / `stageArchiveUpload`.
 */
export async function assertConfinedAndCapped(
  dir: string,
  limits: Limits = DEFAULT_LIMITS,
): Promise<{ fileCount: number; totalBytes: number }> {
  const realRoot = await realpath(dir);
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(abs: string, depth: number): Promise<void> {
    if (depth > 64) {
      throw new StagingError(400, "TOO_DEEP", "Staged tree nested too deeply");
    }
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const child = join(abs, e.name);
      if (!(await realpathInsideRoot(realRoot, child))) {
        throw new StagingError(400, "PATH_ESCAPE", `Entry escapes staging dir: ${e.name}`);
      }
      if (e.isSymbolicLink()) continue; // confined link: counted-as-skip, never followed
      if (e.isDirectory()) {
        await walk(child, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const size = (await stat(child)).size;
      if (size > limits.maxFileBytes) {
        throw new StagingError(413, "FILE_TOO_LARGE", `"${e.name}" exceeds ${limits.maxFileBytes} bytes`);
      }
      fileCount++;
      totalBytes += size;
      if (fileCount > limits.maxFileCount) {
        throw new StagingError(413, "TOO_MANY_FILES", `Too many files (max ${limits.maxFileCount})`);
      }
      if (totalBytes > limits.maxTotalBytes) {
        throw new StagingError(413, "UPLOAD_TOO_LARGE", `Upload exceeds ${limits.maxTotalBytes} bytes`);
      }
    }
  }

  await walk(realRoot, 0);
  if (fileCount === 0) {
    throw new StagingError(400, "EMPTY_UPLOAD", "Upload contained no files");
  }
  return { fileCount, totalBytes };
}

/**
 * Find the directory the command/skill scanners should be pointed at.
 * Browser directory uploads (and many zips) nest everything under one
 * wrapper folder (the picked dir, or a home dir). Descend through
 * single-directory wrappers until we reach the dir that *contains* a
 * recognised config root (`.claude` / `.codex` / `agents`), or run out
 * of single-dir nesting. Never follows symlinks (Dirent.isDirectory is
 * false for links); depth-bounded; confined to `stagingDir`.
 */
export async function resolveScanRoot(stagingDir: string): Promise<string> {
  let dir: string;
  try {
    dir = await realpath(stagingDir);
  } catch {
    return stagingDir;
  }
  for (let depth = 0; depth < 16; depth++) {
    const entries = await readdir(dir, { withFileTypes: true });
    const visible = entries.filter((e) => e.name !== "__MACOSX");
    if (visible.some((e) => e.isDirectory() && SCAN_ROOT_MARKERS.has(e.name))) {
      return dir;
    }
    if (visible.length === 1 && visible[0]!.isDirectory()) {
      dir = join(dir, visible[0]!.name);
      continue;
    }
    return dir;
  }
  return dir;
}
