/**
 * Ez concierge → bundled `extension-author` wiring (setup-tools.ts).
 *
 * Two layers, tested independently:
 *
 *   1. The pure helpers `buildExtensionToolExecutor` (per-turn ToolExecutor
 *      construction, shared with the scratchpad auto-wire) and
 *      `wireExtensionToolsIntoTurn` (push-deduped tool loop). No mocks —
 *      real ToolExecutor + a fake registry.
 *
 *   2. The gate `wireExtensionAuthorToolsIfEz`, mirroring the
 *      wireBriefing* gate contract: positive (kind='ez' + enabled ext →
 *      tools wired), negatives (non-ez turn; extension missing; extension
 *      disabled), and fail-soft (a throwing dependency degrades to a
 *      tool-less turn, never throws into setupTools). Mocks the two
 *      dynamically-imported seams (getExtensionByName + ExtensionRegistry).
 */
import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ≥2-mocks rule: snapshot the real exports, re-register them in afterAll.
const realExtQueries = { ...(await import("../db/queries/extensions")) };
const realRegistry = { ...(await import("../extensions/registry")) };

/** Per-test stubs served by the mocked seams. */
let stubExtension: { id: string; enabled: boolean } | null = { id: "ext-author-1", enabled: true };
let stubThrows = false;
let stubTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  { name: "extension-author__create_extension", description: "scaffold", inputSchema: { type: "object" } },
];

const fakeRegistryInstance = {
  getToolsForExtension: (_id: string) => stubTools,
};

mock.module("../db/queries/extensions", () => ({
  ...realExtQueries,
  getExtensionByName: async (_name: string) => {
    if (stubThrows) throw new Error("db unavailable");
    return stubExtension;
  },
}));
mock.module("../extensions/registry", () => ({
  ...realRegistry,
  ExtensionRegistry: { getInstance: () => fakeRegistryInstance },
}));

import { ToolExecutor } from "../extensions/tool-executor";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import type { SetupToolsConvRecord, SetupToolsOptions } from "../runtime/stream-chat/setup-tools";
import {
  buildExtensionToolExecutor,
  wireExtensionToolsIntoTurn,
  wireExtensionAuthorToolsIfEz,
} from "../runtime/stream-chat/setup-tools";

afterAll(() => {
  mock.module("../db/queries/extensions", () => realExtQueries);
  mock.module("../extensions/registry", () => realRegistry);
  restoreModuleMocks();
});

beforeEach(() => {
  stubExtension = { id: "ext-author-1", enabled: true };
  stubThrows = false;
  stubTools = [
    { name: "extension-author__create_extension", description: "scaffold", inputSchema: { type: "object" } },
  ];
});

/** Minimal host that satisfies the ToolExecutor construction path without a
 *  live runtime. permissionEngine is truthy (ToolExecutor fails closed on a
 *  missing engine); bus is omitted so the constructor skips its
 *  subscriptions. */
function fakeHost(overrides: Partial<StreamChatHost> = {}): StreamChatHost {
  return {
    permissionEngine: {},
    bus: undefined,
    stateMediator: undefined,
    executor: undefined,
    spawnQuota: undefined,
    pendingPermissions: new Map(),
    ...overrides,
  } as unknown as StreamChatHost;
}

describe("wireExtensionToolsIntoTurn (pure loop)", () => {
  test("pushes each registered tool and returns the count", () => {
    const agentTools: AgentTool[] = [];
    const wired = wireExtensionToolsIntoTurn({
      agentTools,
      registry: { getToolsForExtension: () => stubTools },
      toolExec: {} as unknown as ToolExecutor,
      extensionId: "ext-author-1",
      conversationId: "conv-1",
      runId: "run-1",
    });
    expect(wired).toBe(1);
    expect(agentTools.map((t) => t.name)).toEqual(["extension-author__create_extension"]);
  });

  test("dedupes against a tool already present by name", () => {
    const agentTools: AgentTool[] = [{ name: "extension-author__create_extension" } as unknown as AgentTool];
    const wired = wireExtensionToolsIntoTurn({
      agentTools,
      registry: {
        getToolsForExtension: () => [
          { name: "extension-author__create_extension", description: "d", inputSchema: {} },
          { name: "extension-author__validate_extension", description: "d", inputSchema: {} },
        ],
      },
      toolExec: {} as unknown as ToolExecutor,
      extensionId: "ext-author-1",
      conversationId: "conv-1",
      runId: "run-1",
    });
    expect(wired).toBe(1); // only validate added; create already present
    expect(agentTools).toHaveLength(2);
  });
});

