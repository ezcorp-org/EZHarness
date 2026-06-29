/**
 * Daily Briefing Phase 1 — setup-tools wiring gate tests.
 *
 * Clones the harness pattern of ez-tools-wired-into-setup.test.ts
 * against `wireBriefingToolsIfBriefingConversation` (the extracted
 * gate setup-tools.ts runs every turn):
 *
 *   1. A conversation attached to the system "Daily Briefing" agent
 *      config gets the three briefing read tools registered.
 *   2. MANDATORY NEGATIVE: a regular / other-agent conversation gets
 *      NONE of the three (the briefing tools read cross-conversation
 *      data — leaking them into arbitrary chats would be a privacy
 *      hole).
 *   3. A throwing wire degrades to a tool-less briefing turn — the
 *      gate never throws into the setupTools phase.
 *   4. INTEGRATION: under the executor's `toolRestriction:
 *      "read-only"` filter (what run.ts passes for the unattended
 *      pipeline call), the briefing tools survive while write/execute
 *      tools (edit-file, shell) are stripped.
 *
 * No DB — `getBriefingAgentConfigId` is mocked (in-file snapshot +
 * literal re-register in afterAll; both targets are in MODULE_PATHS).
 */
import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// In-file snapshots of the mocked modules (≥2-mocks rule: snapshot the
// real exports, re-register the SAME exports in afterAll).
const realAgentConfig = { ...(await import("../runtime/briefing/agent-config")) };
const realBriefingTools = { ...(await import("../runtime/briefing/tools")) };

/** The id the file-level mock serves; null simulates "agent never
 *  bootstrapped on this host". Reset per test. */
let stubBriefingAgentId: string | null = "briefing-agent-1";

mock.module("../runtime/briefing/agent-config", () => ({
  ...realAgentConfig,
  getBriefingAgentConfigId: async () => stubBriefingAgentId,
}));

import { applyToolFilters } from "../runtime/tools/filter";
import { BRIEFING_TOOL_NAMES } from "../runtime/briefing/tools";
import {
  wireBriefingToolsIfBriefingConversation,
  type SetupToolsConvRecord,
} from "../runtime/stream-chat/setup-tools";
import type { BuiltinToolDef } from "../runtime/tools/types";

afterAll(() => {
  mock.module("../runtime/briefing/agent-config", () => realAgentConfig);
  mock.module("../runtime/briefing/tools", () => realBriefingTools);
  restoreModuleMocks();
});

beforeEach(() => {
  stubBriefingAgentId = "briefing-agent-1";
});

function freshTurn(): {
  agentTools: AgentTool[];
  builtinToolDefsMap: Map<string, BuiltinToolDef>;
} {
  return { agentTools: [], builtinToolDefsMap: new Map() };
}

function briefingConvRecord(overrides: Partial<SetupToolsConvRecord> = {}): SetupToolsConvRecord {
  return {
    userId: "user-1",
    agentConfigId: "briefing-agent-1",
    model: null,
    provider: null,
    kind: "regular",
    ...overrides,
  };
}

