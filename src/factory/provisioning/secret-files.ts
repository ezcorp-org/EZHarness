/**
 * The provisioner's private file primitives.
 *
 * Every credential a step generates lands here, in a directory the private
 * reader accepts: owned by this process, mode 0700, no writable foreign
 * ancestor. The same reader the product and the Node process use
 * (`private-files.ts`) is the one that checks what was written, so a file this
 * module accepts is a file the installation can boot from.
 */
import { constants } from "node:fs";
import { open, rm, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { privateDirectory, readPrivateBounded, writePrivateBoundedAtomic } from "../private-files";
import { FactoryProvisioningError } from "./steps";

export const FACTORY_PROVISIONED_FILE_LIMIT = 64 * 1024;

function leaf(name: string): string {
  if (basename(name) !== name || name === "." || name === ".." || name.length === 0) throw new FactoryProvisioningError("provisioning_secret_leaf_invalid", "Provisioner secret leaf is invalid.");
  return name;
}

/** Open (and create) a private directory owned by this process. The caller closes it. */
export function openFactoryPrivateDirectory(path: string): Promise<FileHandle> {
  return privateDirectory(resolve(path), { createLeaf: true, repairOwnedLeaf: true });
}

/**
 * Write a file once, or prove the existing one is private and ours.
 *
 * Returns whether this call created it. An existing file is NEVER rewritten:
 * a rerun after a crash must keep the credential that the external resource
 * was already created with, or the next verification would test a password
 * nothing accepts.
 */
export async function ensureFactoryPrivateFile(directory: FileHandle, name: string, value: () => Uint8Array | string): Promise<boolean> {
  const path = `/proc/self/fd/${directory.fd}/${leaf(name)}`;
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value()); await handle.sync(); } finally { await handle.close(); }
    return true;
  }
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0) throw new FactoryProvisioningError("provisioning_secret_unsafe", `Provisioner secret file ${name} must be private and owned by this user.`);
  } finally { await handle.close(); }
  return false;
}

export async function readFactoryPrivateBytes(directory: FileHandle, name: string, limit = FACTORY_PROVISIONED_FILE_LIMIT): Promise<Uint8Array> {
  return readPrivateBounded(directory, leaf(name), limit);
}

export async function readFactoryPrivateText(directory: FileHandle, name: string, limit = FACTORY_PROVISIONED_FILE_LIMIT): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readFactoryPrivateBytes(directory, name, limit));
}

export async function readFactoryPrivateJson<Value>(directory: FileHandle, name: string): Promise<Value> {
  try { return JSON.parse(await readFactoryPrivateText(directory, name)) as Value; }
  catch (error) {
    if (error instanceof SyntaxError) throw new FactoryProvisioningError("provisioning_secret_corrupt", `Provisioner secret file ${name} is not valid JSON.`);
    throw error;
  }
}

/** Read one private file by absolute path, through the same private reader. */
export async function readFactoryPrivatePath(path: string, limit = FACTORY_PROVISIONED_FILE_LIMIT): Promise<Uint8Array> {
  const absolute = resolve(path);
  const directory = await privateDirectory(dirname(absolute));
  try { return await readPrivateBounded(directory, basename(absolute), limit); }
  finally { await directory.close(); }
}

/** Replace a private file atomically. Rotation's only write path. */
export async function replaceFactoryPrivateFile(path: string, value: Uint8Array | string): Promise<void> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  await writePrivateBoundedAtomic(resolve(path), bytes, FACTORY_PROVISIONED_FILE_LIMIT);
}

/** Remove one file this installation owns. Absent is success: teardown runs twice. */
export async function removeFactoryPrivateFile(directory: FileHandle, name: string): Promise<void> {
  try { await unlink(`/proc/self/fd/${directory.fd}/${leaf(name)}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/**
 * Remove a whole private directory this installation owns.
 *
 * Refuses anything that is not a private directory owned by this process, so a
 * path recorded wrongly can never delete someone else's tree.
 */
export async function removeFactoryPrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  let directory: FileHandle;
  try { directory = await privateDirectory(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await directory.close();
  await rm(absolute, { recursive: true, force: true });
}

export function factoryPrivatePath(directory: string, name: string): string {
  return join(resolve(directory), leaf(name));
}
