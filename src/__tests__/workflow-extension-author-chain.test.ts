import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { WorkflowExecutor, parseToolOutput } from "../runtime/workflow-executor";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import { loadYamlWorkflows } from "../runtime/workflow-loader";
import type { AgentEvents, WorkflowDefinition } from "../types";
import type { ToolCallResult } from "../extensions/types";
import type { WorkflowToolRunner } from "../runtime/workflow-tool-runner";
import { extensionControlTools } from "../extensions/extension-control";
import { compileValueSchema } from "@ezcorp/extension-contract";

let chain: WorkflowDefinition;
beforeAll(async () => {
  const found = (await loadYamlWorkflows(join(import.meta.dir, "../agents"))).find((workflow) => workflow.name === "extension-author");
  if (!found) throw new Error("extension-author.workflow.yaml did not load");
  chain = found;
});

const input = { name: "my-widget", description: "A widget", idempotencyKey: "build-one" };
const workspace = { installation: { id: "installation" }, workspace: { id: "workspace", revision: 7 }, openUrl: "/extensions/releases/installation?workspace=workspace" };
const validators = new Map<string, (value: unknown) => void>(extensionControlTools.map((tool) => [tool.name, compileValueSchema({ type: "object", properties: tool.properties, required: tool.required, additionalProperties: false })]));

function executorWith(options: { failure?: string; workspace?: unknown; operation?: unknown; state?: unknown } = {}) {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const principals: string[] = [];
  const runner: WorkflowToolRunner = {
    setCurrentUserId(userId) { principals.push(userId); },
    async executeToolCall(tool, toolInput) {
      calls.push({ tool, input: toolInput });
      validators.get(tool)?.(toolInput);
      if (tool === options.failure) return { isError: true, content: [{ type: "text", text: "fixture host refusal" }] };
      let output: unknown;
      if (tool === "extensions_workspace") output = options.workspace ?? workspace;
      else if (tool === "extensions_build") {
        output = options.operation ?? { id: "operation", state: "queued" };
      } else if (tool === "extensions_inspect") {
        output = options.state ?? { installation: { enabled: false, activeReleaseId: null }, operations: { operation: { state: "queued" } }, approvals: {}, releases: {} };
      } else throw new Error(`Unexpected authority: ${tool}`);
      return { isError: false, content: [{ type: "text", text: JSON.stringify(output) }] } satisfies ToolCallResult;
    },
  };
  const bus = new EventBus<AgentEvents>();
  return { workflow: new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, { toolRunnerFactory: () => runner }), calls, principals };
}

describe("host extension author workflow", () => {
  test("the shipped chain contains only bounded host workspace, build, and inspect tools", () => {
    expect(chain.steps.map((step) => step.name)).toEqual(["workspace", "build", "inspect", "handoff"]);
    expect(chain.steps.filter((step) => step.kind === "tool").map((step) => step.tool)).toEqual(["extensions_workspace", "extensions_build", "extensions_inspect"]);
    expect(chain.steps.at(-1)?.kind).toBe("transform");
  });

  test("threads exact revision and idempotency coordinates and returns review without granting authority", async () => {
    const setup = executorWith();
    const run = await setup.workflow.runWorkflow(chain, input, undefined, "user-1");
    expect(run.result?.success).toBe(true);
    expect(run.result?.output).toMatchObject({ installationId: "installation", operationId: "operation", openUrl: workspace.openUrl, state: { installation: { enabled: false, activeReleaseId: null }, approvals: {} } });
    expect(String((run.result?.output as Record<string, unknown> | undefined)?.nextStep)).toContain("A user must approve that exact release");
    expect(setup.calls.map((call) => call.tool)).toEqual(["extensions_workspace", "extensions_build", "extensions_inspect"]);
    expect(setup.calls[0]?.input).toEqual({ action: "create", name: input.name, description: input.description });
    expect(setup.calls[1]?.input).toEqual({ installationId: "installation", workspaceId: "workspace", expectedRevision: 7, idempotencyKey: "build-one" });
    expect(setup.calls[2]?.input).toEqual({ installationId: "installation", operationId: "operation" });
    expect(setup.principals.every((principal) => principal === "user-1")).toBe(true);
  });

  for (const state of ["queued", "building", "failed", "succeeded"]) test(`a ${state} build remains explicit evidence, never implicit activation`, async () => {
    const evidence = { installation: { enabled: false, activeReleaseId: null }, operations: { operation: { state, diagnostics: ["fixture evidence"] } }, approvals: {}, releases: state === "succeeded" ? { release: { id: "release" } } : {} };
    const setup = executorWith({ state: evidence });
    const run = await setup.workflow.runWorkflow(chain, input, undefined, "user-1");
    expect((run.result?.output as Record<string, unknown> | undefined)?.state).toEqual(evidence);
    expect(setup.calls.some((call) => call.tool === "extensions_release")).toBe(false);
  });

  for (const [index, tool] of ["extensions_workspace", "extensions_build", "extensions_inspect"].entries()) test(`${tool} refusal stops the chain without review success or later effects`, async () => {
    const setup = executorWith({ failure: tool });
    const run = await setup.workflow.runWorkflow(chain, input, undefined, "user-1");
    expect(run.result?.success).toBe(false);
    expect(String(run.result?.error)).toContain("fixture host refusal");
    expect(setup.calls).toHaveLength(index + 1);
  });

  test("a missing workspace coordinate cannot reach a successful build handoff", async () => {
    const setup = executorWith({ workspace: { installation: {}, workspace: {} } });
    const run = await setup.workflow.runWorkflow(chain, input, undefined, "user-1");
    expect(run.result?.success).toBe(false);
    expect(setup.calls.some((call) => call.tool === "extensions_inspect")).toBe(false);
  });

  test("a missing operation coordinate cannot become a verified release", async () => {
    const setup = executorWith({ operation: { state: "queued" } });
    const run = await setup.workflow.runWorkflow(chain, input, undefined, "user-1");
    expect(run.result?.success).toBe(false);
    expect(setup.calls.some((call) => call.tool === "extensions_release")).toBe(false);
  });
});

describe("parseToolOutput — why tool steps can chain at all", () => {
  test("parses a JSON object so later steps can address it by path", () => {
    expect(parseToolOutput('{"draftId":"d1","pass":true}')).toEqual({
      draftId: "d1",
      pass: true,
    });
  });

  test("parses a JSON array", () => {
    expect(parseToolOutput("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseToolOutput('\n  {"a":1}\n')).toEqual({ a: 1 });
  });

  test("leaves plain prose EXACTLY as-is (no pre-existing tool step changes)", () => {
    expect(parseToolOutput("hello from the tool")).toBe("hello from the tool");
    expect(parseToolOutput("line-1\nline-2")).toBe("line-1\nline-2");
    expect(parseToolOutput("")).toBe("");
  });

  test("does NOT parse bare scalars — that would change the value's TYPE", () => {
    // `42` → number and `"x"` → unquoted string would silently break an
    // existing `eq` / `contains` condition written against the raw text.
    expect(parseToolOutput("42")).toBe("42");
    expect(parseToolOutput("true")).toBe("true");
    expect(parseToolOutput("null")).toBe("null");
    expect(parseToolOutput('"quoted"')).toBe('"quoted"');
  });

  test("text that only LOOKS like JSON stays a string, never a silent {}", () => {
    expect(parseToolOutput('{"truncated": ')).toBe('{"truncated": ');
    expect(parseToolOutput("{ not json at all")).toBe("{ not json at all");
    expect(parseToolOutput("[oops")).toBe("[oops");
  });
});
