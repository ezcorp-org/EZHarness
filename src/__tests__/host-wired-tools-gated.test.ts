/**
 * Regression: the host-wired tool families are behind the permission gate.
 *
 * `builtinToAgentTool` projects `execute: def.execute` RAW, and for a long
 * time the only gate was an inline closure in `setup-tools.ts` block 2a
 * that ran solely under `options.projectId` → `project?.path`. Every
 * family wired by a HOST module — Ez, briefing, briefing-chat,
 * `run_workflow` — therefore executed ungated in every mode, and the
 * `category` each of them declares was dead metadata.
 *
 * Two of those families declare categories that are NOT auto-approved
 * under `ask`:
 *   - `run_workflow` is `execute` (also gated under `auto-edit`),
 *   - `briefing_watch` / `briefing_unwatch` / `configure_briefing` are
 *     `write`.
 * So this was a live hole, not a hypothetical one.
 *
 * Each case denies the gate, so no tool body ever runs and the suite
 * needs no database.
 */

import { describe, expect, test } from "bun:test";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { BuiltinToolDef } from "../runtime/tools/types";
import { needsApproval, resolvePermission } from "../runtime/tools/permissions";
import { wireEzToolsForTurn } from "../runtime/ez-tools-host";
import { wireRunWorkflowForTurn } from "../runtime/workflow-tools-host";
import { wireBriefingToolsForTurn } from "../runtime/briefing/tools";
import { wireBriefingChatToolsForTurn } from "../runtime/briefing/chat-tools";
import { makeTestPermissionDeps, type TestPermissionDeps } from "./helpers/permission-wrap-deps";

interface Wired {
  agentTools: AgentTool[];
  defs: Map<string, BuiltinToolDef>;
  h: TestPermissionDeps;
}

/** Wire one family under `ask` — the mode where the hole was visible. */
function wire(
  fn: (p: {
    agentTools: AgentTool[];
    builtinToolDefsMap: Map<string, BuiltinToolDef>;
    conversationId: string;
    userId: string;
    permissionDeps: TestPermissionDeps["deps"];
  }) => void,
): Wired {
  const h = makeTestPermissionDeps({ storedMode: "ask" });
  const agentTools: AgentTool[] = [];
  const defs = new Map<string, BuiltinToolDef>();
  fn({
    agentTools,
    builtinToolDefsMap: defs,
    conversationId: "conv-gated",
    userId: "user-gated",
    permissionDeps: h.deps,
  });
  return { agentTools, defs, h };
}

function flush(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 0));
}

/**
 * Drive one wired tool through the gate and report what happened: whether
 * a `tool:permission_request` went out, and the result text after denying.
 */
async function probe(w: Wired, toolName: string): Promise<{
  requested: boolean;
  text: string;
}> {
  const tool = w.agentTools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`tool ${toolName} was not wired`);
  const requests: string[] = [];
  const off = w.h.bus.on("tool:permission_request", (d) =>
    requests.push((d as { toolName: string }).toolName),
  );
  try {
    const callId = `call-${toolName}`;
    const pending = tool.execute(callId, {}) as Promise<AgentToolResult<unknown>>;
    await flush();
    const requested = requests.includes(toolName);
    if (requested) {
      resolvePermission(callId, false);
      const res = await pending;
      return { requested, text: (res.content[0] as { text: string }).text };
    }
    // Not gated — do not await the body (some of these hit the DB).
    return { requested, text: "" };
  } finally {
    off();
  }
}

describe("host-wired tool families run behind the permission gate", () => {
  test("run_workflow (category: execute) raises a gate under ask", async () => {
    const w = wire((p) => wireRunWorkflowForTurn(p));
    expect(w.defs.get("run_workflow")?.category).toBe("execute");
    expect(needsApproval("execute", "ask")).toBe(true);

    const { requested, text } = await probe(w, "run_workflow");
    expect(requested).toBe(true);
    expect(text).toBe("Permission denied by user");
    expect(w.h.pendingPermissions.size).toBe(0);
  });

  test("the briefing-chat writers (category: write) raise a gate under ask", async () => {
    const w = wire((p) => wireBriefingChatToolsForTurn(p));
    for (const name of ["briefing_watch", "briefing_unwatch", "configure_briefing"]) {
      expect(w.defs.get(name)?.category).toBe("write");
      const { requested, text } = await probe(w, name);
      expect(requested, name).toBe(true);
      expect(text, name).toBe("Permission denied by user");
    }
    expect(w.h.pendingPermissions.size).toBe(0);
  });

  test("briefing_status (category: read) is auto-approved, as it always was", async () => {
    const w = wire((p) => wireBriefingChatToolsForTurn(p));
    expect(w.defs.get("briefing_status")?.category).toBe("read");
    expect((await probe(w, "briefing_status")).requested).toBe(false);
  });

  test("the briefing read tools stay auto-approved", async () => {
    const w = wire((p) =>
      wireBriefingToolsForTurn({ ...p, briefingAgentConfigId: "briefing-agent" }),
    );
    for (const [name, def] of w.defs) {
      expect(def.category, name).toBe("read");
      expect((await probe(w, name)).requested, name).toBe(false);
    }
  });

  test("the Ez tools stay auto-approved (category: ez is in every mode's set)", async () => {
    const w = wire((p) => wireEzToolsForTurn(p));
    expect(w.defs.size).toBeGreaterThan(0);
    for (const [name, def] of w.defs) {
      expect(def.category, name).toBe("ez");
      expect((await probe(w, name)).requested, name).toBe(false);
    }
  });
});
