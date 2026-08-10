/**
 * `run_workflow` host wiring — `wireRunWorkflowForTurn`
 * (runtime/workflow-tools-host.ts) and the setup-tools gate that calls it
 * (`wireRunWorkflowIfEligible`).
 *
 * Four angles, mirroring ez-tools-wired-into-setup.test.ts:
 *
 *   1. REGISTRATION — the tool lands in BOTH `ctx.agentTools` and
 *      `builtinToolDefsMap`. The second is load-bearing: subscribe-bridge
 *      reads `callTimeoutMs` out of that map to size the watchdog's
 *      in-flight deferral, so a tool missing from it silently gets the 90s
 *      default and its turn is killed mid-workflow.
 *   2. GATE — the bound-recursion depth guard (the one genuine escalation
 *      here) and the owned-conversation requirement.
 *   3. INTEGRATION — the wired tool survives the executor's allowlist /
 *      read-only filters the way its `execute` category says it should.
 *   4. SOURCE-GREP REGRESSION GUARD — setup-tools.ts really does contain
 *      the gated call, so a refactor that drops it fails here rather than
 *      silently shipping a chat that cannot run workflows.
 *
 * No DB and no real workflow executor: the wire is a pure tool registrar.
 */
import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BuiltinToolDef } from "../runtime/tools/types";
import type { PendingPermissionInfo } from "../runtime/stream-chat/host";
import type { WorkflowDefinition, WorkflowRun } from "../types";

const realUsers = { ...(await import("../db/queries/users")) };
const realHost = { ...(await import("../runtime/workflow-tools-host")) };

mock.module("../db/queries/users", () => ({
  ...realUsers,
  getUserById: async () => ({ id: "user-1", role: "member" }),
}));

import { applyToolFilters } from "../runtime/tools/filter";
import { wireRunWorkflowForTurn } from "../runtime/workflow-tools-host";
import {
  wireRunWorkflowIfEligible,
  type SetupToolsConvRecord,
} from "../runtime/stream-chat/setup-tools";
import {
  RUN_WORKFLOW_CALL_TIMEOUT_MS,
  RUN_WORKFLOW_TOOL_NAME,
} from "../runtime/tools/run-workflow";
import {
  registerWorkflowRuntime,
  _resetWorkflowRuntimeForTests,
} from "../runtime/workflow/runtime-registry";

afterAll(() => {
  mock.module("../runtime/workflow-tools-host", () => realHost);
  restoreModuleMocks();
});

beforeEach(() => {
  _resetWorkflowRuntimeForTests();
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

// ── 1. Registration ────────────────────────────────────────────────────

describe("wireRunWorkflowForTurn — registration", () => {
  test("registers run_workflow into agentTools AND builtinToolDefsMap", () => {
    const turn = freshTurn();
    wireRunWorkflowForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      userId: "user-1",
    });

    expect(turn.agentTools.map((t) => t.name)).toEqual([RUN_WORKFLOW_TOOL_NAME]);
    const def = turn.builtinToolDefsMap.get(RUN_WORKFLOW_TOOL_NAME);
    expect(def).toBeDefined();
    expect(def!.category).toBe("execute");
  });

  test("the defs-map entry carries callTimeoutMs — the watchdog's only source for it", () => {
    // Miss this and subscribe-bridge falls back to
    // DEFAULT_BUILTIN_CALL_TIMEOUT_MS (90s) and kills the turn mid-workflow.
    const turn = freshTurn();
    wireRunWorkflowForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      userId: "user-1",
    });
    expect(turn.builtinToolDefsMap.get(RUN_WORKFLOW_TOOL_NAME)!.callTimeoutMs).toBe(
      RUN_WORKFLOW_CALL_TIMEOUT_MS,
    );
  });

  test("the pushed AgentTool carries an executable schema, not just a name", () => {
    const turn = freshTurn();
    wireRunWorkflowForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      userId: "user-1",
    });
    const tool = turn.agentTools[0] as AgentTool & { parameters?: unknown };
    expect(typeof tool.execute).toBe("function");
    expect(
      (tool.parameters as { properties: Record<string, unknown> }).properties.name,
    ).toBeDefined();
  });

  test("dedupes — a second wire in the same turn is a no-op", () => {
    const turn = freshTurn();
    for (let i = 0; i < 2; i++) {
      wireRunWorkflowForTurn({
        agentTools: turn.agentTools,
        builtinToolDefsMap: turn.builtinToolDefsMap,
        conversationId: "conv-1",
        userId: "user-1",
      });
    }
    expect(turn.agentTools).toHaveLength(1);
  });

  test("does not collide with a pre-existing tool of the same name", () => {
    const turn = freshTurn();
    turn.agentTools.push({ name: RUN_WORKFLOW_TOOL_NAME } as unknown as AgentTool);
    wireRunWorkflowForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      userId: "user-1",
    });
    expect(turn.agentTools).toHaveLength(1);
    expect(turn.builtinToolDefsMap.has(RUN_WORKFLOW_TOOL_NAME)).toBe(false);
  });
});

