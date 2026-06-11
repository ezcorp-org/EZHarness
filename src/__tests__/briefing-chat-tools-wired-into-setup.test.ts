/**
 * Daily Briefing Phase 3 — setup-tools wiring gate tests for the
 * conversational-subscribe tools (`wireBriefingChatToolsIfEligible`).
 *
 * Clones the harness pattern of briefing-tools-wired-into-setup.test.ts
 * with the INVERSE gate:
 *
 *   1. A normal conversation (userId present, not the briefing agent)
 *      gets briefing_watch / briefing_unwatch / configure_briefing.
 *   2. MANDATORY NEGATIVE: a briefing conversation gets NONE of the
 *      three (the run is unattended; config writers don't belong there).
 *   3. No owning user → no tools (writes could not be attributed).
 *   4. A throwing wire degrades to a turn without the tools — the gate
 *      never throws into the setupTools phase.
 *   5. INTEGRATION: a read-only-restricted turn strips the three
 *      (category 'write') even when wired — the briefing pipeline's
 *      defense-in-depth second layer.
 *
 * No DB — `getBriefingAgentConfigId` is mocked (in-file snapshot +
 * literal re-register in afterAll; both targets are in MODULE_PATHS).
 */
import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// In-file snapshots of the mocked modules (≥2-mocks rule: snapshot the
// real exports, re-register the SAME exports in afterAll).
const realAgentConfig = { ...(await import("../runtime/briefing/agent-config")) };
const realChatTools = { ...(await import("../runtime/briefing/chat-tools")) };

/** The id the file-level mock serves; null simulates "agent never
 *  bootstrapped on this host". Reset per test. */
let stubBriefingAgentId: string | null = "briefing-agent-1";

mock.module("../runtime/briefing/agent-config", () => ({
  ...realAgentConfig,
  getBriefingAgentConfigId: async () => stubBriefingAgentId,
}));

import { applyToolFilters } from "../runtime/tools/filter";
import { BRIEFING_CHAT_TOOL_NAMES } from "../runtime/briefing/chat-tools";
import {
  wireBriefingChatToolsIfEligible,
  type SetupToolsConvRecord,
} from "../runtime/stream-chat/setup-tools";
import type { BuiltinToolDef } from "../runtime/tools/types";

afterAll(() => {
  mock.module("../runtime/briefing/agent-config", () => realAgentConfig);
  mock.module("../runtime/briefing/chat-tools", () => realChatTools);
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

function convRecord(overrides: Partial<SetupToolsConvRecord> = {}): SetupToolsConvRecord {
  return {
    userId: "user-1",
    agentConfigId: null,
    model: null,
    provider: null,
    kind: "regular",
    ...overrides,
  };
}

describe("wireBriefingChatToolsIfEligible — gate", () => {
  test("normal conversation (no agent config) → the 3 subscribe tools registered with category 'write'", async () => {
    const turn = freshTurn();
    await wireBriefingChatToolsIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-normal",
      convRecord: convRecord(),
    });
    expect(turn.agentTools.map((t) => t.name).sort()).toEqual([...BRIEFING_CHAT_TOOL_NAMES].sort());
    for (const name of BRIEFING_CHAT_TOOL_NAMES) {
      expect(turn.builtinToolDefsMap.get(name)!.category).toBe("write");
    }
  });

  test("conversation on a NON-briefing agent config still gets the tools", async () => {
    const turn = freshTurn();
    await wireBriefingChatToolsIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-other-agent",
      convRecord: convRecord({ agentConfigId: "some-other-agent" }),
    });
    expect(turn.agentTools).toHaveLength(BRIEFING_CHAT_TOOL_NAMES.length);
  });

  test("NEGATIVE: a briefing conversation gets NONE of the 3 (unattended run must not write config)", async () => {
    const turn = freshTurn();
    await wireBriefingChatToolsIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-briefing",
      convRecord: convRecord({ agentConfigId: "briefing-agent-1" }),
    });
    expect(turn.agentTools).toHaveLength(0);
    for (const name of BRIEFING_CHAT_TOOL_NAMES) {
      expect(turn.builtinToolDefsMap.has(name)).toBe(false);
    }
  });

  test("NEGATIVE: missing userId skips the wire (writes could not be attributed)", async () => {
    const turn = freshTurn();
    await wireBriefingChatToolsIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-no-user",
      convRecord: convRecord({ userId: null }),
    });
    expect(turn.agentTools).toHaveLength(0);
  });

  test("NEGATIVE: a null convRecord is a no-op", async () => {
    const turn = freshTurn();
    await wireBriefingChatToolsIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-null-record",
      convRecord: null,
    });
    expect(turn.agentTools).toHaveLength(0);
  });

  test("briefing agent never bootstrapped (lookup null) → an agent-attached conversation is treated as normal", async () => {
    stubBriefingAgentId = null;
    const turn = freshTurn();
    await wireBriefingChatToolsIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-unbootstrapped",
      convRecord: convRecord({ agentConfigId: "whatever-agent" }),
    });
    // Without a briefing agent on this host no conversation can BE a
    // briefing conversation — the subscribe tools stay available.
    expect(turn.agentTools).toHaveLength(BRIEFING_CHAT_TOOL_NAMES.length);
  });

  test("dedupe: wiring the same turn twice doesn't double-register", async () => {
    const turn = freshTurn();
    for (let i = 0; i < 2; i++) {
      await wireBriefingChatToolsIfEligible({
        agentTools: turn.agentTools,
        builtinToolDefsMap: turn.builtinToolDefsMap,
        conversationId: "conv-normal",
        convRecord: convRecord(),
      });
    }
    expect(turn.agentTools).toHaveLength(BRIEFING_CHAT_TOOL_NAMES.length);
  });

  test("throwing wire → degrades to a turn without the tools, never throws", async () => {
    mock.module("../runtime/briefing/chat-tools", () => ({
      ...realChatTools,
      wireBriefingChatToolsForTurn: () => {
        throw new Error("wire exploded");
      },
    }));
    try {
      const turn = freshTurn();
      await expect(
        wireBriefingChatToolsIfEligible({
          agentTools: turn.agentTools,
          builtinToolDefsMap: turn.builtinToolDefsMap,
          conversationId: "conv-normal",
          convRecord: convRecord(),
        }),
      ).resolves.toBeUndefined();
      expect(turn.agentTools).toHaveLength(0);
    } finally {
      // Literal re-register so subsequent tests in THIS file see the
      // real module again.
      mock.module("../runtime/briefing/chat-tools", () => realChatTools);
    }
  });

  test("INTEGRATION: a read-only-restricted turn strips the three even when wired (category 'write' defense-in-depth)", async () => {
    const turn = freshTurn();
    await wireBriefingChatToolsIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-normal",
      convRecord: convRecord(),
    });
    expect(turn.agentTools).toHaveLength(3);

    const filtered = applyToolFilters(turn.agentTools, turn.builtinToolDefsMap, {
      toolRestriction: "read-only",
    });
    expect(filtered).toHaveLength(0);
  });

  test("REGRESSION GUARD: setupTools invokes the chat-tools gate every turn", async () => {
    // Static check, mirroring the Phase 1 briefing-wire guard: if a
    // refactor of setup-tools.ts drops the gate call, this catches it
    // before integration coverage does.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dir, "..", "runtime", "stream-chat", "setup-tools.ts"),
      "utf-8",
    );
    expect(src).toContain("await wireBriefingChatToolsIfEligible({");
  });
});
