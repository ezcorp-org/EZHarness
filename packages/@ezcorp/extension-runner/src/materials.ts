import { constants } from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { RunnerError } from "./core";

/** One regular file a guest left behind, named relative to the material root. */
export interface RunnerMaterialEntry {
  readonly path: string;
  readonly bytes: number;
}

export interface RunnerMaterialLimits {
  /** Refuse a tree with more entries than this. Default 4096. */
  readonly maxEntries?: number;
  /** Refuse a tree larger than this in total. Default 1 GiB. */
  readonly maxTotalBytes?: number;
  /** Refuse a directory nested deeper than this. Default 16. */
  readonly maxDepth?: number;
}

const DEFAULTS = Object.freeze({ maxEntries: 4096, maxTotalBytes: 1024 ** 3, maxDepth: 16 });

function refuse(message: string): never {
  throw new RunnerError("material_untrusted", message);
}

/**
 * Lists the regular files a guest left in its material directory.
 *
 * The material mount is the one place a guest may write, so everything in it is
 * untrusted input. A guest can create a symlink there, which was measured
 * rather than assumed, so a host that later opened these paths could be made to
 * read any file it can reach. This walk refuses a symlink, a device, a socket,
 * and a FIFO outright instead of following or ignoring one, and it is bounded in
 * entries, bytes, and depth so a guest cannot turn a read-back into a denial of
 * service.
 *
 * Call it only after the guest is confirmed stopped. A running guest could swap
 * a directory component between this walk and a later open, and no check on
 * this side can close that race.
 */
export async function listRunnerMaterials(directory: string, limits: RunnerMaterialLimits = {}): Promise<RunnerMaterialEntry[]> {
  const bounds = { ...DEFAULTS, ...limits };
  const entries: RunnerMaterialEntry[] = [];
  let total = 0;

  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > bounds.maxDepth) refuse("Runner material tree is nested too deeply");
    for (const found of await readdir(current, { withFileTypes: true })) {
      const path = join(current, found.name);
      // `readdir` reports the entry itself, never its target, so a symlink is
      // visible here as a symlink and is refused rather than resolved.
      if (found.isSymbolicLink()) refuse("Runner material entry is a symbolic link");
      if (found.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!found.isFile()) refuse("Runner material entry is not a regular file");
      if (entries.length >= bounds.maxEntries) refuse("Runner material tree has too many entries");
      const file = await openRunnerMaterial(directory, relative(directory, path));
      let size: number;
      try { size = (await file.stat()).size; }
      finally { await file.close(); }
      total += size;
      if (total > bounds.maxTotalBytes) refuse("Runner material tree is too large");
      entries.push({ path: relative(directory, path).split(sep).join("/"), bytes: size });
    }
  };

  await walk(directory, 0);
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Opens one guest-written file without ever following a symbolic link.
 *
 * `O_NOFOLLOW` refuses a symlink at the final component, and the descriptor is
 * then checked to be a regular file, so neither a planted link nor a swapped
 * file type can make a host read something else. The relative path is rejected
 * if it escapes the material root or is absolute.
 */
export async function openRunnerMaterial(directory: string, entry: string): Promise<FileHandle> {
  if (!entry || entry.startsWith("/") || entry.split(/[\\/]/).some(part => part === "..")) refuse("Runner material path escapes its directory");
  const path = join(directory, entry);
  if (relative(directory, path).startsWith("..")) refuse("Runner material path escapes its directory");
  // `O_NONBLOCK` matters as much as `O_NOFOLLOW` here: opening a FIFO for
  // reading blocks until a writer appears, so a guest that plants one could
  // otherwise hang the host's read-back forever. It returns at once instead,
  // and the file-type check below refuses it. On a regular file it does nothing.
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { refuse(`Runner material entry could not be opened as a regular file (${(error as { code?: string }).code ?? "unknown"})`); }
  const stats = await handle.stat();
  if (!stats.isFile()) { await handle.close(); refuse("Runner material entry is not a regular file"); }
  return handle;
}
