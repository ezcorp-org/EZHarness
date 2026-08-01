/**
 * The `run_workflow` built-in tool.
 *
 * Three things are under test, in descending order of how badly a
 * regression would hurt:
 *
 *   1. SECURITY — every RBAC coordinate comes from the turn closure, never
 *      from the tool's JSON schema. An `conversationId` / `userId` /
 *      `projectId` argument would let the LLM pick its own authorization.
 *   2. AUTHORIZATION — the shared `canRunWorkflow` helper gates the run,
 *      against the definition resolved out of the MERGED CACHE (the object
 *      the executor will actually run), and a denial surfaces as a tool
 *      error result rather than a throw.
 *   3. SHAPE — the result handed back to the model is a bounded
 *      PROJECTION of `WorkflowRun`, and the tool NEVER throws: a thrown
 *      built-in kills the whole turn, a returned error result does not.
 */
import { test, expect, describe, afterAll, afterEach, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { WorkflowDefinition, WorkflowRun } from "../types";

// ── Module mocks (all three targets are in MODULE_PATHS) ───────────────

const realUsers = { ...(await import("../db/queries/users")) };
const realWorkflowQueries = { ...(await import("../db/queries/workflows")) };
const realExtensionQueries = { ...(await import("../db/queries/extensions")) };

/** What `getUserById` serves. `null` = the row vanished. */
let stubUser: { id: string; role: string } | null = { id: "user-1", role: "member" };
/** What `getWorkflowByName` serves (only consulted for `source: "db"`). */
let stubWorkflowRow: { createdBy: string | null } | null = null;

mock.module("../db/queries/users", () => ({
  ...realUsers,
  getUserById: async () => stubUser ?? undefined,
}));
mock.module("../db/queries/workflows", () => ({
  ...realWorkflowQueries,
  getWorkflowByName: async () => stubWorkflowRow ?? undefined,
}));
mock.module("../db/queries/extensions", () => ({
  ...realExtensionQueries,
  getExtensionByName: async () => undefined,
}));

import {
  createRunWorkflowTool,
  projectWorkflowRun,
  RUN_WORKFLOW_CALL_TIMEOUT_MS,
  RUN_WORKFLOW_TOOL_NAME,
  type RunWorkflowToolContext,
} from "../runtime/tools/run-workflow";
import { builtinToAgentTool } from "../runtime/tools/agent-tool";
import {
  registerWorkflowRuntime,
  _resetWorkflowRuntimeForTests,
} from "../runtime/workflow/runtime-registry";
import { getToolOutputLimit } from "../runtime/tools/output-limits";

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  stubUser = { id: "user-1", role: "member" };
  stubWorkflowRow = null;
  _resetWorkflowRuntimeForTests();
});

afterEach(() => {
  _resetWorkflowRuntimeForTests();
});

// ── Harness ────────────────────────────────────────────────────────────

const YAML_WORKFLOW: WorkflowDefinition = {
  name: "deploy",
  description: "ship it",
  source: "yaml",
  steps: [{ name: "build", kind: "transform", output: { ok: "yes" } }],
};

interface RecordedRun {
  workflow: WorkflowDefinition;
  input: Record<string, unknown>;
  projectId: string | undefined;
  userId: string | undefined;
  signal: AbortSignal | undefined;
  opts: { conversationId?: string; pendingPermissions?: unknown } | undefined;
}

function successRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "wfr-1",
    workflowName: "deploy",
    status: "success",
    startedAt: 1,
    finishedAt: 2,
    steps: [{ stepName: "build", runId: "", status: "success" }],
    result: { success: true, output: { url: "https://example.test" } },
    ...overrides,
  };
}

/** Register a fake live runtime and capture what the tool passes it. */
function registerRuntime(
  workflows: WorkflowDefinition[],
  run: WorkflowRun | (() => Promise<WorkflowRun>),
): RecordedRun[] {
  const calls: RecordedRun[] = [];
  registerWorkflowRuntime({
    getWorkflows: () => workflows,
    workflowExecutor: {
      runWorkflow: async (workflow, input, projectId, userId, signal, opts) => {
        calls.push({ workflow, input, projectId, userId, signal, opts });
        return typeof run === "function" ? await run() : run;
      },
    },
  });
  return calls;
}

