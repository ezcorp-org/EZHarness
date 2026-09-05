import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleVirtualFilesystemRpc, VIRTUAL_FILE_LIMIT, type VirtualFsOperation } from "./virtual-filesystem";
import { handlePiFsRead } from "./tool-executor/fs-rpc";
import { registerCallProvenance, releaseCallProvenance } from "./call-provenance";
import type { FsHandlerContext } from "./fs-handler";
import type { JsonRpcResponse } from "./types";

let root: string;
let context: FsHandlerContext;
let decision = "allow";
let declared = ["/project", "/data"];
let granted = ["/project", "/data"];
const identities: unknown[] = [];
const ports = { async roots(identity: unknown) { identities.push(identity); return { project: join(root, "project"), data: join(root, "data") }; } };
const call = (operation: VirtualFsOperation, path: string, extra = {}) => handleVirtualFilesystemRpc(operation, { jsonrpc: "2.0", id: 1, method: `ezcorp/fs.${operation}`, params: { path, ...extra } }, context, ports);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "extension-virtual-fs-"));
  await mkdir(join(root, "project"));
  decision = "allow";
  declared = ["/project", "/data"];
  granted = [...declared];
  identities.length = 0;
  context = {
    extensionId: "fixture", userId: "owner", conversationId: "conversation",
    registry: { getManifest: () => ({ schemaVersion: 4, name: "fixture", permissions: { filesystem: declared } }), getGrantedPermissions: () => ({ filesystem: granted }) },
    engine: { authorize: async () => ({ decision }) },
  } as unknown as FsHandlerContext;
});
afterEach(() => rm(root, { recursive: true, force: true }));

test("virtual read/write/list/stat/mkdir/unlink use only caller roots", async () => {
  expect((await call("mkdir", "/data/nested", { recursive: true })).error).toBeUndefined();
  expect((await call("write", "/data/nested/file.txt", { content: "hello" })).result).toMatchObject({ bytes: 5, resolvedPath: "/data/nested/file.txt" });
  expect((await call("read", "/data/nested/file.txt")).result).toMatchObject({ body: Buffer.from("hello").toString("base64"), bytes: 5 });
  expect((await call("stat", "/data/nested/file.txt")).result).toMatchObject({ isFile: true, size: 5 });
  expect((await call("list", "/data/nested")).result).toMatchObject({ entries: [{ name: "file.txt", isFile: true, isDirectory: false }] });
  expect((await call("unlink", "/data/nested/file.txt")).error).toBeUndefined();
  expect((await call("exists", "/data/nested/file.txt")).result).toMatchObject({ exists: false });
  expect(identities[0]).toMatchObject({ userId: "owner", conversationId: "conversation", extensionId: "fixture" });
});

test("raw host paths, traversal, prefix confusion and malformed paths fail", async () => {
  for (const path of [root, "/etc/passwd", "/project/../secret", "/project2/file", "/project//file", "/project/./file", "/data/\\escape", "/project/\0file"]) expect((await call("read", path)).error).toBeDefined();
  expect(identities).toHaveLength(0);
});

test("both manifest and exact grant are required, pending decisions never run IO", async () => {
  await writeFile(join(root, "project", "file"), "private");
  granted = ["/data"];
  expect((await call("read", "/project/file")).error?.code).toBe(-32001);
  granted = ["/project"];
  declared = ["/data"];
  expect((await call("read", "/project/file")).error?.code).toBe(-32001);
  declared = ["/project"];
  decision = "prompt";
  expect((await call("write", "/project/file", { content: "changed" })).error?.code).toBe(-32001);
  expect(await readFile(join(root, "project", "file"), "utf8")).toBe("private");
});

test("symlink leaves and parents cannot escape read or write", async () => {
  await writeFile(join(root, "secret"), "private");
  await symlink(join(root, "secret"), join(root, "project", "leaf"));
  await symlink(root, join(root, "project", "parent"));
  for (const path of ["/project/leaf", "/project/parent/secret"]) {
    expect((await call("read", path)).error).toBeDefined();
    expect((await call("write", path, { content: "changed" })).error).toBeDefined();
  }
  expect(await readFile(join(root, "secret"), "utf8")).toBe("private");
});

test("invalid and oversized writes have no file creation side effect", async () => {
  for (const extra of [{ content: "!", encoding: "binary" }, { content: 3 }, { content: "x".repeat(VIRTUAL_FILE_LIMIT + 1) }]) expect((await call("write", "/project/new", extra)).error).toBeDefined();
  expect((await call("exists", "/project/new")).result).toMatchObject({ exists: false });
  expect((await call("unlink", "/project")).error).toBeDefined();
});

test("public handler binds roots to host-issued provenance and rejects missing tokens", async () => {
  await writeFile(join(root, "project", "file"), "correct");
  const dependencies = { registry: context.registry, engine: context.engine, virtualFilesystem: ports };
  const request = { jsonrpc: "2.0" as const, id: 1, method: "ezcorp/fs.read", params: { path: "/project/file" } };
  expect(((await handlePiFsRead(dependencies, "fixture", request)) as JsonRpcResponse).error).toBeDefined();
  const token = registerCallProvenance({ onBehalfOf: "other-user", conversationId: "other-conversation", actorExtensionId: "fixture", runId: null, parentCallId: null, kind: "tool", ownerless: false });
  try {
    const response = await handlePiFsRead(dependencies, "fixture", { ...request, params: { ...request.params, _meta: { ezCallId: token } } });
    expect((response as JsonRpcResponse).error).toBeUndefined();
    expect(identities.at(-1)).toMatchObject({ userId: "other-user", conversationId: "other-conversation" });
    expect(JSON.stringify(response)).not.toContain(root);
  } finally { releaseCallProvenance(token); }
});
