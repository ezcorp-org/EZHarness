import { constants } from "node:fs";
import { open, mkdir, unlink, readdir, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import type { FsHandlerContext } from "./fs-handler";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import { extensionDataDir, isRemovableDataDir } from "./extension-data-dir";
import { isReservedSensitivePath } from "./permissions";

export type VirtualFsOperation = "read" | "write" | "list" | "stat" | "exists" | "mkdir" | "unlink";
export interface VirtualFilesystemRoots { project?: string; data: string }
export interface VirtualFilesystemPorts {
  roots(context: { extensionId: string; extensionName: string; userId: string; conversationId: string | null }): Promise<VirtualFilesystemRoots>;
}
export const VIRTUAL_FILE_LIMIT = 512 * 1024;

export const productionFilesystemPorts: VirtualFilesystemPorts = {
  async roots(context) {
    if (!isRemovableDataDir(context.extensionName)) throw new Error("Invalid extension data namespace");
    const { getUserById } = await import("../db/queries/users");
    const user = await getUserById(context.userId);
    if (user?.status !== "active") throw new Error("Active user required");
    const data = extensionDataDir(context.extensionName);
    if (!context.conversationId) return { data };
    const { getConversation } = await import("../db/queries/conversations");
    const conversation = await getConversation(context.conversationId);
    if (!conversation || (conversation.userId !== user.id && user.role !== "admin")) throw new Error("Conversation access denied");
    if (!conversation.projectId) return { data };
    const { getProjectMembership } = await import("../db/queries/project-members");
    if (user.role !== "admin" && !(await getProjectMembership(user.id, conversation.projectId))) throw new Error("Project membership required");
    const { getProject } = await import("../db/queries/projects");
    const project = await getProject(conversation.projectId);
    if (!project?.path) throw new Error("Project root unavailable");
    return { project: project.path, data };
  },
};

function pathParts(path: unknown): { root: "project" | "data"; parts: string[]; virtual: string } {
  if (typeof path !== "string" || path.length > 4096 || path.includes("\\") || [...path].some((character) => character.charCodeAt(0) < 32)) throw new Error("Invalid virtual path");
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = normalized.split("/");
  const root = segments[1];
  if (segments[0] !== "" || (root !== "project" && root !== "data") || segments.slice(2).some((part) => !part || part === "." || part === "..")) throw new Error("Use a path under /project or /data without traversal");
  return { root, parts: segments.slice(2), virtual: normalized };
}

async function childDirectory(parent: FileHandle, name: string, create: boolean): Promise<FileHandle> {
  const path = `/proc/self/fd/${parent.fd}/${name}`;
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function directory(root: string, parts: string[], create: boolean, createRoot: boolean): Promise<FileHandle> {
  const rootParts = resolve(root).split("/").filter(Boolean);
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const [index, part] of [...rootParts, ...parts].entries()) {
      const next = await childDirectory(handle, part, index < rootParts.length ? createRoot : create);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

function covered(path: string, prefixes: readonly string[] | undefined): boolean {
  return Boolean(prefixes?.some((prefix) => {
    try { const grant = pathParts(prefix).virtual; return path === grant || path.startsWith(`${grant}/`); } catch { return false; }
  }));
}

export async function handleVirtualFilesystemRpc(operation: VirtualFsOperation, request: JsonRpcRequest, context: FsHandlerContext, ports: VirtualFilesystemPorts = productionFilesystemPorts): Promise<JsonRpcResponse> {
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  let parent: FileHandle | undefined;
  let file: FileHandle | undefined;
  let authorizedPath: string | undefined;
  try {
    const params = request.params as Record<string, unknown> | undefined;
    const path = pathParts(params?.path);
    const manifest = context.registry.getManifest(context.extensionId);
    const grants = context.registry.getGrantedPermissions(context.extensionId);
    if (!manifest || !covered(path.virtual, manifest.permissions.filesystem) || !covered(path.virtual, grants?.filesystem)) return fail(-32001, "Filesystem path is outside the approved virtual roots.");
    const writing = ["write", "mkdir", "unlink"].includes(operation);
    let writeBytes: Buffer | undefined;
    if (operation === "write") {
      if (typeof params?.content !== "string" || (params.encoding !== undefined && params.encoding !== "binary" && params.encoding !== "utf-8")) return fail(-32602, "Write requires text or base64 content.");
      if (params.encoding === "binary" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(params.content)) return fail(-32602, "Invalid base64 content.");
      writeBytes = Buffer.from(params.content, params.encoding === "binary" ? "base64" : "utf8");
      if (writeBytes.byteLength > VIRTUAL_FILE_LIMIT) return fail(-32000, "Write exceeds the bounded file transfer limit.");
    }
    const namedTool = typeof params?._toolName === "string" ? manifest.tools?.find((tool) => tool.name === params._toolName) : undefined;
    if (namedTool?.capabilities?.filesystem && !namedTool.capabilities.filesystem.mode.includes(writing ? "write" : "read")) return fail(-32001, "The current tool does not permit this filesystem operation.");
    const roots = await ports.roots({ extensionId: context.extensionId, extensionName: manifest.name, userId: context.userId, conversationId: context.conversationId === "unknown" ? null : context.conversationId });
    const root = roots[path.root];
    if (!root || !root.startsWith("/")) return fail(-32001, "The requested virtual root is unavailable in this invocation.");
    const actual = resolve(root, ...path.parts);
    if (await isReservedSensitivePath(actual)) return fail(-32001, "The path is reserved by the host.");
    const decision = await context.engine.authorize({ extensionId: context.extensionId, userId: context.userId, conversationId: context.conversationId }, [{ kind: writing ? "fs.write" : operation === "list" ? "fs.list" : operation === "stat" ? "fs.stat" : "fs.read", value: path.virtual }]);
    if (decision.decision !== "allow") return fail(-32001, "Filesystem access requires an approved capability.");
    authorizedPath = path.virtual;
    if (writing && path.parts.length === 0 && operation !== "mkdir") return fail(-32001, "A virtual root cannot be replaced or removed.");
    const recursive = operation === "mkdir" && params?.recursive === true;
    const parentParts = path.parts.slice(0, -1);
    parent = await directory(root, parentParts, recursive, path.root === "data");
    const leaf = path.parts.at(-1);
    const target = leaf ? `/proc/self/fd/${parent.fd}/${leaf}` : `/proc/self/fd/${parent.fd}`;
    let result: Record<string, unknown> = { resolvedPath: path.virtual };
    if (operation === "mkdir") {
      if (leaf) { const created = await childDirectory(parent, leaf, true); await created.close(); }
      result.created = true;
    } else if (operation === "unlink") {
      await unlink(target);
      result.removed = true;
    } else {
      const flags = operation === "write" ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY;
      file = leaf ? await open(target, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600) : parent;
      const stat = await file.stat();
      if (!stat.isFile() && !stat.isDirectory()) return fail(-32001, "Only regular files and directories are supported.");
      if (operation === "read") {
        if (!stat.isFile() || stat.size > VIRTUAL_FILE_LIMIT) return fail(-32000, "Read exceeds the bounded file transfer limit.");
        const bytes = Buffer.alloc(VIRTUAL_FILE_LIMIT + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        if (offset > VIRTUAL_FILE_LIMIT) return fail(-32000, "Read exceeds the bounded file transfer limit.");
        result = { ...result, encoding: params?.encoding === "binary" ? "binary" : "utf-8", body: bytes.subarray(0, offset).toString("base64"), bytes: offset };
      } else if (operation === "write") {
        if (!stat.isFile() || !writeBytes) return fail(-32602, "Write requires a regular file.");
        await file.truncate(0);
        await file.writeFile(writeBytes);
        result.bytes = writeBytes.byteLength;
      } else if (operation === "list") {
        if (!stat.isDirectory()) return fail(-32602, "List requires a directory.");
        const entries = await readdir(`/proc/self/fd/${file.fd}`, { withFileTypes: true });
        if (entries.length > 2000) return fail(-32000, "Directory listing exceeds the entry limit.");
        result.entries = entries.map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }));
      } else if (operation === "stat") result = { ...result, size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile(), isDirectory: stat.isDirectory() };
      else result.exists = true;
    }
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (operation === "exists" && authorizedPath && code === "ENOENT") return { jsonrpc: "2.0", id: request.id, result: { resolvedPath: authorizedPath, exists: false } };
    return fail(code === "ENOENT" ? -32000 : -32001, code === "ENOENT" ? "Path does not exist in this virtual root." : "Filesystem request was denied or could not be completed.");
  } finally {
    if (file && file !== parent) await file.close().catch(() => undefined);
    await parent?.close().catch(() => undefined);
  }
}
