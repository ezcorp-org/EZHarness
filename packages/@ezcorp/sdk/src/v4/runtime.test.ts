import { afterEach, expect, test } from "bun:test";
import { createRuntimeExtension, createSession, unwrapToolResponse } from "./index";
import { getChannel, __resetChannelForTests } from "../runtime/channel";
import { createToolDispatcher } from "../runtime/rpc";
import { findProjectRoot, getExtensionDataDir } from "../runtime/fs";

afterEach(__resetChannelForTests);

test("filesystem paths use project and own data virtual roots", async () => {
  const paths: unknown[] = [];
  const extension = await createRuntimeExtension({ manifest: { schemaVersion: 4, name: "files", version: "1.0.0", description: "Files", author: { name: "Test" }, permissions: {} }, register() {
    getChannel().onRequest("files/check", async () => {
      expect(findProjectRoot()).toBe("/project");
      expect(getExtensionDataDir("files")).toBe("/data");
      expect(() => getExtensionDataDir("other")).toThrow("namespace");
      for (const path of ["notes/a", ".ezcorp/extension-data/files/a", ".ezcorp/extension-data/other/a", "/data/a"]) await getChannel().request("ezcorp/fs.stat", { path });
      for (const path of ["../escape", "bad\\path", "bad\0path"]) await expect(getChannel().request("ezcorp/fs.stat", { path })).rejects.toThrow("Invalid virtual");
      return null;
    });
  } });
  await extension.dispatch("files/check", {}, { invocation: { invocationId: "files", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 5000 }, signal: new AbortController().signal, call: async (_method, input) => { paths.push(input); return null; } });
  expect(paths).toEqual([{ path: "/project/notes/a" }, { path: "/data/a" }, { path: "/project/.ezcorp/extension-data/other/a" }, { path: "/data/a" }]);
});

test("runtime vocabulary uses invocation-bound host calls without starting legacy transport", async () => {
  const results: any[] = [];
  let session: ReturnType<typeof createSession>;
  const extension = await createRuntimeExtension({
    manifest: { schemaVersion: 4, name: "runtime", version: "1.0.0", description: "Runtime", author: { name: "Test" }, permissions: { storage: true }, tools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }] },
    register() {
      getChannel().start();
      createToolDispatcher({ read: async () => ({ content: [{ type: "text", text: await getChannel().request<string>("ezcorp/storage-get", { key: "greeting" }) }], isError: false }) });
      getChannel().onRequest("page/render", () => ({ title: "Page" }));
    },
  });
  await expect(getChannel().request("ezcorp/storage-get", {})).rejects.toThrow("active invocation");
  expect(extension.manifest.methods?.map(method => method.name)).toEqual(["page/render"]);
  session = createSession(extension, async frame => {
    const message = JSON.parse(frame);
    results.push(message);
    if (message.method) await session.receive({ jsonrpc: "2.0", id: message.id, result: "Hello" });
  });
  const context = { invocationId: "read", workerId: "worker", releaseId: "release", principalId: "alice", scopeId: "conversation", token: "token", deadline: Date.now() + 5000 };
  await session.receive({ jsonrpc: "2.0", id: "read", method: "extension/invoke", params: { name: "read", input: {}, context } });
  expect(results[0].params.context).toEqual(context);
  expect(results.at(-1).result.content[0].text).toBe("Hello");
  expect(() => getChannel().onRequest("new/method", () => null)).toThrow("registered before");
  session.close();
});

test("registration failures restore the adapter and tool envelopes reject errors", async () => {
  expect(unwrapToolResponse({ result: { content: [] } })).toEqual({ content: [] });
  for (const response of [null, [], {}, { error: { message: "failed" } }]) expect(() => unwrapToolResponse(response)).toThrow();
  const manifest = { schemaVersion: 4, name: "registration", version: "1.0.0", description: "Registration", author: { name: "Test" }, permissions: {} };
  await expect(createRuntimeExtension({ manifest, register() { getChannel().notify("ezcorp/state", {}); } })).rejects.toThrow("active invocation");
  await expect(createRuntimeExtension({ manifest, register() { getChannel().onRequest("page/render", () => null); getChannel().onRequest("page/render", () => null); } })).rejects.toThrow("already registered");
  const extension = await createRuntimeExtension({ manifest, register() { getChannel().onRequest("event/changed", () => { getChannel().notify("ezcorp/state", {}); }); } });
  let calls = 0;
  const result = await extension.dispatch("event/changed", {}, { invocation: { invocationId: "event", workerId: "worker", releaseId: "release", principalId: "alice", scopeId: "project", token: "token", deadline: Date.now() + 1000 }, signal: new AbortController().signal, call: async () => { calls++; throw new Error("denied"); } });
  expect(result).toBeNull();
  expect(calls).toBe(1);
});
