/**
 * The setup-tools gate for caller-executed tools
 * (`wireCallerToolsIfDeclared`), and the ORDERING invariant it depends on.
 *
 * §2b of setupTools ends with `ctx.agentTools = extTools.map(...)` — an
 * ASSIGNMENT, not a push. Anything registered before that line is discarded
 * without a trace: the tools exist in `builtinToolDefsMap`, the wire logs
 * success, and the model is simply never offered them. The source guard below
 * is the only cheap check that a future refactor has not moved the caller wire
 * above it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BuiltinToolDef } from "../runtime/tools/types";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { makeTestPermissionDeps } from "./helpers/permission-wrap-deps";
import {
  wireCallerToolsIfDeclared,
  type SetupToolsConvRecord,
} from "../runtime/stream-chat/setup-tools";

afterAll(() => restoreModuleMocks());

const OPEN_APP = {
  name: "open_app",
  description: "Open a native application",
  parameters: { type: "object", properties: { app: { type: "string" } } },
};

function convRecord(overrides: Partial<SetupToolsConvRecord> = {}): SetupToolsConvRecord {
  return {
    userId: "user-1",
    agentConfigId: null,
    model: null,
    provider: null,
    kind: "regular",
    metadata: { callerTools: [OPEN_APP] },
    ...overrides,
  };
}

describe("wireCallerToolsIfDeclared", () => {
  test("registers the declared tools into the turn's arrays", async () => {
    const agentTools: AgentTool[] = [];
    const builtinToolDefsMap = new Map<string, BuiltinToolDef>();
    await wireCallerToolsIfDeclared({
      agentTools,
      builtinToolDefsMap,
      conversationId: "conv-1",
      runId: "run-1",
      convRecord: convRecord(),
      bus: new EventBus<AgentEvents>(),
      permissionDeps: makeTestPermissionDeps().deps,
    });
    expect(agentTools.map((t) => t.name)).toEqual(["_caller__open_app"]);
    expect(builtinToolDefsMap.get("_caller__open_app")?.category).toBe("caller");
  });

  test("a conversation row with no metadata is a silent no-op", async () => {
    const agentTools: AgentTool[] = [];
    await wireCallerToolsIfDeclared({
      agentTools,
      builtinToolDefsMap: new Map(),
      conversationId: "conv-1",
      runId: "run-1",
      convRecord: convRecord({ metadata: null }),
      permissionDeps: makeTestPermissionDeps().deps,
    });
    expect(agentTools).toEqual([]);
  });

  test("a null conversation row is a silent no-op", async () => {
    const agentTools: AgentTool[] = [];
    await wireCallerToolsIfDeclared({
      agentTools,
      builtinToolDefsMap: new Map(),
      conversationId: "conv-1",
      runId: "run-1",
      convRecord: null,
      permissionDeps: makeTestPermissionDeps().deps,
    });
    expect(agentTools).toEqual([]);
  });

  test("a wire failure costs this turn its caller tools and nothing else", async () => {
    // Fail-soft, like every other host wire: the turn keeps its mode tools,
    // its mention tools and its built-ins. Forced here by handing the wire an
    // array it cannot read, which is the shape any internal throw takes.
    const builtinToolDefsMap = new Map<string, BuiltinToolDef>();
    await wireCallerToolsIfDeclared({
      agentTools: null as unknown as AgentTool[],
      builtinToolDefsMap,
      conversationId: "conv-1",
      runId: "run-1",
      convRecord: convRecord(),
      permissionDeps: makeTestPermissionDeps().deps,
    });
    expect(builtinToolDefsMap.size).toBe(0);
  });
});

describe("REGRESSION GUARD — wire order", () => {
  test("the caller wire sits AFTER §2b's ctx.agentTools assignment", async () => {
    const src = await Bun.file(
      new URL("../runtime/stream-chat/setup-tools.ts", import.meta.url).pathname,
    ).text();
    const assignment = src.indexOf("ctx.agentTools = extTools.map(");
    const wire = src.indexOf("await wireCallerToolsIfDeclared({");
    expect(assignment).toBeGreaterThan(-1);
    expect(wire).toBeGreaterThan(-1);
    // Above the assignment, every caller tool is silently dropped.
    expect(wire).toBeGreaterThan(assignment);
  });

  test("the call threads the conversation row and the run's own signal", async () => {
    const src = await Bun.file(
      new URL("../runtime/stream-chat/setup-tools.ts", import.meta.url).pathname,
    ).text();
    const call = src.slice(
      src.indexOf("await wireCallerToolsIfDeclared({"),
      src.indexOf("// 2d. Multi-agent orchestration"),
    );
    // The owner and the declarations both come from the DB row, never from
    // anything the LLM or the turn's options supplied.
    expect(call).toContain("convRecord,");
    // Without the run's controller a cancelled turn leaves permission cards
    // standing that no run is left to answer into.
    expect(call).toContain("runSignal: host.controllers.get(run.id)?.signal");
  });
});