// ── 2. The pending-permission bridge ───────────────────────────────────

describe("wireRunWorkflowForTurn — pending-permission bridge", () => {
  interface CapturedGate {
    register: (key: string, info: PendingPermissionInfo) => void;
    deregister: (key: string) => void;
  }

  /** Drive the wired tool once and hand back the run options it passed. */
  async function captureRunOpts(
    pendingPermissions?: Map<string, PendingPermissionInfo>,
  ): Promise<{ pendingPermissions?: CapturedGate }> {
    const workflow: WorkflowDefinition = {
      name: "wf",
      description: "",
      source: "yaml",
      steps: [],
    };
    let captured: Record<string, unknown> = {};
    registerWorkflowRuntime({
      getWorkflows: () => [workflow],
      // The tool authorizes against the provenance-carrying cache, and
      // fails CLOSED without it — a `system` YAML asset is the ordinary
      // case and keeps this test about the permission bridge.
      getCachedWorkflows: () => [
        {
          definition: workflow,
          source: "yaml" as const,
          id: null,
          projectId: null,
          userId: null,
          visibility: "system" as const,
          forkedFrom: null,
        },
      ],
      workflowExecutor: {
        runWorkflow: async (_w, _i, _p, _u, _s, opts): Promise<WorkflowRun> => {
          captured = (opts ?? {}) as Record<string, unknown>;
          return {
            id: "r1",
            workflowName: "wf",
            status: "success",
            startedAt: 1,
            steps: [],
            result: { success: true, output: null },
          };
        },
        // Required by the registry since C4; this wire only ever starts runs.
        resumeWorkflow: (async () => {
          throw new Error("run_workflow must never resume a run");
        }) as never,
      },
    });

    const turn = freshTurn();
    wireRunWorkflowForTurn({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      userId: "user-1",
      ...(pendingPermissions ? { pendingPermissions } : {}),
    });
    await turn.builtinToolDefsMap.get(RUN_WORKFLOW_TOOL_NAME)!.execute("tc-1", { name: "wf" });
    return captured as { pendingPermissions?: CapturedGate };
  }

  test("the host's pendingPermissions MAP is bridged to register/deregister functions", async () => {
    const map = new Map<string, PendingPermissionInfo>();
    const opts = await captureRunOpts(map);
    expect(opts.pendingPermissions).toBeDefined();

    const info: PendingPermissionInfo = {
      conversationId: "conv-1",
      toolCallId: "prompt-1",
      toolName: "ext__deploy",
      input: {},
    };
    // These two closures are what makes an open consent card visible to
    // the run watchdog (`deferralReason` reads this exact map).
    opts.pendingPermissions!.register("prompt-1", info);
    expect(map.get("prompt-1")).toBe(info);

    opts.pendingPermissions!.deregister("prompt-1");
    expect(map.has("prompt-1")).toBe(false);
  });

  test("no map supplied ⇒ no gate is invented", async () => {
    const opts = await captureRunOpts();
    expect(opts.pendingPermissions).toBeUndefined();
  });
});

