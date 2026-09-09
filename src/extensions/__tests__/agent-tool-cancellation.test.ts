import { expect, test } from "bun:test";
import { validateManifest } from "@ezcorp/extension-contract";
import { extensionToAgentTool } from "../tool-executor/agent-tool";
import type { ExecuteToolCall } from "../tool-executor/errors";
import { ReleaseProcess } from "../release-process";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import { releaseRuntimeFixture } from "../../__tests__/helpers/release-runtime";

const definition = { name: "echo", dispatchName: "fixture__echo", description: "Echo", inputSchema: { type: "object" } };

for (const signalled of [false, true]) test(`agent wrapper preserves metadata and ${signalled ? "forwards" : "omits"} the caller signal`, async () => {
  const calls: Parameters<ExecuteToolCall>[] = [];
  const controller = new AbortController();
  const tool = extensionToAgentTool(definition, { executeToolCall: async (...args) => { calls.push(args); return { content: [{ type: "text", text: "result" }], isError: false }; } }, "conversation", null, undefined, { project: "selected", toolCallId: "not-authoritative" });
  expect(await tool.execute("host-call", { value: "input" }, signalled ? controller.signal : undefined)).toEqual({ content: [{ type: "text", text: "result" }], details: { isError: false } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(["fixture__echo", { value: "input" }, "conversation", null, { metadata: { invocationId: "host-call" }, ...(signalled ? { signal: controller.signal } : {}) }, { project: "selected", toolCallId: "host-call" }]);
});

test("pre-aborted agent tools cannot dispatch to an executor", async () => {
  let calls = 0;
  const tool = extensionToAgentTool(definition, { executeToolCall: async () => { calls++; return { content: [], isError: false }; } }, "conversation", null);
  await expect(tool.execute("host-call", {}, AbortSignal.abort(new Error("turn cancelled")))).rejects.toThrow("turn cancelled");
  expect(calls).toBe(0);
});

test("late executor success after cancellation is not reported or replayed", async () => {
  const controller = new AbortController();
  let calls = 0;
  const tool = extensionToAgentTool(definition, { executeToolCall: async () => {
    calls++;
    controller.abort(new Error("turn cancelled during tool"));
    return { content: [{ type: "text", text: "completed effect" }], isError: false };
  } }, "conversation", null);
  await expect(tool.execute("host-call", {}, controller.signal)).rejects.toThrow("turn cancelled during tool");
  expect(calls).toBe(1);
});

test("agent tool cancellation reaches the release worker while invocation is pending", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const controller = new AbortController();
  const manifest = validateManifest({ schemaVersion: 4, name: "fixture", version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions: {}, tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] });
  const runtime = releaseRuntimeFixture("installation", manifest, { invoke: async () => { entered.resolve(); await resume.promise; return { content: [], isError: false }; } });
  const process = new ReleaseProcess("installation", { runner: async () => runtime.runner, resolve: async () => runtime.snapshot });
  const token = registerCallProvenance({ actorExtensionId: "installation", onBehalfOf: "fixture-owner", conversationId: "conversation", ownerless: false, runId: null, parentCallId: null, kind: "tool" });
  let forwardedSignal: AbortSignal | undefined;
  const tool = extensionToAgentTool(definition, { executeToolCall: async (_name, input, _conversation, _message, options) => { forwardedSignal = options?.signal; return process.callTool("echo", input, { ezCallId: token }, options); } }, "conversation", null);
  try {
    const pending = tool.execute("host-call", {}, controller.signal);
    void pending.catch(() => undefined);
    await entered.promise;
    expect(forwardedSignal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(runtime.calls).toHaveLength(1);
    expect(process.inFlightCallCount).toBe(0);
  } finally { resume.resolve(); process.kill(); releaseCallProvenance(token); }
});
