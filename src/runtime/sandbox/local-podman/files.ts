import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import type {
  SandboxFileChmodInput,
  SandboxFileListInput,
  SandboxFileMkdirInput,
  SandboxFileReadInput,
  SandboxFileRemoveInput,
  SandboxFileStat,
  SandboxFileStatInput,
  SandboxFileWriteInput,
} from "@ezcorp/extension-contract";
import { validateProviderMethodValue } from "@ezcorp/extension-contract";

const CONTRACT_CHUNK_BYTES = 256 * 1024;
const CONTRACT_LIST_ENTRIES = 256;

export interface LocalWorkspaceFileLimits {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
}

export class LocalWorkspaceFileError extends Error {
  constructor(public readonly code: "invalid_path" | "revision_conflict" | "limit_exceeded" | "unsupported_file" | "invalid_cursor", message: string) {
    super(message);
    this.name = "LocalWorkspaceFileError";
  }
}

interface OpenedRoot { handle: FileHandle; device: bigint }
interface OpenedEntry { handle: FileHandle; stat: BigIntStats }

function descriptorPath(directory: FileHandle, name?: string): string {
  return name === undefined ? `/proc/self/fd/${directory.fd}` : `/proc/self/fd/${directory.fd}/${name}`;
}

function parts(path: string): string[] {
  return path === "/" ? [] : path.slice(1).split("/");
}

function revision(stat: BigIntStats): string {
  return createHash("sha256").update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":"), "utf8").digest("hex");
}

function resultStat(path: string, stat: BigIntStats): SandboxFileStat {
  return { path, kind: stat.isDirectory() ? "directory" : "file", revision: revision(stat), sizeBytes: Number(stat.size), mode: Number(stat.mode & 0o777n) };
}

function decodeWrite(encoding: "utf8" | "base64", data: string): Buffer {
  return Buffer.from(data, encoding === "utf8" ? "utf8" : "base64");
}

function encodeRead(bytes: Buffer): { encoding: "utf8" | "base64"; data: string } {
  try { return { encoding: "utf8", data: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
  catch { return { encoding: "base64", data: bytes.toString("base64") }; }
}

function cursor(path: string, after: string): string {
  return Buffer.from(JSON.stringify({ path, after }), "utf8").toString("base64url");
}

function parseCursor(value: string | undefined, path: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    const record = decoded as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.path !== path || typeof record.after !== "string" || !record.after) throw new Error();
    return record.after;
  } catch { throw new LocalWorkspaceFileError("invalid_cursor", "List cursor does not belong to this directory"); }
}

export class LocalWorkspaceFiles {
  private mutation = Promise.resolve();

  constructor(private readonly root: string, readonly limits: Readonly<LocalWorkspaceFileLimits>) {
    if (!root.startsWith("/") || !Number.isSafeInteger(limits.maxReadBytes) || limits.maxReadBytes < 1 || limits.maxReadBytes > CONTRACT_CHUNK_BYTES || !Number.isSafeInteger(limits.maxWriteBytes) || limits.maxWriteBytes < 1 || limits.maxWriteBytes > CONTRACT_CHUNK_BYTES || !Number.isSafeInteger(limits.maxListEntries) || limits.maxListEntries < 1 || limits.maxListEntries > CONTRACT_LIST_ENTRIES) throw new LocalWorkspaceFileError("limit_exceeded", "Invalid local workspace file limits");
  }

  private async rootHandle(): Promise<OpenedRoot> {
    const handle = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    return { handle, device: stat.dev };
  }

  private async childDirectory(parent: FileHandle, name: string, device: bigint, create = false): Promise<FileHandle> {
    const path = descriptorPath(parent, name);
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    if (stat.dev !== device) { await handle.close(); throw new LocalWorkspaceFileError("unsupported_file", "Workspace path crossed a filesystem boundary"); }
    return handle;
  }

  private async parent(root: OpenedRoot, path: string, create = false): Promise<{ handle: FileHandle; leaf?: string }> {
    const pathParts = parts(path);
    const leaf = pathParts.pop();
    let handle = root.handle;
    try {
      for (const part of pathParts) {
        const next = await this.childDirectory(handle, part, root.device, create);
        if (handle !== root.handle) await handle.close();
        handle = next;
      }
      return { handle, ...(leaf ? { leaf } : {}) };
    } catch (error) {
      if (handle !== root.handle) await handle.close();
      throw error;
    }
  }

  private async entry(root: OpenedRoot, path: string): Promise<OpenedEntry> {
    if (path === "/") return { handle: root.handle, stat: await root.handle.stat({ bigint: true }) };
    const parent = await this.parent(root, path);
    try {
      const handle = await open(descriptorPath(parent.handle, parent.leaf!), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat({ bigint: true });
      if (stat.dev !== root.device || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1n)) {
        await handle.close();
        throw new LocalWorkspaceFileError("unsupported_file", "Only same-filesystem regular files and directories are supported");
      }
      return { handle, stat };
    } finally {
      if (parent.handle !== root.handle) await parent.handle.close();
    }
  }