// ── 3. The setup-tools gate ────────────────────────────────────────────

describe("wireRunWorkflowIfEligible — gate", () => {
  test("depth 0 with an owned conversation → wired", async () => {
    const turn = freshTurn();
    await wireRunWorkflowIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      convRecord: convRecord(),
      orchestrationDepth: 0,
    });
    expect(turn.agentTools.map((t) => t.name)).toEqual([RUN_WORKFLOW_TOOL_NAME]);
  });

  test("an absent orchestrationDepth is treated as 0", async () => {
    const turn = freshTurn();
    await wireRunWorkflowIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      convRecord: convRecord(),
    });
    expect(turn.agentTools).toHaveLength(1);
  });

  test("G4 — BOUND RECURSION: depth > 0 gets NO run_workflow at all", async () => {
    // A workflow's `agent` step runs an agent turn. If that turn were
    // wired with run_workflow, the graph could recurse without bound under
    // ONE chat turn — and a single "always allow for this conversation"
    // click would then auto-approve every sensitive step of every nested
    // run. This is the guard; it is not optional.
    for (const depth of [1, 2, 3]) {
      const turn = freshTurn();
      await wireRunWorkflowIfEligible({
        agentTools: turn.agentTools,
        builtinToolDefsMap: turn.builtinToolDefsMap,
        conversationId: "conv-nested",
        convRecord: convRecord(),
        orchestrationDepth: depth,
      });
      expect(turn.agentTools, `depth ${depth}`).toHaveLength(0);
      expect(turn.builtinToolDefsMap.size, `depth ${depth}`).toBe(0);
    }
  });

  test("NEGATIVE: an ownerless conversation row is skipped (a run could not be authorized)", async () => {
    const turn = freshTurn();
    await wireRunWorkflowIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-no-owner",
      convRecord: convRecord({ userId: null }),
    });
    expect(turn.agentTools).toHaveLength(0);
  });

  test("NEGATIVE: a null convRecord is a no-op", async () => {
    const turn = freshTurn();
    await wireRunWorkflowIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-null",
      convRecord: null,
    });
    expect(turn.agentTools).toHaveLength(0);
  });

  test("projectId and pendingPermissions are forwarded to the wire", async () => {
    const seen: Array<Record<string, unknown>> = [];
    mock.module("../runtime/workflow-tools-host", () => ({
      ...realHost,
      wireRunWorkflowForTurn: (p: Record<string, unknown>) => {
        seen.push(p);
      },
    }));
    try {
      const map = new Map<string, PendingPermissionInfo>();
      const turn = freshTurn();
      await wireRunWorkflowIfEligible({
        agentTools: turn.agentTools,
        builtinToolDefsMap: turn.builtinToolDefsMap,
        conversationId: "conv-1",
        convRecord: convRecord(),
        projectId: "proj-7",
        pendingPermissions: map,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        conversationId: "conv-1",
        userId: "user-1",
        projectId: "proj-7",
      });
      expect(seen[0]!.pendingPermissions).toBe(map);
    } finally {
      mock.module("../runtime/workflow-tools-host", () => realHost);
    }
  });

  test("a throwing wire degrades to a turn without the tool, never throws", async () => {
    mock.module("../runtime/workflow-tools-host", () => ({
      ...realHost,
      wireRunWorkflowForTurn: () => {
        throw new Error("wire exploded");
      },
    }));
    try {
      const turn = freshTurn();
      // The await is on the real promise (load-bearing — the wire is async
      // and the fail-soft catch has to run before we assert). bun's
      // `expect(...).resolves` returns undefined rather than a thenable, so
      // `await expect(...)` would be inert; assert on the resolved value.
      const outcome = await wireRunWorkflowIfEligible({
        agentTools: turn.agentTools,
        builtinToolDefsMap: turn.builtinToolDefsMap,
        conversationId: "conv-1",
        convRecord: convRecord(),
      });
      expect(outcome).toBeUndefined();
      expect(turn.agentTools).toHaveLength(0);
    } finally {
      mock.module("../runtime/workflow-tools-host", () => realHost);
    }
  });
});

