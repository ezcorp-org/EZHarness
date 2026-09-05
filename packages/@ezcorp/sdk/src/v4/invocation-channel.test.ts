import { expect, test } from "bun:test";
import { defineExtension, validateManifest, type ExtensionContext } from "./index";
import { getChannel, type HostChannel } from "../runtime/channel";
import { getToolContext } from "../runtime/tool-context";
import { Storage } from "../runtime/storage";

function context(call: ExtensionContext["call"]): ExtensionContext {
  return { invocation: { invocationId: "call", workerId: "worker", releaseId: "release", principalId: "owner", scopeId: "project", token: "token", deadline: Date.now() + 5000, metadata: { ezConversationId: "conversation" } }, signal: new AbortController().signal, call };
}

test("pure definitions use scoped helpers and reject retained channels after completion", async () => {
  let captured!: HostChannel;
  const calls: Array<{ method: string; input: unknown }> = [];
  const manifest = validateManifest({ schemaVersion: 4, name: "pure", version: "1.0.0", description: "Pure helpers", author: { name: "Test" }, permissions: {}, tools: [{ name: "check", description: "Check", inputSchema: {}, outputSchema: { type: "integer" } }] });
  const extension = defineExtension({ manifest, tools: { check: async () => {
    captured = getChannel();
    captured.start();
    captured.stop();
    expect(() => captured.onRequest("late", () => null)).toThrow("before serving");
    expect(getToolContext()).toMatchObject({ extensionName: "pure", toolName: "check", conversationId: "conversation", projectRoot: "/project", callId: "token" });
    await new Storage().get("counter");
    await captured.request("ezcorp/fs.read", { path: ".ezcorp/extension-data/pure/file" });
    captured.notify("ezcorp/state", {});
    return 1;
  } } });
  expect(await extension.invoke("check", {}, context(async (method, input) => { calls.push({ method, input }); return { value: 0, exists: true }; }))).toBe(1);
  expect(calls.map(call => call.method)).toEqual(["ezcorp/storage", "ezcorp/fs.read", "ezcorp/state"]);
  expect(calls[1]?.input).toEqual({ path: "/data/file" });
  await expect(captured.request("ezcorp/storage", {})).rejects.toThrow("active invocation");
  expect(() => captured.notify("ezcorp/state", {})).toThrow("active invocation");
});

test("pure definition notification failure rejects the invocation rather than racing its teardown", async () => {
  const manifest = validateManifest({ schemaVersion: 4, name: "pure", version: "1.0.0", description: "Pure helpers", author: { name: "Test" }, permissions: {}, methods: [{ name: "notify", inputSchema: {}, outputSchema: {} }] });
  const extension = defineExtension({ manifest, methods: { notify: { inputSchema: {}, outputSchema: {}, handle: () => { getChannel().notify("ezcorp/state", {}); return null; } } } });
  await expect(extension.dispatch("notify", {}, context(async () => { throw new Error("notification denied"); }))).rejects.toThrow("notification denied");
});
