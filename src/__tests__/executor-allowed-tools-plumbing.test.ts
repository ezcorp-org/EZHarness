/**
 * Phase 48 Wave 1 — Executor mode-lookup → applyToolFilters plumbing.
 * Daily Briefing Phase 3 — invocation-level `readOnlyAllowedTools` plumbing.
 *
 * The executor's mode-restriction block (src/runtime/executor.ts) reads
 * `mode.allowedTools` alongside `mode.toolRestriction` and forwards both
 * into applyToolFilters; the invocation-level block right below it
 * forwards `options.readOnlyAllowedTools` (the briefing pipeline's
 * read-safe web-search vouch). The contract is covered from three
 * complementary angles:
 *
 *   1. STATIC: the executor source contains both plumbing patterns. If
 *      anyone refactors those blocks and drops `mode.allowedTools` or
 *      `options.readOnlyAllowedTools` from the applyToolFilters call,
 *      the regex catches it.
 *
 *   2. BEHAVIORAL (filter): feed applyToolFilters the exact input the
 *      executor would (a fake mode with allowlist=[a]) and verify tool
 *      `b` is filtered out.
 *
 *   3. BEHAVIORAL (streamChat, end-to-end): drive the REAL
 *      AgentExecutor.streamChat with `toolRestriction:"read-only"` +
 *      `readOnlyAllowedTools:["web-search__search-web"]` and capture
 *      the toolset that reaches the pi-agent. The vouched extension
 *      tool must SURVIVE while a write-category builtin is STRIPPED —
 *      deleting the `readOnlyAllowedTools` forward from executor.ts
 *      fails this test (the coverage-audit must-fix).
 *
 * Together these pin the must-haves: "tool call to an unlisted tool from
 * an Ez-mode conversation is rejected" and "the briefing's read-only
 * escape hatch admits exactly the host-vouched names".
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentEvents } from "../types";
import type { BuiltinToolDef } from "../runtime/tools/types";
import { applyToolFilters } from "../runtime/tools/filter";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupPiAiMocks, stubAssistantMessage, resetMockAgent } from "./helpers/mock-pi-ai";

function tool(name: string): AgentTool {
  return { name } as unknown as AgentTool;
}

function def(name: string, category: BuiltinToolDef["category"]): BuiltinToolDef {
  return { name, category } as unknown as BuiltinToolDef;
}

// ── streamChat harness mocks (mirrors executor-streamchat.test.ts) ──
// All targets are snapshotted in helpers/mock-cleanup.ts MODULE_PATHS,
// so the afterAll restoreModuleMocks() re-registers the real modules.

const realBriefingChatTools = { ...(await import("../runtime/briefing/chat-tools")) };

/** Tool names the pi-agent actually received on the last streamChat. */
let capturedToolNames: string[] = [];

/**
 * The briefing chat-tools wire is the injection seam: it runs inside
 * setupTools for every owned non-briefing conversation and receives the
 * per-call `agentTools` + `builtinToolDefsMap`, BEFORE the executor's
 * invocation-level applyToolFilters. We use it to plant a toolset with
 * a vouchable extension tool (no builtin def) plus read/write builtins.
 */
function fakeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `test ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as unknown as AgentTool;
}

function registerHarnessMocks() {
  mock.module("../db/connection", () => ({
    getDb: () => ({
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: async () => ({}) }) }),
      delete: () => ({ where: async () => ({}) }),
    }),
    getPglite: () => null,
    getDbPath: () => ":memory:",
    initDb: async () => {},
    closeDb: async () => {},
  }));
  mock.module("../db/queries/conversations", () => ({
    // userId present → the briefing chat-tools wire (our seam) is
    // eligible; agentConfigId absent → the 2b agent-extension path
    // (which REPLACES ctx.agentTools) stays off.
    getConversation: async () => ({
      id: "conv-1",
      projectId: null,
      parentConversationId: null,
      userId: "user-1",
    }),
    getConversationPath: async () => [],
    getLatestLeaf: async () => null,
    resolveSystemPrompt: async () => undefined,
    createConversation: async () => ({ id: "test" }),
    createMessage: async () => ({ id: "msg-1" }),
    getMessages: async () => [],
  }));
  mock.module("../db/queries/active-runs", () => ({
    createActiveRun: async () => {},
    deleteActiveRun: async () => {},
    getActiveRuns: async () => [],
    cleanupOrphanedRuns: async () => {},
    updateHeartbeat: async () => {},
    updatePartialResponse: async () => {},
    markInterrupted: async () => {},
  }));
  mock.module("../db/queries/runs", () => ({
    insertRun: async () => {},
    updateRun: async () => {},
    insertLog: async () => {},
    listRuns: async () => [],
    getRunWithLogs: async () => null,
    toAgentRun: (r: unknown) => r,
  }));
  mock.module("../db/queries/projects", () => ({
    getProject: async () => undefined,
  }));
  mock.module("../db/queries/settings", () => ({
    getAllSettings: async () => ({}),
    getSetting: async () => undefined,
    upsertSetting: async () => {},
    deleteSetting: async () => false,
    isListingInstalled: async () => false,
  }));
  mock.module("../db/queries/agent-configs", () => ({
    listAgentConfigs: async () => [],
    getAgentConfig: async () => null,
    getAgentConfigByName: async () => null,
    getAgentConfigsByIds: async () => new Map(),
    getAgentConfigsByNames: async () => new Map(),
  }));
  mock.module("../db/queries/conversation-extensions", () => ({
    getConversationExtensionIds: async () => [],
    addConversationExtensions: async () => {},
  }));
  mock.module("../db/queries/extensions", () => ({
    getExtensionByName: async () => null,
    getExtensionsByNames: async () => new Map(),
  }));
  mock.module("../extensions/registry", () => ({
    ExtensionRegistry: {
      getInstance: () => ({
        getToolsForAgent: async () => [],
        getToolsForExtension: () => [],
      }),
    },
  }));
  mock.module("../extensions/tool-executor", () => ({
    MAX_TOOL_CALLS_PER_TURN: 10,
    ToolExecutor: class {
      createToolsContext() {
        return { invoke: async () => ({}) };
      }
      setPermissionChecker() {}
      async executeToolCall() {
        return { content: [{ text: "result" }] };
      }
    },
  }));
  mock.module("../extensions/permissions", () => ({
    checkSensitiveConfirmation: async () => "allowed",
  }));
  mock.module("../observability/collector", () => ({
    startCollector: () => () => {},
  }));
  mock.module("../runtime/briefing/chat-tools", () => ({
    ...realBriefingChatTools,
    wireBriefingChatToolsForTurn: (args: {
      agentTools: AgentTool[];
      builtinToolDefsMap: Map<string, BuiltinToolDef>;
    }) => {
      // Extension tool: present in agentTools, ABSENT from the builtin
      // def map (extension tools carry no category) — only a vouch can
      // carry it through `toolRestriction: 'read-only'`.
      args.agentTools.push(fakeTool("web-search__search-web"));
      args.agentTools.push(fakeTool("read_file"));
      args.builtinToolDefsMap.set("read_file", def("read_file", "read"));
      args.agentTools.push(fakeTool("write_file"));
      args.builtinToolDefsMap.set("write_file", def("write_file", "write"));
    },
  }));

  // Router / credentials / pi-ai defaults, then override the pi-agent
  // mock with a constructor that captures the FILTERED toolset.
  setupPiAiMocks({ textChunks: ["ok"] });
  mock.module("@earendil-works/pi-agent-core", () => ({
    Agent: class CapturingMockAgent {
      state = { error: null };
      private _subs: Array<(e: unknown) => void> = [];
      constructor(opts: { initialState?: { tools?: Array<{ name: string }> } }) {
        capturedToolNames = (opts?.initialState?.tools ?? []).map((t) => t.name);
      }
      subscribe(cb: (e: unknown) => void) {
        this._subs.push(cb);
        return () => {};
      }
      abort() {}
      async prompt() {
        for (const sub of this._subs) {
          sub({ type: "turn_end", message: stubAssistantMessage("ok") });
        }
      }
    },
  }));
}

registerHarnessMocks();

// ── Import subjects after mocks ─────────────────────────────────────

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";

beforeEach(() => {
  capturedToolNames = [];
  registerHarnessMocks();
});

afterAll(() => {
  mock.module("../runtime/briefing/chat-tools", () => realBriefingChatTools);
  resetMockAgent();
  restoreModuleMocks();
});

describe("executor → applyToolFilters plumbing for mode.allowedTools", () => {
  test("STATIC: executor.ts routes getMode through computeModeToolScope into applyToolFilters", () => {
    // The mode-restriction plumbing was extracted into
    // src/runtime/tools/mode-tool-scope.ts (shared with the /api/tools
    // listing endpoint so the header badge can't drift from the runtime
    // surface). The static pin now spans both files: the executor must
    // feed the getMode result through computeModeToolScope and apply the
    // returned scope; the scope module must forward mode.allowedTools
    // alongside mode.toolRestriction in its legacy fallback.
    const executorSrc = readFileSync(
      join(import.meta.dir, "..", "runtime", "executor.ts"),
      "utf-8",
    );
    expect(executorSrc).toContain("applyToolFilters");
    expect(executorSrc).toContain("getMode");
    expect(/computeModeToolScope\(\s*mode/.test(executorSrc)).toBe(true);
    expect(/applyToolFilters\(ctx\.agentTools,\s*ctx\.builtinToolDefsMap,\s*scope\)/.test(executorSrc)).toBe(true);

    const scopeSrc = readFileSync(
      join(import.meta.dir, "..", "runtime", "tools", "mode-tool-scope.ts"),
      "utf-8",
    );
    expect(/toolRestriction:\s*mode\.toolRestriction[\s\S]*?allowedTools:\s*mode\.allowedTools/.test(scopeSrc))
      .toBe(true);
  });

  test("STATIC: the invocation-level block forwards options.readOnlyAllowedTools alongside the other option filters", () => {
    const executorSrc = readFileSync(
      join(import.meta.dir, "..", "runtime", "executor.ts"),
      "utf-8",
    );
    expect(
      /toolRestriction:\s*options\.toolRestriction[\s\S]*?readOnlyAllowedTools:\s*options\.readOnlyAllowedTools/.test(
        executorSrc,
      ),
    ).toBe(true);
  });

  test("BEHAVIORAL: a fake mode with allowlist=[a] drops tool 'b' through the filter", () => {
    const tools: AgentTool[] = [tool("a"), tool("b"), tool("invoke_agent")];
    const builtinDefs = new Map<string, BuiltinToolDef>([
      ["a", def("a", "write")],
      ["b", def("b", "write")],
    ]);
    // Simulate: getMode returned { toolRestriction: 'allowlist', allowedTools: ['a'] }.
    const filtered = applyToolFilters(tools, builtinDefs, {
      toolRestriction: "allowlist",
      allowedTools: ["a"],
    });
    const names = filtered.map((t) => t.name).sort();
    // 'a' survived (allowlisted), 'b' did not (excluded), invoke_agent
    // is preserved as orchestration.
    expect(names).toEqual(["a", "invoke_agent"]);
    expect(names.includes("b")).toBe(false);
  });

  test("BEHAVIORAL: mode with NULL allowedTools but restriction='allowlist' is fail-closed", () => {
    // A mode row that was created with restriction='allowlist' but never
    // had its allowedTools populated MUST NOT pass the toolset through.
    // This is the safety property the executor relies on if mode storage
    // ever drifts (e.g., a buggy migration).
    const tools: AgentTool[] = [tool("a"), tool("b"), tool("invoke_agent")];
    const builtinDefs = new Map<string, BuiltinToolDef>([
      ["a", def("a", "write")],
      ["b", def("b", "write")],
    ]);
    const filtered = applyToolFilters(tools, builtinDefs, {
      toolRestriction: "allowlist",
      // mode.allowedTools is null in DB → undefined here after `?? undefined`.
      allowedTools: undefined,
    });
    expect(filtered.map((t) => t.name)).toEqual(["invoke_agent"]);
  });
});

describe("executor → applyToolFilters plumbing for options.readOnlyAllowedTools (streamChat, end-to-end)", () => {
  test("BEHAVIORAL: the vouched web-search tool SURVIVES a read-only run; a write builtin is STRIPPED", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const run = await exec.streamChat("conv-vouch", "Hi", {
      toolRestriction: "read-only",
      readOnlyAllowedTools: ["web-search__search-web"],
    });

    expect(run.status).toBe("success");
    // The wire planted all three tools; the filter must let the vouched
    // extension tool + the read builtin through and drop the write builtin.
    expect(capturedToolNames).toContain("web-search__search-web");
    expect(capturedToolNames).toContain("read_file");
    expect(capturedToolNames).not.toContain("write_file");
  });

  test("BEHAVIORAL control: WITHOUT the vouch, the same read-only run strips the extension tool too", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const run = await exec.streamChat("conv-no-vouch", "Hi", {
      toolRestriction: "read-only",
    });

    expect(run.status).toBe("success");
    // Extension tools carry no builtin category — without the vouch the
    // read-only restriction is fail-closed for them.
    expect(capturedToolNames).not.toContain("web-search__search-web");
    expect(capturedToolNames).not.toContain("write_file");
    expect(capturedToolNames).toContain("read_file");
  });
});

describe("Ez turn → extension-author wire (streamChat, end-to-end)", () => {
  test("BEHAVIORAL: a kind='ez' conversation's toolset carries the Ez tools AND extension-author__create_extension", async () => {
    // kind:'ez' flips setup-tools' Ez branch on: wireEzToolsForTurn plus
    // the wireExtensionAuthorToolsIfEz call site right after it.
    mock.module("../db/queries/conversations", () => ({
      getConversation: async () => ({
        id: "conv-ez",
        projectId: null,
        parentConversationId: null,
        userId: "user-1",
        kind: "ez",
      }),
      getConversationPath: async () => [],
      getLatestLeaf: async () => null,
      resolveSystemPrompt: async () => undefined,
      createConversation: async () => ({ id: "test" }),
      createMessage: async () => ({ id: "msg-1" }),
      getMessages: async () => [],
    }));
    mock.module("../db/queries/extensions", () => ({
      getExtensionByName: async (name: string) =>
        name === "extension-author" ? { id: "ext-author", enabled: true } : null,
      getExtensionsByNames: async () => new Map(),
    }));
    mock.module("../extensions/registry", () => ({
      ExtensionRegistry: {
        getInstance: () => ({
          getToolsForAgent: async () => [],
          getToolsForExtension: (id: string) =>
            id === "ext-author"
              ? [{ name: "extension-author__create_extension", description: "scaffold", inputSchema: {} }]
              : [],
        }),
      },
    }));
    // buildExtensionToolExecutor exercises the full host-setter surface;
    // the base harness class omits those methods, so supply them here.
    mock.module("../extensions/tool-executor", () => ({
      MAX_TOOL_CALLS_PER_TURN: 10,
      ToolExecutor: class {
        setPendingPermissionGate() {}
        setStateMediator() {}
        setExecutor() {}
        setSpawnQuota() {}
        setArgsResolver() {}
        setCurrentUserId() {}
        setCurrentModel() {}
        setCurrentProvider() {}
        setCurrentAgentConfigId() {}
        async executeToolCall() {
          return { content: [{ text: "result" }] };
        }
      },
      extensionToAgentTool: (t: { name: string }) => fakeTool(t.name),
    }));

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });
    const run = await exec.streamChat("conv-ez", "Hi", {});

    expect(run.status).toBe("success");
    // Ez concierge tools wired (spot-check a client-side + a propose tool)…
    expect(capturedToolNames).toContain("fill_form");
    expect(capturedToolNames).toContain("read_page");
    expect(capturedToolNames).toContain("propose_create_project");
    // …and the bundled authoring tool rode in through the ez-only wire.
    expect(capturedToolNames).toContain("extension-author__create_extension");
  });

  test("BEHAVIORAL control: a regular conversation gets NO Ez or extension-author tools", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });
    const run = await exec.streamChat("conv-regular", "Hi", {});

    expect(run.status).toBe("success");
    expect(capturedToolNames).not.toContain("read_page");
    expect(capturedToolNames).not.toContain("extension-author__create_extension");
  });
});
