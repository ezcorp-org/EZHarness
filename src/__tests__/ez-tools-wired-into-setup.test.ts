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
import type { AgentTool } from "@earendil-works/pi-agent-core";
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

  test("WIRING: summarize_conversation requires conversationId in its JSON schema", () => {
    // After the page-context-pushing mechanism was retired, the runtime
    // no longer supplies a server-side default for `conversationId`.
    // The JSON-schema `required` array for the wired tool MUST list
    // `conversationId` so the LLM is forced to supply it explicitly.
    const turn = freshTurn();
    wireEzToolsForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "ez-conv-1",
      userId: "user-1",
      bus: turn.bus,
    });

    const summarizeTool = turn.agentTools.find((t) => t.name === "summarize_conversation");
    expect(summarizeTool).toBeDefined();

    const params = summarizeTool!.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(params.required ?? []).toContain("conversationId");
    expect(params.properties?.conversationId).toBeDefined();
  });
});