describe("buildExtensionToolExecutor (shared ToolExecutor builder)", () => {
  test("returns a ToolExecutor with all host context threaded (every branch body run)", () => {
    const toolExec = buildExtensionToolExecutor(
      fakeRegistryInstance as never,
      // truthy stateMediator/executor/spawnQuota so those setter lines run
      fakeHost({ stateMediator: {} as never, executor: {} as never, spawnQuota: {} as never }),
      // truthy args-resolver → setArgsResolver body runs
      (async (input: Record<string, unknown>) => input) as never,
      // convRecord.userId set → setCurrentUserId body runs
      { userId: "u-1", model: null, provider: null, kind: "ez" } as SetupToolsConvRecord,
      { model: "m", provider: "p", agentConfigId: "a" } as SetupToolsOptions,
    );
    expect(toolExec).toBeInstanceOf(ToolExecutor);
  });
});

describe("wireExtensionAuthorToolsIfEz — gate", () => {
  function baseArgs(convRecord: SetupToolsConvRecord | null) {
    return {
      agentTools: [] as AgentTool[],
      conversationId: "conv-ez",
      runId: "run-ez",
      convRecord,
      host: fakeHost(),
      options: {} as SetupToolsOptions,
      attachmentArgsResolver: null,
    };
  }

  test("POSITIVE: kind='ez' + enabled extension → tool wired into agentTools", async () => {
    const args = baseArgs({ userId: "u", model: null, provider: null, kind: "ez" });
    await wireExtensionAuthorToolsIfEz(args);
    expect(args.agentTools.map((t) => t.name)).toEqual(["extension-author__create_extension"]);
  });

  test("NEGATIVE: a non-ez conversation is a no-op (returns before touching the DB)", async () => {
    const args = baseArgs({ userId: "u", model: null, provider: null, kind: "regular" });
    await wireExtensionAuthorToolsIfEz(args);
    expect(args.agentTools).toHaveLength(0);
  });

  test("NEGATIVE: a null convRecord is a no-op", async () => {
    const args = baseArgs(null);
    await wireExtensionAuthorToolsIfEz(args);
    expect(args.agentTools).toHaveLength(0);
  });

  test("NEGATIVE: extension not installed (lookup null) → skip, no tools", async () => {
    stubExtension = null;
    const args = baseArgs({ userId: "u", model: null, provider: null, kind: "ez" });
    await wireExtensionAuthorToolsIfEz(args);
    expect(args.agentTools).toHaveLength(0);
  });

  test("NEGATIVE: extension disabled → skip, no tools", async () => {
    stubExtension = { id: "ext-author-1", enabled: false };
    const args = baseArgs({ userId: "u", model: null, provider: null, kind: "ez" });
    await wireExtensionAuthorToolsIfEz(args);
    expect(args.agentTools).toHaveLength(0);
  });

  test("FAIL-SOFT: a throwing lookup degrades to a tool-less turn, never throws", async () => {
    stubThrows = true;
    const args = baseArgs({ userId: "u", model: null, provider: null, kind: "ez" });
    await expect(wireExtensionAuthorToolsIfEz(args)).resolves.toBeUndefined();
    expect(args.agentTools).toHaveLength(0);
  });

  test("REGRESSION GUARD: the Ez branch of setupTools invokes the extension-author gate", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dir, "..", "runtime", "stream-chat", "setup-tools.ts"),
      "utf-8",
    );
    expect(src).toContain("await wireExtensionAuthorToolsIfEz({");
  });
});
