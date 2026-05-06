/**
 * Integration tests for the per-extension settings injection path
 * (lazy-foraging-hammock).
 *
 * Locks in the host-side merge contract:
 *   - When the manifest declares `settings`, the host calls
 *     `resolveExtensionSettings(extensionId, userId)` and merges the
 *     result under `_meta.invocationMetadata.settings`.
 *   - When the manifest has no `settings` block, the host does NOTHING
 *     — `invocationMetadata.settings` is absent (no pollution of
 *     extensions that opt out).
 *   - Caller-supplied `invocationMetadata.settings` WINS over resolved
 *     values (per-turn overrides override the persisted defaults).
 *
 * The DB resolver is mocked at module-load time so the test runs
 * without a PGlite instance — we're testing the executor's merge
 * logic, not the resolver itself (resolver has its own coverage in
 * `src/db/queries/__tests__/extension-settings-*`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const mockResolve = mock(async (_extensionId: string, _userId: string | null) =>
  ({} as Record<string, unknown>),
);
mock.module("../db/queries/extension-settings", () => ({
  resolveExtensionSettings: (extensionId: string, userId: string | null) =>
    mockResolve(extensionId, userId),
}));

const { ToolExecutor } = await import("../extensions/tool-executor");
import type { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionManifestV2, ToolCallResult } from "../extensions/types";

interface CapturedCall {
  toolName: string;
  args: Record<string, unknown>;
  meta: Record<string, unknown> | undefined;
}

function makeFakeRegistry(
  captured: CapturedCall[],
  manifest: ExtensionManifestV2,
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
      extensionName: manifest.name,
      originalName: "speak",
      name: "speak",
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

const baseManifest: ExtensionManifestV2 = {
  schemaVersion: 2,
  name: "kokoro-tts",
  version: "0.0.1",
  description: "",
  author: { name: "t" },
  permissions: {},
  entrypoint: "./e.ts",
  tools: [{ name: "speak", description: "", inputSchema: { type: "object" } }],
} as ExtensionManifestV2;

const settingsManifest: ExtensionManifestV2 = {
  ...baseManifest,
  settings: {
    voice: {
      type: "select",
      label: "Voice",
      options: [
        { value: "af_bella", label: "Bella" },
        { value: "am_adam", label: "Adam" },
      ],
      default: "af_bella",
    },
    speed: {
      type: "number",
      label: "Speed",
      min: 0.5,
      max: 2.0,
      default: 1.0,
    },
  },
} as ExtensionManifestV2;

describe("ToolExecutor — _meta.invocationMetadata.settings injection", () => {
  let captured: CapturedCall[];

  beforeEach(() => {
    captured = [];
    mockResolve.mockClear();
  });

  afterEach(() => {
    captured = [];
  });

  test("manifest declares settings → resolver runs, settings appear under invocationMetadata", async () => {
    mockResolve.mockImplementationOnce(async () => ({
      voice: "am_adam",
      speed: 1.2,
    }));

    const execu = new ToolExecutor(makeFakeRegistry(captured, settingsManifest));
    execu.setCurrentUserId("user-1");

    await execu.executeToolCall("speak", { text: "hello" }, "conv-1", "msg-1");

    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockResolve.mock.calls[0]).toEqual(["ext-1", "user-1"]);

    const meta = captured[0]!.meta!;
    expect(meta.invocationMetadata).toEqual({
      settings: { voice: "am_adam", speed: 1.2 },
    });
  });

  test("manifest with no settings block → resolver NOT called and invocationMetadata absent", async () => {
    const execu = new ToolExecutor(makeFakeRegistry(captured, baseManifest));
    execu.setCurrentUserId("user-1");

    await execu.executeToolCall("speak", { text: "hello" }, "conv-1", "msg-1");

    expect(mockResolve).not.toHaveBeenCalled();
    const meta = captured[0]!.meta!;
    expect(meta.invocationMetadata).toBeUndefined();
  });

  test("caller-supplied invocationMetadata.settings WIN over resolved values (merge order)", async () => {
    mockResolve.mockImplementationOnce(async () => ({
      voice: "af_bella",
      speed: 1.0,
    }));

    const execu = new ToolExecutor(makeFakeRegistry(captured, settingsManifest));
    execu.setCurrentUserId("user-1");

    // Caller pre-binds an override for `voice`; resolved value should
    // fill in `speed` but NOT clobber `voice`.
    await execu.executeToolCall(
      "speak",
      { text: "hello" },
      "conv-1",
      "msg-1",
      undefined,
      { settings: { voice: "am_adam" } },
    );

    const meta = captured[0]!.meta!;
    expect(meta.invocationMetadata).toEqual({
      settings: { voice: "am_adam", speed: 1.0 },
    });
  });

  test("caller-supplied invocationMetadata.settings preserved when resolver returns {}", async () => {
    mockResolve.mockImplementationOnce(async () => ({}));

    const execu = new ToolExecutor(makeFakeRegistry(captured, settingsManifest));
    execu.setCurrentUserId("user-1");

    await execu.executeToolCall(
      "speak",
      { text: "hello" },
      "conv-1",
      "msg-1",
      undefined,
      { settings: { voice: "am_adam" } },
    );

    const meta = captured[0]!.meta!;
    expect(meta.invocationMetadata).toEqual({
      settings: { voice: "am_adam" },
    });
  });

  test("non-settings keys in caller invocationMetadata pass through alongside settings", async () => {
    mockResolve.mockImplementationOnce(async () => ({ voice: "af_bella" }));

    const execu = new ToolExecutor(makeFakeRegistry(captured, settingsManifest));
    execu.setCurrentUserId("user-1");

    await execu.executeToolCall(
      "speak",
      { text: "hello" },
      "conv-1",
      "msg-1",
      undefined,
      { toolCallId: "tc-1", parentMessageId: "msg-parent" },
    );

    const meta = captured[0]!.meta!;
    expect(meta.invocationMetadata).toEqual({
      toolCallId: "tc-1",
      parentMessageId: "msg-parent",
      settings: { voice: "af_bella" },
    });
  });

  test("resolver receives null userId when no current user is set", async () => {
    mockResolve.mockImplementationOnce(async () => ({ voice: "af_bella" }));

    const execu = new ToolExecutor(makeFakeRegistry(captured, settingsManifest));
    // No setCurrentUserId() call.

    await execu.executeToolCall("speak", { text: "hello" }, "conv-1", "msg-1");

    expect(mockResolve.mock.calls[0]).toEqual(["ext-1", null]);
  });
});