// ── 4. Filter integration ──────────────────────────────────────────────

describe("INTEGRATION: run_workflow vs the executor's tool filters", () => {
  test("wired BEFORE the filter, an allowlist that names it keeps it", async () => {
    // The ordering invariant: a tool that reaches agentTools after
    // applyToolFilters is invisible; one that reaches it before survives
    // an allowlist that names it.
    const turn = freshTurn();
    await wireRunWorkflowIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      convRecord: convRecord(),
    });
    turn.agentTools.push({ name: "readFile" } as unknown as AgentTool);
    turn.builtinToolDefsMap.set("readFile", {
      name: "readFile",
      category: "read",
    } as BuiltinToolDef);

    const filtered = applyToolFilters(turn.agentTools, turn.builtinToolDefsMap, {
      toolRestriction: "allowlist",
      allowedTools: [RUN_WORKFLOW_TOOL_NAME],
    });

    expect(filtered.map((t) => t.name)).toContain(RUN_WORKFLOW_TOOL_NAME);
    expect(filtered.map((t) => t.name)).not.toContain("readFile");
  });

  test("a read-only turn strips it — running a workflow is category 'execute'", async () => {
    const turn = freshTurn();
    await wireRunWorkflowIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-1",
      convRecord: convRecord(),
    });

    const filtered = applyToolFilters(turn.agentTools, turn.builtinToolDefsMap, {
      toolRestriction: "read-only",
    });
    expect(filtered.map((t) => t.name)).not.toContain(RUN_WORKFLOW_TOOL_NAME);
  });

  test("an Ez turn's allowlist (EZ_TOOL_NAMES) excludes it — Ez is a concierge, not a workflow runner", async () => {
    const { EZ_TOOL_NAMES } = await import("../runtime/tools/ez");
    const turn = freshTurn();
    await wireRunWorkflowIfEligible({
      agentTools: turn.agentTools,
      builtinToolDefsMap: turn.builtinToolDefsMap,
      conversationId: "conv-ez",
      convRecord: convRecord({ kind: "ez" }),
    });

    const filtered = applyToolFilters(turn.agentTools, turn.builtinToolDefsMap, {
      toolRestriction: "allowlist",
      allowedTools: [...EZ_TOOL_NAMES],
    });
    expect(filtered.map((t) => t.name)).not.toContain(RUN_WORKFLOW_TOOL_NAME);
    expect([...EZ_TOOL_NAMES]).not.toContain(RUN_WORKFLOW_TOOL_NAME);
  });
});

// ── 5. Source-grep regression guards ───────────────────────────────────

describe("REGRESSION GUARDS", () => {
  test("setupTools invokes the gate every turn, threading the depth", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(import.meta.dir, "..", "runtime", "stream-chat", "setup-tools.ts"),
      "utf-8",
    );
    expect(src).toContain("await wireRunWorkflowIfEligible({");
    // The depth MUST be threaded, or the bound-recursion guard above can
    // never fire in production no matter how well it is unit-tested.
    expect(src).toContain("orchestrationDepth: options.orchestrationDepth");
    // …and the acting user must come from the conversation row, never from
    // anything the LLM supplied.
    expect(/convRecord\?\.userId/.test(src)).toBe(true);
  });

  test("run_workflow is NOT in the project-rooted built-in bundle", async () => {
    // Same reason the Ez tools aren't: it carries per-user, per-turn
    // context that would leak across a project switch if cached with the
    // project-rooted tools. It is host-wired per turn instead.
    const { getBuiltinToolDefs } = await import("../runtime/tools");
    const names = getBuiltinToolDefs("/tmp").map((d) => d.name);
    expect(names).not.toContain(RUN_WORKFLOW_TOOL_NAME);
  });

  test("run_workflow is NOT in the /api/tools metadata listing", async () => {
    const { getBuiltInToolMetadata } = await import("../runtime/tools/builtin-registry");
    expect(getBuiltInToolMetadata().some((t) => t.name === RUN_WORKFLOW_TOOL_NAME)).toBe(false);
  });
});