describe("wireBriefingToolsIfBriefingConversation — gate", () => {
  test("briefing conversation turn → the 3 briefing read tools registered", async () => {
    const turn = freshTurn();
    await wireBriefingToolsIfBriefingConversation({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-briefing",
      convRecord: briefingConvRecord(),
    });

    const names = turn.agentTools.map((t) => t.name).sort();
    expect(names).toEqual([...BRIEFING_TOOL_NAMES].sort());
    // Category 'read' on every def — this is what lets them survive
    // the pipeline's toolRestriction:'read-only' filter.
    for (const name of BRIEFING_TOOL_NAMES) {
      expect(turn.builtinToolDefsMap.has(name)).toBe(true);
      expect(turn.builtinToolDefsMap.get(name)!.category).toBe("read");
    }
  });

  test("NEGATIVE: a conversation on another agent config gets none of the 3", async () => {
    const turn = freshTurn();
    await wireBriefingToolsIfBriefingConversation({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-other-agent",
      convRecord: briefingConvRecord({ agentConfigId: "some-other-agent" }),
    });
    expect(turn.agentTools).toHaveLength(0);
    for (const name of BRIEFING_TOOL_NAMES) {
      expect(turn.builtinToolDefsMap.has(name)).toBe(false);
    }
  });

  test("NEGATIVE: a regular conversation with no agent config gets none of the 3", async () => {
    const turn = freshTurn();
    await wireBriefingToolsIfBriefingConversation({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-regular",
      convRecord: briefingConvRecord({ agentConfigId: null }),
    });
    expect(turn.agentTools).toHaveLength(0);
  });

  test("NEGATIVE: a null convRecord is a no-op", async () => {
    const turn = freshTurn();
    await wireBriefingToolsIfBriefingConversation({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-null-record",
      convRecord: null,
    });
    expect(turn.agentTools).toHaveLength(0);
  });

  test("NEGATIVE: missing userId skips the wire (reads could not be ownership-scoped)", async () => {
    const turn = freshTurn();
    await wireBriefingToolsIfBriefingConversation({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-no-user",
      convRecord: briefingConvRecord({ userId: null }),
    });
    expect(turn.agentTools).toHaveLength(0);
  });

  test("NEGATIVE: agent never bootstrapped (lookup returns null) → no tools", async () => {
    stubBriefingAgentId = null;
    const turn = freshTurn();
    await wireBriefingToolsIfBriefingConversation({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-unbootstrapped",
      convRecord: briefingConvRecord(),
    });
    expect(turn.agentTools).toHaveLength(0);
  });

  test("dedupe: wiring the same turn twice doesn't double-register", async () => {
    const turn = freshTurn();
    for (let i = 0; i < 2; i++) {
      await wireBriefingToolsIfBriefingConversation({
        agentTools: turn.agentTools,
        builtinToolDefsMap: turn.builtinToolDefsMap,
        conversationId: "conv-briefing",
        convRecord: briefingConvRecord(),
      });
    }
    expect(turn.agentTools).toHaveLength(BRIEFING_TOOL_NAMES.length);
  });

  test("throwing wire → degrades to a tool-less turn, never throws", async () => {
    mock.module("../runtime/briefing/tools", () => ({
      ...realBriefingTools,
      wireBriefingToolsForTurn: () => {
        throw new Error("wire exploded");
      },
    }));
    try {
      const turn = freshTurn();
      await expect(
        wireBriefingToolsIfBriefingConversation({
          agentTools: turn.agentTools,
          builtinToolDefsMap: turn.builtinToolDefsMap,
          conversationId: "conv-briefing",
          convRecord: briefingConvRecord(),
        }),
      ).resolves.toBeUndefined();
      expect(turn.agentTools).toHaveLength(0);
    } finally {
      // Literal re-register so subsequent tests in THIS file see the
      // real module again.
      mock.module("../runtime/briefing/tools", () => realBriefingTools);
    }
  });

  test("INTEGRATION: briefing tools survive the pipeline's read-only restriction; write/execute tools are stripped", async () => {
    // Mirror the unattended-run sequence: setup-tools wires briefing
    // tools, then executor.ts applies options.toolRestriction =
    // 'read-only' (what run.ts passes for the scheduled pipeline call).
    const turn = freshTurn();
    turn.agentTools.push(
      { name: "read-file" } as unknown as AgentTool,
      { name: "edit-file" } as unknown as AgentTool,
      { name: "shell" } as unknown as AgentTool,
    );
    turn.builtinToolDefsMap.set("read-file", { name: "read-file", category: "read" } as BuiltinToolDef);
    turn.builtinToolDefsMap.set("edit-file", { name: "edit-file", category: "write" } as BuiltinToolDef);
    turn.builtinToolDefsMap.set("shell", { name: "shell", category: "execute" } as BuiltinToolDef);

    await wireBriefingToolsIfBriefingConversation({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-briefing",
      convRecord: briefingConvRecord(),
    });

    const filtered = applyToolFilters(turn.agentTools, turn.builtinToolDefsMap, {
      toolRestriction: "read-only",
    });
    const survivors = filtered.map((t) => t.name).sort();

    for (const name of BRIEFING_TOOL_NAMES) expect(survivors).toContain(name);
    expect(survivors).toContain("read-file");
    // No write or execute capability on an unattended run.
    expect(survivors).not.toContain("edit-file");
    expect(survivors).not.toContain("shell");
  });

  test("REGRESSION GUARD: setupTools invokes the briefing gate every turn", async () => {
    // Static check, mirroring the Ez-wire guard: if a refactor of
    // setup-tools.ts drops the gate call, this catches it before
    // integration coverage does.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dir, "..", "runtime", "stream-chat", "setup-tools.ts"),
      "utf-8",
    );
    expect(src).toContain("await wireBriefingToolsIfBriefingConversation({");
  });
});
