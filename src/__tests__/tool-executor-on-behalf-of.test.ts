/**
 * Integration tests for the on-behalf-of side channel from the tool
 * executor to the extension subprocess.
 *
 * What this locks in:
 *   - `ToolExecutor.setCurrentUserId(u)` + `executeToolCall` sends
 *     `_meta.ezOnBehalfOf = u` inside the JSON-RPC `tools/call` params.
 *   - `_meta.ezConversationId` rides the same channel for diagnostics.
 *   - When no user id is set, `_meta` is omitted entirely (backward
 *     compatible wire format for extensions that don't read it).
 *   - The LLM-visible `arguments` map is NEVER mutated with the user id —
 *     the side-channel lives in `_meta`, not in `arguments`. This is the
 *     key security invariant (prompt-injection defence).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolExecutor } from "../extensions/tool-executor";
import type { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionManifestV2, ToolCallResult } from "../extensions/types";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";

// Capture every call the registry routes to a subprocess.
interface CapturedCall {
  toolName: string;
  args: Record<string, unknown>;
  meta: Record<string, unknown> | undefined;
}

function makeFakeRegistry(
  captured: CapturedCall[],
  manifest: ExtensionManifestV2 = {
    schemaVersion: 2,
    name: "ai-kit",
    version: "0.0.1",
    description: "",
    author: { name: "t" },
    permissions: {},
    entrypoint: "./e.ts",
    tools: [{ name: "my_tool", description: "", inputSchema: { type: "object" } }],
  } as ExtensionManifestV2,
): ExtensionRegistry {
  const fakeProc = {
    callTool: async (
      name: string,
      args: Record<string, unknown>,
      meta?: Record<string, unknown>,
    ): Promise<ToolCallResult> => {
      captured.push({ toolName: name, args, meta });
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
    setNotificationHandler: () => {},
    setRequestHandler: () => {},
  };
  return {
    getRegisteredTool: () => ({
      extensionId: "ext-1",
      extensionName: "ai-kit",
      originalName: "my_tool",
      name: "my_tool",
      description: "",
      inputSchema: { type: "object" },
    }),
    getManifest: () => manifest,
    getProcess: async () => fakeProc,
    getMcpClient: async () => {
      throw new Error("not an mcp ext");
    },
  } as unknown as ExtensionRegistry;
}

describe("ToolExecutor — _meta.ezOnBehalfOf side channel", () => {
  let captured: CapturedCall[];
  let execu: ToolExecutor;

  beforeEach(() => {
    captured = [];
    execu = new ToolExecutor(makeFakeRegistry(captured), createStubPermissionEngine());
  });

  afterEach(() => {
    captured = [];
  });

  test("with currentUserId set, _meta.ezOnBehalfOf carries that id", async () => {
    execu.setCurrentUserId("geff");
    await execu.executeToolCall("my_tool", { foo: "bar" }, "conv-1", "msg-1");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.meta?.["ezOnBehalfOf"]).toBe("geff");
  });

  test("_meta.ezConversationId also rides the side channel (diagnostics)", async () => {
    execu.setCurrentUserId("geff");
    await execu.executeToolCall("my_tool", {}, "conv-42", "msg-1");
    expect(captured[0]!.meta?.["ezConversationId"]).toBe("conv-42");
  });

  test("LLM-visible args are NOT mutated with the user id (prompt-injection defence)", async () => {
    execu.setCurrentUserId("geff");
    const input = { userQuery: "hello" };
    await execu.executeToolCall("my_tool", input, "conv-1", "msg-1");
    // args must contain only what the LLM sent; the user id lives
    // exclusively in _meta.
    expect(captured[0]!.args).toEqual({ userQuery: "hello" });
    expect(captured[0]!.args["ezOnBehalfOf"]).toBeUndefined();
    expect(captured[0]!.args["_meta"]).toBeUndefined();
  });

  test("without currentUserId, meta is still sent but ezOnBehalfOf is absent", async () => {
    await execu.executeToolCall("my_tool", {}, "conv-1", "msg-1");
    // conversationId always rides meta since it's server-provided context.
    expect(captured[0]!.meta?.["ezOnBehalfOf"]).toBeUndefined();
    expect(captured[0]!.meta?.["ezConversationId"]).toBe("conv-1");
  });

  test("setCurrentModel + setCurrentProvider populate ezModel / ezProvider in meta", async () => {
    execu.setCurrentUserId("geff");
    execu.setCurrentModel("claude-sonnet-4-6");
    execu.setCurrentProvider("anthropic");
    await execu.executeToolCall("my_tool", {}, "conv-1", "msg-1");
    expect(captured[0]!.meta?.["ezModel"]).toBe("claude-sonnet-4-6");
    expect(captured[0]!.meta?.["ezProvider"]).toBe("anthropic");
  });

  test("setCurrentModel reflects the LAST value set (per-turn override wins)", async () => {
    // Regression: the executor used to pass convRecord.model (stored at
    // conversation-create time) instead of options.model (the model the
    // user just selected in the UI for this turn). The per-turn value
    // MUST win — that's what setCurrentModel's last-write-wins semantics
    // give us. This test pins the behavior so a future refactor doesn't
    // accidentally revert to reading a stale conversation default.
    execu.setCurrentModel("claude-haiku-4-5"); // conv default
    execu.setCurrentModel("claude-opus-4-1"); // user picked a different model this turn
    await execu.executeToolCall("my_tool", {}, "conv-1", "msg-1");
    expect(captured[0]!.meta?.["ezModel"]).toBe("claude-opus-4-1");
  });

  test("null/undefined model + provider are NOT emitted as meta fields", async () => {
    execu.setCurrentUserId("geff");
    execu.setCurrentModel(null);
    execu.setCurrentProvider(undefined);
    await execu.executeToolCall("my_tool", {}, "conv-1", "msg-1");
    expect(captured[0]!.meta?.["ezModel"]).toBeUndefined();
    expect(captured[0]!.meta?.["ezProvider"]).toBeUndefined();
    // User id is still present — the fields are independent.
    expect(captured[0]!.meta?.["ezOnBehalfOf"]).toBe("geff");
  });

  test("clearing currentUserId (new instance) removes it from meta", async () => {
    execu.setCurrentUserId("geff");
    await execu.executeToolCall("my_tool", {}, "conv-1", "msg-1");
    expect(captured[0]!.meta?.["ezOnBehalfOf"]).toBe("geff");

    // New executor instance (simulates a fresh run for a different conv)
    const captured2: CapturedCall[] = [];
    const execu2 = new ToolExecutor(makeFakeRegistry(captured2), createStubPermissionEngine());
    await execu2.executeToolCall("my_tool", {}, "conv-2", "msg-2");
    expect(captured2[0]!.meta?.["ezOnBehalfOf"]).toBeUndefined();
  });

  test("EZCORP_PUBLIC_URL env var is forwarded as meta.ezPublicUrl", async () => {
    // ai-kit's MCP tools read this to build clickable deep-links in tool
    // responses — without the env var the field is absent and the tool
    // falls back to its own baseUrl (loopback in the bundled case).
    const prev = process.env.EZCORP_PUBLIC_URL;
    process.env.EZCORP_PUBLIC_URL = "https://ezcorp.example.com";
    try {
      await execu.executeToolCall("my_tool", {}, "conv-1", "msg-1");
      expect(captured[0]!.meta?.["ezPublicUrl"]).toBe("https://ezcorp.example.com");
    } finally {
      if (prev === undefined) delete process.env.EZCORP_PUBLIC_URL;
      else process.env.EZCORP_PUBLIC_URL = prev;
    }
  });

  test("without EZCORP_PUBLIC_URL, ezPublicUrl is absent from meta", async () => {
    const prev = process.env.EZCORP_PUBLIC_URL;
    delete process.env.EZCORP_PUBLIC_URL;
    try {
      await execu.executeToolCall("my_tool", {}, "conv-1", "msg-1");
      expect(captured[0]!.meta?.["ezPublicUrl"]).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.EZCORP_PUBLIC_URL = prev;
    }
  });
});
