import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessEnv, makeFsRpcHandler, wireFsHandler, installFsChannelStub } from "../src/test/filesystem";
import { getChannel } from "../src/runtime";
import type { JsonRpcRequest, JsonRpcResponse } from "../src/types";

const roots: string[] = [];
const priorGrant = process.env.EZCORP_FS_ALLOWED;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (priorGrant === undefined) delete process.env.EZCORP_FS_ALLOWED;
  else process.env.EZCORP_FS_ALLOWED = priorGrant;
});

test("filesystem harness preserves validation, containment and file operation envelopes", () => {
  const root = mkdtempSync(join(tmpdir(), "sdk-filesystem-"));
  roots.push(root);
  const handler = makeFsRpcHandler(root);
  const call = (op: string, params?: Record<string, unknown>) => handler({ jsonrpc: "2.0", id: "call", method: `ezcorp/fs.${op}`, params });
  expect(call("read")?.error?.code).toBe(-32602);
  expect(call("read", { path: `${root}-outside` })?.error?.code).toBe(-32001);
  expect(call("write", { path: join(root, "file") })?.error?.code).toBe(-32602);
  expect(call("write", { path: join(root, "file"), content: "data" })?.result).toMatchObject({ bytes: 4 });
  expect(call("read", { path: join(root, "file") })?.result).toMatchObject({ encoding: "utf-8", body: Buffer.from("data").toString("base64"), bytes: 4 });
  expect(call("write", { path: join(root, "binary"), content: "AAE=", encoding: "binary" })?.result).toMatchObject({ bytes: 2 });
  expect(call("read", { path: join(root, "binary"), encoding: "binary" })?.result).toMatchObject({ encoding: "binary", body: "AAE=" });
  expect(call("mkdir", { path: join(root, "directory"), recursive: true })?.result).toEqual({ resolvedPath: join(root, "directory") });
  expect(call("list", { path: root })?.result).toMatchObject({ entries: expect.arrayContaining([{ name: "file", isFile: true, isDirectory: false }, { name: "directory", isFile: false, isDirectory: true }]) });
  expect(call("stat", { path: join(root, "file") })?.result).toMatchObject({ size: 4, isFile: true, isDirectory: false });
  expect(call("unlink", { path: join(root, "file") })?.result).toEqual({ resolvedPath: join(root, "file") });
  expect(call("read", { path: join(root, "file") })?.error?.code).toBe(-32000);
  expect(call("unsupported", { path: root })?.error?.code).toBe(-32601);
});

test("custom filesystem wiring can answer or fall through without losing request identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "sdk-filesystem-"));
  roots.push(root);
  let dispatch!: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  wireFsHandler({ setRequestHandler: handler => { dispatch = handler; } }, { fsRoot: root, onRequest: request => request.method === "custom" ? { jsonrpc: "2.0", id: request.id, result: "custom result" } : undefined });
  expect(await dispatch({ jsonrpc: "2.0", id: "custom-id", method: "custom" })).toMatchObject({ id: "custom-id", result: "custom result" });
  expect(await dispatch({ jsonrpc: "2.0", id: "exists", method: "ezcorp/fs.exists", params: { path: root } })).toMatchObject({ id: "exists", result: { exists: true } });
  expect(await dispatch({ jsonrpc: "2.0", id: "unknown", method: "unhandled" })).toMatchObject({ id: "unknown", error: { code: -32601 } });
});

test("in-process filesystem stub rejects unrelated host calls", async () => {
  installFsChannelStub(tmpdir());
  const request = getChannel().request;
  try {
    await expect(request("ezcorp/network.fetch", {})).rejects.toThrow("unexpected RPC method");
    expect(await request("ezcorp/fs.exists", { path: tmpdir() })).toEqual({ exists: true });
    await expect(request("ezcorp/fs.read", {})).rejects.toMatchObject({ code: -32602 });
  } finally {
    (request as typeof request & { mockRestore(): void }).mockRestore();
  }
});

test("filesystem harness environment grants are explicit and overridable", () => {
  const extensionId = `sdk-harness-${crypto.randomUUID()}`;
  const environment = buildHarnessEnv(extensionId, { filesystem: true, shell: true, network: true, permittedHosts: "example.com", projectRoot: "/project", env: { CUSTOM: "value" } });
  roots.push(environment.TMPDIR!);
  expect(environment).toMatchObject({ EZCORP_FS_ALLOWED: "1", EZCORP_SHELL_ALLOWED: "1", EZCORP_NETWORK_ALLOWED: "1", EZCORP_PERMITTED_HOSTS: "example.com", EZCORP_PROJECT_ROOT: "/project", CUSTOM: "value" });
  const restricted = buildHarnessEnv(extensionId);
  expect(restricted.EZCORP_FS_ALLOWED).toBeUndefined();
});