function makeTool(overrides: Partial<RunWorkflowToolContext> = {}) {
  return createRunWorkflowTool({
    userId: "user-1",
    conversationId: "conv-42",
    ...overrides,
  });
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

// ── 1. Security: the schema is the whole attack surface ────────────────

describe("run_workflow — the LLM cannot choose its own RBAC coordinates", () => {
  test("the JSON schema exposes ONLY `name` and `input`", () => {
    const params = makeTool().parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(params.properties).sort()).toEqual(["input", "name"]);
    expect(params.required).toEqual(["name"]);
  });

  test("no conversationId / userId / projectId field exists to be supplied", () => {
    const params = makeTool().parameters as { properties: Record<string, unknown> };
    // G1/G2/G3: each of these is read from the turn closure. A schema field
    // of the same name would let the LLM re-point the run at another
    // conversation, act as another user, or pick another project's RBAC
    // coordinate — the entire reason the tool is host-wired per turn.
    expect(params.properties.conversationId).toBeUndefined();
    expect(params.properties.userId).toBeUndefined();
    expect(params.properties.projectId).toBeUndefined();
  });

  test("the turn's conversationId, userId and projectId are what reach runWorkflow", async () => {
    const calls = registerRuntime([YAML_WORKFLOW], successRun());
    const tool = makeTool({ conversationId: "conv-real", projectId: "proj-9" });

    await tool.execute("tc-1", {
      name: "deploy",
      // Decoys: pi-agent-core hands `params` through without validating it
      // against `parameters`, so an off-schema field DOES arrive here. It
      // must be ignored.
      conversationId: "conv-somebody-elses",
      userId: "user-admin",
      projectId: "proj-secret",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts?.conversationId).toBe("conv-real");
    expect(calls[0]?.userId).toBe("user-1");
    expect(calls[0]?.projectId).toBe("proj-9");
  });

  test("an absent projectId stays absent rather than becoming a string", async () => {
    const calls = registerRuntime([YAML_WORKFLOW], successRun());
    await makeTool().execute("tc-1", { name: "deploy" });
    expect(calls[0]?.projectId).toBeUndefined();
  });
});

// ── 2. Authorization ───────────────────────────────────────────────────

describe("run_workflow — authorization", () => {
  test("a denial surfaces as a tool error result, not a throw, and the run never starts", async () => {
    const dbWorkflow: WorkflowDefinition = { ...YAML_WORKFLOW, source: "db" };
    const calls = registerRuntime([dbWorkflow], successRun());
    stubWorkflowRow = { createdBy: "someone-else" };

    const result = await makeTool().execute("tc-1", { name: "deploy" });

    expect(result.details).toMatchObject({ isError: true });
    expect(textOf(result)).toBe('Error: Workflow "deploy" is owned by another user');
    expect(calls).toHaveLength(0);
  });

  test("an admin may run another user's workflow (role read from the DB, not the turn)", async () => {
    const dbWorkflow: WorkflowDefinition = { ...YAML_WORKFLOW, source: "db" };
    const calls = registerRuntime([dbWorkflow], successRun());
    stubWorkflowRow = { createdBy: "someone-else" };
    stubUser = { id: "user-1", role: "admin" };

    const result = await makeTool().execute("tc-1", { name: "deploy" });

    expect(result.details).toMatchObject({ isError: false });
    expect(calls).toHaveLength(1);
  });

  test("a vanished user row fails CLOSED", async () => {
    const calls = registerRuntime([YAML_WORKFLOW], successRun());
    stubUser = null;

    const result = await makeTool().execute("tc-1", { name: "deploy" });

    expect(textOf(result)).toContain("the acting user could not be resolved");
    expect(result.details).toMatchObject({ isError: true });
    expect(calls).toHaveLength(0);
  });

  test("the definition handed to authz is the one the executor runs (same object)", async () => {
    // A re-lookup by name would authorize a DIFFERENT object on a YAML/DB
    // name collision, because YAML wins execution.
    const calls = registerRuntime([YAML_WORKFLOW], successRun());
    await makeTool().execute("tc-1", { name: "deploy" });
    expect(calls[0]?.workflow).toBe(YAML_WORKFLOW);
  });
});

// ── 3. Argument handling — never throws ────────────────────────────────

describe("run_workflow — argument validation returns error results, never throws", () => {
  test("a missing name is an error result", async () => {
    registerRuntime([YAML_WORKFLOW], successRun());
    const result = await makeTool().execute("tc-1", {});
    expect(textOf(result)).toBe("Error: `name` is required");
    expect(result.details).toMatchObject({ isError: true });
  });

  test("a blank / non-string name is an error result", async () => {
    registerRuntime([YAML_WORKFLOW], successRun());
    expect(textOf(await makeTool().execute("tc-1", { name: "   " }))).toBe(
      "Error: `name` is required",
    );
    expect(textOf(await makeTool().execute("tc-1", { name: 7 }))).toBe(
      "Error: `name` is required",
    );
  });

  test("undefined params are handled (no destructuring crash)", async () => {
    registerRuntime([YAML_WORKFLOW], successRun());
    const result = await makeTool().execute("tc-1", undefined);
    expect(textOf(result)).toBe("Error: `name` is required");
  });

  test("a non-object `input` is rejected before anything runs", async () => {
    const calls = registerRuntime([YAML_WORKFLOW], successRun());
    for (const bad of ["a string", 42, ["an", "array"], null]) {
      const result = await makeTool().execute("tc-1", { name: "deploy", input: bad });
      expect(textOf(result)).toBe("Error: `input` must be a JSON object");
    }
    expect(calls).toHaveLength(0);
  });

  test("an omitted `input` becomes an empty object", async () => {
    const calls = registerRuntime([YAML_WORKFLOW], successRun());
    await makeTool().execute("tc-1", { name: "deploy" });
    expect(calls[0]?.input).toEqual({});
  });

  test("a supplied `input` is forwarded verbatim", async () => {
    const calls = registerRuntime([YAML_WORKFLOW], successRun());
    await makeTool().execute("tc-1", { name: "deploy", input: { env: "prod", n: 2 } });
    expect(calls[0]?.input).toEqual({ env: "prod", n: 2 });
  });

  test("the name is trimmed before lookup", async () => {
    const calls = registerRuntime([YAML_WORKFLOW], successRun());
    const result = await makeTool().execute("tc-1", { name: "  deploy  " });
    expect(result.details).toMatchObject({ isError: false });
    expect(calls).toHaveLength(1);
  });
});

// ── 4. Runtime availability + unknown workflow ─────────────────────────

describe("run_workflow — degrades cleanly when there is nothing to run", () => {
  test("no registered runtime (backend-only / CLI boot) is an error result, not a throw", async () => {
    // Nothing registered — `getWorkflowRuntime()` returns null.
    const result = await makeTool().execute("tc-1", { name: "deploy" });
    expect(textOf(result)).toBe("Error: workflows are not available in this process");
    expect(result.details).toMatchObject({ isError: true });
  });

  test("an unknown workflow name names itself in the error", async () => {
    registerRuntime([YAML_WORKFLOW], successRun());
    const result = await makeTool().execute("tc-1", { name: "nope" });
    expect(textOf(result)).toBe('Error: no workflow named "nope"');
  });

  test("a throwing executor is caught and reported, never propagated", async () => {
    registerRuntime([YAML_WORKFLOW], async () => {
      throw new Error("bus exploded");
    });
    const result = await makeTool().execute("tc-1", { name: "deploy" });
    expect(textOf(result)).toBe("Error: bus exploded");
    expect(result.details).toMatchObject({ isError: true });
  });

  test("a non-Error throw is stringified rather than swallowed", async () => {
    registerRuntime([YAML_WORKFLOW], async () => {
      throw { toString: () => "plain string" };
    });
    const result = await makeTool().execute("tc-1", { name: "deploy" });
    expect(textOf(result)).toBe("Error: plain string");
  });
});

// ── 5. Result projection ───────────────────────────────────────────────

describe("run_workflow — result is a bounded projection, not the raw run", () => {
  test("success: runId / name / status / steps / result, and no run-internal fields", async () => {
    registerRuntime([YAML_WORKFLOW], successRun());
    const result = await makeTool().execute("tc-1", { name: "deploy" });

    expect(JSON.parse(textOf(result))).toEqual({
      runId: "wfr-1",
      workflowName: "deploy",
      status: "success",
      steps: [{ name: "build", status: "success" }],
      result: { url: "https://example.test" },
      error: null,
    });
    // The per-step `runId` and the epoch timestamps are dropped — the model
    // can do nothing with them and they are pure token cost.
    expect(textOf(result)).not.toContain("startedAt");
    expect(textOf(result)).not.toContain("finishedAt");
  });

  test("a looped step carries its iteration count; a plain step omits the key", () => {
    const projected = projectWorkflowRun(
      successRun({
        steps: [
          { stepName: "loop", runId: "r1", status: "success", iterations: 3 },
          { stepName: "plain", runId: "", status: "success" },
        ],
      }),
    );
    expect(projected.steps).toEqual([
      { name: "loop", status: "success", iterations: 3 },
      { name: "plain", status: "success" },
    ]);
  });

  test("a run with no result at all projects null, not undefined", () => {
    const projected = projectWorkflowRun(successRun({ result: undefined }));
    expect(projected.result).toBeNull();
    expect(projected.error).toBeNull();
  });

  test("a FAILED run sets details.isError but keeps the text structured", async () => {
    registerRuntime(
      [YAML_WORKFLOW],
      successRun({
        status: "error",
        steps: [{ stepName: "build", runId: "", status: "error" }],
        result: { success: false, output: null, error: 'Step "build" failed: disk full' },
      }),
    );

    const result = await makeTool().execute("tc-1", { name: "deploy" });

    // Red card…
    expect(result.details).toMatchObject({ isError: true });
    // …but the model still gets enough to EXPLAIN the failure, which a bare
    // "Error: ..." string would not give it.
    expect(JSON.parse(textOf(result))).toMatchObject({
      status: "error",
      steps: [{ name: "build", status: "error" }],
      error: 'Step "build" failed: disk full',
    });
  });

  test("an awaiting_approval run is also flagged isError", async () => {
    registerRuntime([YAML_WORKFLOW], successRun({ status: "awaiting_approval" }));
    const result = await makeTool().execute("tc-1", { name: "deploy" });
    expect(result.details).toMatchObject({ isError: true, status: "awaiting_approval" });
  });

  test("an oversized result is truncated at the declared cap with a marker", async () => {
    const cap = getToolOutputLimit(RUN_WORKFLOW_TOOL_NAME);
    registerRuntime(
      [YAML_WORKFLOW],
      successRun({ result: { success: true, output: "x".repeat(cap + 4096) } }),
    );

    const result = await makeTool().execute("tc-1", { name: "deploy" });
    const text = textOf(result);

    expect(text).toContain("[output truncated:");
    expect(text).toContain(RUN_WORKFLOW_TOOL_NAME);
    // A runaway workflow output must not be able to poison the transcript.
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(cap + 1024);
  });
});

// ── 6. Metadata the runtime depends on ─────────────────────────────────

describe("run_workflow — declared metadata", () => {
  test("category / cardType / name", () => {
    const def = makeTool();
    expect(def.name).toBe("run_workflow");
    expect(def.label).toBe("run_workflow");
    expect(def.category).toBe("execute");
    expect(def.cardType).toBe("default");
  });

  test("declares a 10-minute callTimeoutMs — a workflow outlives the 90s default", () => {
    // The watchdog resolves this out of `builtinToolDefsMap`. Left
    // undeclared, `run_workflow` would inherit
    // DEFAULT_BUILTIN_CALL_TIMEOUT_MS (== WATCHDOG_IDLE_MS, 90s) and any
    // workflow longer than that would have its surrounding turn killed
    // mid-run.
    expect(makeTool().callTimeoutMs).toBe(600_000);
    expect(RUN_WORKFLOW_CALL_TIMEOUT_MS).toBe(600_000);
    expect(RUN_WORKFLOW_CALL_TIMEOUT_MS).toBeGreaterThan(90_000);
    // Bounded, not indefinite — a wedged workflow must still be reaped.
    expect(Number.isFinite(RUN_WORKFLOW_CALL_TIMEOUT_MS)).toBe(true);
  });

  test("declares maxOutputBytes like every other built-in", () => {
    expect(makeTool().maxOutputBytes).toBe(getToolOutputLimit(RUN_WORKFLOW_TOOL_NAME));
  });
});

// ── 7. Abort + pending-permission plumbing ─────────────────────────────

describe("run_workflow — cancellation and consent-card visibility", () => {
  test("the tool's abort signal is threaded into the run", async () => {
    const calls = registerRuntime([YAML_WORKFLOW], successRun());
    const controller = new AbortController();

    await makeTool().execute("tc-1", { name: "deploy" }, controller.signal);

    // Cancelling the chat must cancel the workflow it launched.
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test("the pending-permission gate is forwarded when the host supplied one", async () => {
    const gate = { register: () => {}, deregister: () => {} };
    const calls = registerRuntime([YAML_WORKFLOW], successRun());

    await makeTool({ pendingPermissions: gate }).execute("tc-1", { name: "deploy" });

    // Without this the run watchdog cannot see a parked consent card and
    // kills the turn at the callTimeoutMs ceiling mid-prompt.
    expect(calls[0]?.opts?.pendingPermissions).toBe(gate);
  });

  test("no gate supplied ⇒ the key is omitted entirely", async () => {
    const calls = registerRuntime([YAML_WORKFLOW], successRun());
    await makeTool().execute("tc-1", { name: "deploy" });
    expect(calls[0]?.opts).toEqual({ conversationId: "conv-42" });
  });
});

// ── 8. The shared BuiltinToolDef → AgentTool projection ────────────────

describe("builtinToAgentTool", () => {
  test("carries exactly the five fields pi-agent-core consumes", () => {
    const def = makeTool();
    const agentTool = builtinToAgentTool(def) as AgentTool & { label?: string };

    expect(agentTool.name).toBe(def.name);
    expect(agentTool.label).toBe(def.label);
    expect(agentTool.description).toBe(def.description);
    expect(agentTool.parameters).toBe(def.parameters);
    expect(agentTool.execute).toBe(def.execute);
  });
});
