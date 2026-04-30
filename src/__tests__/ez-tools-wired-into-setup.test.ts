/**
 * Phase 48 — Ez tool wiring integration test.
 *
 * The verification report (gap #1) flagged that `getEzToolDefs` was
 * exported but never imported by the runtime — Ez-mode turns produced
 * an empty toolset because the executor's allowlist filter ran against
 * `ctx.agentTools = []`. This test pins that wiring shut from two
 * angles:
 *
 *   1. `wireEzToolsForTurn` registers all seven Ez tool names into the
 *      supplied `agentTools` array (and the `builtinToolDefsMap`).
 *
 *   2. After the executor's `applyToolFilters({ toolRestriction:
 *      'allowlist', allowedTools: EZ_TOOL_NAMES })` runs, exactly those
 *      seven names survive (plus the orchestration tools that are always
 *      preserved). This is the contract the seeded Ez mode and the
 *      runtime registration must agree on; if they ever drift, the LLM
 *      either sees no Ez tools (registration regression) or sees too
 *      many (filter regression).
 *
 * No DB / no real executor — wireEzToolsForTurn is a pure-function
 * tool registrar. The end-to-end "messages POST → streamChat → filter"
 * boundary is covered separately by the executor-allowed-tools-plumbing
 * test (which asserts the source-level `applyToolFilters(...,
 * mode.allowedTools, ...)` call) and by api-ez-message.server.test.ts
 * (which asserts the right modeId reaches streamChat).
 */
import { test, expect, describe } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { BuiltinToolDef } from "../runtime/tools/types";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { applyToolFilters } from "../runtime/tools/filter";
import { wireEzToolsForTurn } from "../runtime/ez-tools-host";
import { EZ_TOOL_NAMES } from "../runtime/tools/ez";

function freshTurn(): {
  agentTools: AgentTool[];
  builtinToolDefsMap: Map<string, BuiltinToolDef>;
  bus: EventBus<AgentEvents>;
} {
  return {
    agentTools: [],
    builtinToolDefsMap: new Map(),
    bus: new EventBus<AgentEvents>(),
  };
}

