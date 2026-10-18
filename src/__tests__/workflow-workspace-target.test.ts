import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as projects from "../db/queries/projects";
import * as projectTargets from "../runtime/workspaces/project-target";
import * as dryRun from "../runtime/workflow-dry-run";
import { localWorkspaceTarget, type WorkspaceTarget } from "../runtime/workspaces/target";
import { WorkflowExecutor } from "../runtime/workflow-executor";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import type { AgentEvents, WorkflowDefinition } from "../types";

const requested = localWorkspaceTarget("/requested");
const resolved = localWorkspaceTarget("/resolved");
const project = { id: "project-1", path: "/project" } as NonNullable<Awaited<ReturnType<typeof projects.getProject>>>;
const definition: WorkflowDefinition = {
  name: "workspace-target", description: "workspace selection",
  steps: [{ name: "read", kind: "tool", tool: "readFile", input: { path: "canary.txt" } }],
};
let order: string[];
let getProject: ReturnType<typeof spyOn<typeof projects, "getProject">>;
let resolveTarget: ReturnType<typeof spyOn<typeof projectTargets, "resolveProjectWorkspaceTarget">>;
let agents: AgentExecutor;
let workflow: WorkflowExecutor;
let received: WorkspaceTarget | undefined;

beforeEach(() => {
  order = []; received = undefined;
  getProject = spyOn(projects, "getProject").mockImplementation(async () => { order.push("lookup"); return project; });
  resolveTarget = spyOn(projectTargets, "resolveProjectWorkspaceTarget").mockImplementation(async () => { order.push("resolve"); return resolved; });
  const bus = new EventBus<AgentEvents>();
  bus.on("workflow:start", () => { order.push("start"); });
  agents = new AgentExecutor(loadAgentsStatic([]), bus);
  workflow = new WorkflowExecutor(agents, bus, {
    toolRunnerFactory: (_pending, target) => {
      received = target;
      return { setCurrentUserId() {}, async executeToolCall() { order.push("tool"); return { content: [{ type: "text", text: "read" }] }; } };
    },
  });
});
afterEach(() => { getProject.mockRestore(); resolveTarget.mockRestore(); agents.destroy(); });

test("project workspace is resolved before start and passed to the tool runner", async () => {
  const run = await workflow.runWorkflow(definition, {}, project.id, undefined, undefined, { workspaceTarget: requested });
  expect(run.status).toBe("success");
  expect(getProject).toHaveBeenCalledWith(project.id);
  expect(resolveTarget).toHaveBeenCalledWith(project, "workflow run", requested);
  expect(received).toBe(resolved);
  expect(order).toEqual(["lookup", "resolve", "start", "tool"]);
});

test("a run without a project retains its supplied target without a lookup", async () => {
  expect((await workflow.runWorkflow(definition, {}, undefined, undefined, undefined, { workspaceTarget: requested })).status).toBe("success");
  expect(received).toBe(requested);
  expect(getProject).not.toHaveBeenCalled(); expect(resolveTarget).not.toHaveBeenCalled();
  expect(order).toEqual(["start", "tool"]);
});

test("a missing project refuses before any start event or tool effect", async () => {
  getProject.mockImplementation(async () => { order.push("lookup"); return undefined; });
  await expect(workflow.runWorkflow(definition, {}, project.id)).rejects.toThrow("Project workspace is unavailable for workflow run");
  expect(resolveTarget).not.toHaveBeenCalled(); expect(order).toEqual(["lookup"]);
});

test("workspace resolution refusal preserves the original error and prevents effects", async () => {
  const error = new Error("Workspace binding changed");
  resolveTarget.mockImplementation(async () => { order.push("resolve"); throw error; });
  await expect(workflow.runWorkflow(definition, {}, project.id)).rejects.toBe(error);
  expect(order).toEqual(["lookup", "resolve"]);
});

test("a pure executor skips project lookup and retains the supplied target", async () => {
  const pure = spyOn(dryRun, "isPureWorkflowExecutor").mockReturnValue(true);
  try {
    expect((await workflow.runWorkflow(definition, {}, project.id, undefined, undefined, { workspaceTarget: requested })).status).toBe("success");
    expect(getProject).not.toHaveBeenCalled(); expect(resolveTarget).not.toHaveBeenCalled(); expect(received).toBe(requested);
  } finally { pure.mockRestore(); }
});