  private exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async safe<Result>(operation: () => Promise<Result>): Promise<Result> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof LocalWorkspaceFileError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new LocalWorkspaceFileError(code === "ENOENT" ? "invalid_path" : "unsupported_file", code === "ENOENT" ? "Workspace path does not exist" : "Workspace filesystem operation was denied");
    }
  }

  async stat(request: SandboxFileStatInput): Promise<{ entry: SandboxFileStat }> {
    return this.safe(async () => {
      validateProviderMethodValue("sandbox.files.v1", "stat", "input", request);
      const root = await this.rootHandle();
      try {
        const opened = await this.entry(root, request.path);
        try { return { entry: resultStat(request.path, opened.stat) }; }
        finally { if (opened.handle !== root.handle) await opened.handle.close(); }
      } finally { await root.handle.close(); }
    });
  }

  async list(request: SandboxFileListInput): Promise<{ entries: SandboxFileStat[]; nextCursor?: string }> {
    return this.safe(async () => {
      validateProviderMethodValue("sandbox.files.v1", "list", "input", request);
      if (request.limit > this.limits.maxListEntries) throw new LocalWorkspaceFileError("limit_exceeded", "List limit exceeds local policy");
      const after = parseCursor(request.cursor, request.path);
      const root = await this.rootHandle();
      try {
      const opened = await this.entry(root, request.path);
      try {
        if (!opened.stat.isDirectory()) throw new LocalWorkspaceFileError("unsupported_file", "List requires a directory");
        const names = (await readdir(descriptorPath(opened.handle))).sort();
        const start = after === undefined ? 0 : names.findIndex(name => name > after);
        const selected = start < 0 ? [] : names.slice(start, start + request.limit);
        const entries: SandboxFileStat[] = [];
        for (const name of selected) {
          const childPath = request.path === "/" ? `/${name}` : `${request.path}/${name}`;
          const child = await this.entry(root, childPath);
          try { entries.push(resultStat(childPath, child.stat)); }
          finally { if (child.handle !== root.handle) await child.handle.close(); }
        }
        const more = start >= 0 && start + selected.length < names.length;
        return { entries, ...(more && selected.length ? { nextCursor: cursor(request.path, selected.at(-1)!) } : {}) };
      } finally { if (opened.handle !== root.handle) await opened.handle.close(); }
      } finally { await root.handle.close(); }
    });
  }

  async read(request: SandboxFileReadInput): Promise<{ path: string; revision: string; offsetBytes: number; nextOffsetBytes: number; eof: boolean; encoding: "utf8" | "base64"; data: string }> {
    return this.safe(async () => {
      validateProviderMethodValue("sandbox.files.v1", "read", "input", request);
      if (request.lengthBytes > this.limits.maxReadBytes) throw new LocalWorkspaceFileError("limit_exceeded", "Read length exceeds local policy");
      const root = await this.rootHandle();
      try {
      const opened = await this.entry(root, request.path);
      try {
        if (!opened.stat.isFile()) throw new LocalWorkspaceFileError("unsupported_file", "Read requires a regular file");
        const observedRevision = revision(opened.stat);
        if (request.revision !== undefined && request.revision !== observedRevision) throw new LocalWorkspaceFileError("revision_conflict", "File revision changed");
        const bytes = Buffer.alloc(request.lengthBytes);
        const read = await opened.handle.read(bytes, 0, bytes.length, request.offsetBytes);
        const body = bytes.subarray(0, read.bytesRead);
        return { path: request.path, revision: observedRevision, offsetBytes: request.offsetBytes, nextOffsetBytes: request.offsetBytes + body.byteLength, eof: request.offsetBytes + body.byteLength >= Number(opened.stat.size), ...encodeRead(body) };
      } finally { if (opened.handle !== root.handle) await opened.handle.close(); }
      } finally { await root.handle.close(); }
    });
  }

  async write(request: SandboxFileWriteInput): Promise<{ entry: SandboxFileStat }> {
    return this.safe(async () => {
      validateProviderMethodValue("sandbox.files.v1", "write", "input", request);
      const bytes = decodeWrite(request.encoding, request.data);
      if (bytes.byteLength > this.limits.maxWriteBytes) throw new LocalWorkspaceFileError("limit_exceeded", "Write exceeds local policy");
      if (request.path === "/") throw new LocalWorkspaceFileError("invalid_path", "Workspace root cannot be replaced");
      return this.exclusive(async () => {
      const root = await this.rootHandle();
      let parent: FileHandle | undefined;
      let temporary: FileHandle | undefined;
      let temporaryPath: string | undefined;
      try {
        const resolved = await this.parent(root, request.path);
        parent = resolved.handle;
        const target = descriptorPath(parent, resolved.leaf!);
        let mode = 0o600;
        try {
          const current = await this.entry(root, request.path);
          try {
            if (!current.stat.isFile()) throw new LocalWorkspaceFileError("unsupported_file", "Write target must be a regular file");
            if (request.expectedRevision !== undefined && revision(current.stat) !== request.expectedRevision) throw new LocalWorkspaceFileError("revision_conflict", "File revision changed");
            mode = Number(current.stat.mode & 0o777n);
          } finally { await current.handle.close(); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || request.expectedRevision !== undefined) throw error;
        }
        const temporaryName = `.ez-write-${randomUUID()}`;
        temporaryPath = descriptorPath(parent, temporaryName);
        temporary = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
        await temporary.writeFile(bytes);
        await temporary.sync();
        await temporary.close();
        temporary = undefined;
        await rename(temporaryPath, target);
        temporaryPath = undefined;
        const written = await this.entry(root, request.path);
        try { return { entry: resultStat(request.path, written.stat) }; }
        finally { await written.handle.close(); }
      } finally {
        await temporary?.close().catch(() => undefined);
        if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
        if (parent && parent !== root.handle) await parent.close().catch(() => undefined);
        await root.handle.close();
      }
      });
    });
  }

  async mkdir(request: SandboxFileMkdirInput): Promise<{ entry: SandboxFileStat }> {
    return this.safe(async () => {
      validateProviderMethodValue("sandbox.files.v1", "mkdir", "input", request);
      return this.exclusive(async () => {
      const root = await this.rootHandle();
      try {
        let handle = root.handle;
        for (const [index, part] of parts(request.path).entries()) {
          const next = await this.childDirectory(handle, part, root.device, request.recursive || index === parts(request.path).length - 1);
          if (handle !== root.handle) await handle.close();
          handle = next;
        }
        try { return { entry: resultStat(request.path, await handle.stat({ bigint: true })) }; }
        finally { if (handle !== root.handle) await handle.close(); }
      } finally { await root.handle.close(); }
      });
    });
  }

  private async removeDirectory(directory: FileHandle, device: bigint): Promise<void> {
    for (const name of await readdir(descriptorPath(directory))) {
      const path = descriptorPath(directory, name);
      const child = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await child.stat({ bigint: true });
      try {
        if (stat.dev !== device || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1n)) throw new LocalWorkspaceFileError("unsupported_file", "Removal found an unsupported file");
        if (stat.isDirectory()) { await this.removeDirectory(child, device); await rmdir(path); }
        else await unlink(path);
      } finally { await child.close(); }
    }
  }

  async remove(request: SandboxFileRemoveInput): Promise<{ removedRevision: string }> {
    return this.safe(async () => {
      validateProviderMethodValue("sandbox.files.v1", "remove", "input", request);
      if (request.path === "/") throw new LocalWorkspaceFileError("invalid_path", "Workspace root cannot be removed");
      return this.exclusive(async () => {
      const root = await this.rootHandle();
      let parent: FileHandle | undefined;
      try {
        const opened = await this.entry(root, request.path);
        const observedRevision = revision(opened.stat);
        if (request.expectedRevision !== undefined && request.expectedRevision !== observedRevision) { await opened.handle.close(); throw new LocalWorkspaceFileError("revision_conflict", "File revision changed"); }
        const resolved = await this.parent(root, request.path);
        parent = resolved.handle;
        const target = descriptorPath(parent, resolved.leaf!);
        try {
          if (opened.stat.isDirectory()) {
            if (!request.recursive && (await readdir(descriptorPath(opened.handle))).length) throw new LocalWorkspaceFileError("unsupported_file", "Directory is not empty");
            if (request.recursive) await this.removeDirectory(opened.handle, root.device);
            await rmdir(target);
          } else await unlink(target);
        } finally { await opened.handle.close(); }
        return { removedRevision: observedRevision };
      } finally {
        if (parent && parent !== root.handle) await parent.close().catch(() => undefined);
        await root.handle.close();
      }
      });
    });
  }

  async chmod(request: SandboxFileChmodInput): Promise<{ entry: SandboxFileStat }> {
    return this.safe(async () => {
      validateProviderMethodValue("sandbox.files.v1", "chmod", "input", request);
      if (request.path === "/") throw new LocalWorkspaceFileError("invalid_path", "Workspace root mode is host-owned");
      return this.exclusive(async () => {
      const root = await this.rootHandle();
      try {
        const opened = await this.entry(root, request.path);
        try {
          if (request.expectedRevision !== undefined && request.expectedRevision !== revision(opened.stat)) throw new LocalWorkspaceFileError("revision_conflict", "File revision changed");
          await opened.handle.chmod(request.mode);
          return { entry: resultStat(request.path, await opened.handle.stat({ bigint: true })) };
        } finally { await opened.handle.close(); }
      } finally { await root.handle.close(); }
      });
    });
  }
}
