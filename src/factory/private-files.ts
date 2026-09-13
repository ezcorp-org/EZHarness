import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { basename, resolve } from "node:path";

function owner(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Private files require a POSIX owner.");
  return uid;
}

function privateError(message: string): Error { return new Error(message); }

/**
 * Opens every directory component through its already-open parent. Foreign
 * ancestors may only be non-writable; the first owned directory and all of
 * its descendants must be private. The caller owns the returned descriptor.
 */
export interface PrivateDirectoryOptions { readonly createLeaf?: boolean; readonly repairOwnedLeaf?: boolean }
export async function privateDirectory(path: string, options: PrivateDirectoryOptions = {}): Promise<FileHandle> {
  const uid = owner();
  let directory = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let reachedOwnedDirectory = false;
  try {
    const components = resolve(path).split("/").filter(Boolean);
    for (const [index, component] of components.entries()) {
      let child: FileHandle;
      try { child = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) {
        if (!options.createLeaf || index !== components.length - 1 || (error as NodeJS.ErrnoException).code !== "ENOENT" || !reachedOwnedDirectory) throw error;
        await mkdir(`/proc/self/fd/${directory.fd}/${component}`, { mode: 0o700 });
        child = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      }
      const status = await child.stat();
      if (!status.isDirectory()) { await child.close(); throw privateError("Private path component is not a directory."); }
      if (status.uid !== uid) {
        if (reachedOwnedDirectory || (status.mode & 0o022) !== 0) { await child.close(); throw privateError("Private path has a writable foreign ancestor."); }
      } else {
        if ((status.mode & 0o077) !== 0) {
          if (!options.repairOwnedLeaf || index !== components.length - 1) { await child.close(); throw privateError("Private path has a non-private owned ancestor."); }
          await child.chmod(0o700);
        }
        reachedOwnedDirectory = true;
      }
      await directory.close();
      directory = child;
    }
    if (!reachedOwnedDirectory) throw privateError("Private path has no owned directory.");
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

/** Reads one owned, private regular file through a directory descriptor. */
export async function readPrivate(directory: FileHandle, name: string, length: number): Promise<Uint8Array> {
  const bytes = await readPrivateBounded(directory, name, length);
  if (bytes.byteLength !== length) throw privateError("Private file must be exact-sized.");
  return bytes;
}

/** Reads one owned private regular leaf after its bounded size check. */
export async function readPrivateBounded(directory: FileHandle, name: string, maximumLength: number): Promise<Uint8Array> {
  if (basename(name) !== name || !Number.isSafeInteger(maximumLength) || maximumLength < 1) throw privateError("Private file leaf is invalid.");
  const handle = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.uid !== owner() || (status.mode & 0o077) !== 0 || status.size < 1 || status.size > maximumLength) throw privateError("Private file must be owned, private, regular, and bounded.");
    const bytes = Buffer.allocUnsafe(status.size);
    const { bytesRead } = await handle.read(bytes, 0, status.size, 0);
    if (bytesRead !== status.size) throw privateError("Private file changed during its bounded read.");
    return Uint8Array.from(bytes);
  } finally {
    await handle.close();
  }
}