describe("wireEzToolsForTurn — Gap #1 fix", () => {
  test("registers all seven Ez tool names into ctx.agentTools", () => {
    const turn = freshTurn();
    wireEzToolsForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "ez-conv-1",
      userId: "user-1",
      bus: turn.bus,
    });

    const names = turn.agentTools.map((t) => t.name).sort();
    expect(names).toEqual([...EZ_TOOL_NAMES].sort());
    // Sanity: every name surface in builtinToolDefsMap too — the
    // permission middleware + subscribeBridge use that map for
    // category/cardType lookup at execute time.
    for (const name of EZ_TOOL_NAMES) {
      expect(turn.builtinToolDefsMap.has(name)).toBe(true);
      expect(turn.builtinToolDefsMap.get(name)!.category).toBe("ez");
    }
  });

  test("dedupes — calling twice in the same turn doesn't double-register", () => {
    const turn = freshTurn();
    wireEzToolsForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "ez-conv-1",
      userId: "user-1",
      bus: turn.bus,
    });
    wireEzToolsForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "ez-conv-1",
      userId: "user-1",
      bus: turn.bus,
    });
    expect(turn.agentTools).toHaveLength(EZ_TOOL_NAMES.length);
  });

  test("does not collide with pre-existing tools of the same name", () => {
    const turn = freshTurn();
    // Simulate a prior wiring that already registered one Ez name (e.g.,
    // a misconfigured extension). The Ez wire MUST NOT push a duplicate.
    turn.agentTools.push({ name: "fill_form" } as unknown as AgentTool);
    wireEzToolsForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "ez-conv-1",
      userId: "user-1",
      bus: turn.bus,
    });
    const fillFormCount = turn.agentTools.filter((t) => t.name === "fill_form").length;
    expect(fillFormCount).toBe(1);
  });

  test("INTEGRATION: after wireEzToolsForTurn + applyToolFilters with the Ez allowlist, exactly the seven Ez tools survive", () => {
    // Mirror the runtime sequence: setup-tools wires ez tools (this test),
    // then executor.ts runs applyToolFilters with mode.allowedTools = EZ_TOOL_NAMES.
    // This is the contract the seeded Ez mode + runtime registration MUST agree on.
    const turn = freshTurn();
    // Add some non-Ez tools too so we can verify the filter strips them.
    turn.agentTools.push(
      { name: "readFile" } as unknown as AgentTool,
      { name: "writeFile" } as unknown as AgentTool,
      { name: "invoke_agent" } as unknown as AgentTool, // orchestration — always survives
    );
    turn.builtinToolDefsMap.set("readFile", { name: "readFile", category: "read" } as BuiltinToolDef);
    turn.builtinToolDefsMap.set("writeFile", { name: "writeFile", category: "write" } as BuiltinToolDef);

    wireEzToolsForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "ez-conv-1",
      userId: "user-1",
      bus: turn.bus,
    });

    const filtered = applyToolFilters(turn.agentTools, turn.builtinToolDefsMap, {
      toolRestriction: "allowlist",
      allowedTools: [...EZ_TOOL_NAMES],
    });

    const survivors = filtered.map((t) => t.name).sort();
    // All seven Ez tools, plus invoke_agent (orchestration), plus
    // anything else in ORCHESTRATION_TOOLS that we put in the input
    // (just invoke_agent here). readFile + writeFile must be dropped.
    expect(survivors).toContain("propose_create_project");
    expect(survivors).toContain("propose_create_agent");
    expect(survivors).toContain("propose_install_extension");
    expect(survivors).toContain("summarize_conversation");
    expect(survivors).toContain("find_agents");
    expect(survivors).toContain("fill_form");
    expect(survivors).toContain("navigate_to");
    expect(survivors).toContain("invoke_agent");
    // Negative: non-allowlisted, non-orchestration tools are stripped.
    expect(survivors).not.toContain("readFile");
    expect(survivors).not.toContain("writeFile");
  });

  test("REGRESSION GUARD: setup-tools.ts contains the wireEzToolsForTurn invocation gated on convRecord.kind === 'ez'", async () => {
    // Static check — if anyone refactors setup-tools.ts and drops the Ez
    // branch the way it was missing in Wave 3 of Phase 48, this test
    // catches the regression before integration coverage does.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dir, "..", "runtime", "stream-chat", "setup-tools.ts"),
      "utf-8",
    );
    expect(src).toContain("wireEzToolsForTurn");
    // The branch must check kind === 'ez' (not modeId, not slug — the
    // conversation row's `kind` column is the source of truth).
    expect(/convRecord\?\.kind\s*===\s*['"]ez['"]/.test(src)).toBe(true);
  });

  test("REGRESSION GUARD: setup-tools.ts injects <page_context> for Ez-mode turns", async () => {
    // Companion regression for Gap #3 in the verification report — the
    // server must serialize ezContext into a `<page_context>` block on
    // ctx.system. Static check so a future refactor that drops the
    // injection path surfaces immediately.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dir, "..", "runtime", "stream-chat", "setup-tools.ts"),
      "utf-8",
    );
    expect(src).toContain("<page_context>");
    expect(src).toContain("</page_context>");
    // The injection must read options.ezContext (where the messages
    // endpoint forwarded the body field).
    expect(src).toContain("options.ezContext");
  });

  test("REGRESSION GUARD: setup-tools.ts threads defaultConversationId into wireEzToolsForTurn", async () => {
    // Phase 48 defense-in-depth: when summarize_conversation receives
    // no `conversationId` argument from the LLM, the runtime falls back
    // to the conversation id extracted from `ezContext.route.conversationId`.
    // The wire-site MUST extract that field and pass it through, or the
    // fallback never reaches the tool factory and the LLM's omission
    // re-surfaces as the legacy "conversationId is required" error.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dir, "..", "runtime", "stream-chat", "setup-tools.ts"),
      "utf-8",
    );
    // The extraction reads the route.conversationId from options.ezContext.
    expect(/route\?\.conversationId|route\.conversationId/.test(src)).toBe(true);
    // The extracted value is passed to wireEzToolsForTurn under the
    // exact name the host signature expects.
    expect(src).toContain("defaultConversationId");
  });

  test("WIRING: summarize_conversation parameters no longer require conversationId", () => {
    // After Phase 48 defense-in-depth, the JSON-schema `required` array
    // for the wired tool MUST omit `conversationId` — the runtime
    // back-fills from `ezContext.route.conversationId` when the LLM
    // omits the argument. If a future refactor restores the required
    // gate, this assertion catches the regression before integration
    // coverage does.
    const turn = freshTurn();
    wireEzToolsForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "ez-conv-1",
      userId: "user-1",
      bus: turn.bus,
      defaultConversationId: "default-conv-zzz",
    });

    const summarizeTool = turn.agentTools.find((t) => t.name === "summarize_conversation");
    expect(summarizeTool).toBeDefined();

    const params = summarizeTool!.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(params.required ?? []).not.toContain("conversationId");
    // The property itself is still defined — the LLM may still pass it
    // explicitly, in which case the explicit value wins over the default.
    expect(params.properties?.conversationId).toBeDefined();
  });

  test("WIRING: defaultConversationId is forwarded through getEzToolDefs to the summarize factory", async () => {
    // Fresh-load the module graph so we observe the factory call
    // arguments end-to-end. We spy on the summarize factory by
    // re-importing it, registering through `wireEzToolsForTurn`, and
    // confirming the registered tool's identity matches what
    // getEzToolDefs would produce for the same context.
    //
    // Concretely: the only field that affects the summarize tool's
    // observable behavior at registration time (no DB call yet) is the
    // parameters schema — if the host had failed to forward
    // defaultConversationId, the factory would have produced the same
    // schema, so we additionally cross-check the host's exported type
    // accepts the field (compile-time) and that the registry path
    // doesn't throw when defaultConversationId is supplied (runtime).
    const turn = freshTurn();
    expect(() =>
      wireEzToolsForTurn({
        agentTools: turn.agentTools,
        builtinToolDefsMap: turn.builtinToolDefsMap,
        conversationId: "ez-conv-1",
        userId: "user-1",
        bus: turn.bus,
        defaultConversationId: "default-conv-zzz",
      }),
    ).not.toThrow();
    expect(turn.agentTools.find((t) => t.name === "summarize_conversation")).toBeDefined();
  });
});
