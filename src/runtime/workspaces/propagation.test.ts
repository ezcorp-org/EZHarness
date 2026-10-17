import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { AgentDefinition, AgentEvents, WorkflowDefinition } from "../../types";
import type { AgentExecutor as AgentExecutorType } from "../executor";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";
import {
  sandboxWorkspaceTarget,
  type SandboxWorkspaceBinding,
  type SandboxWorkspaceToolRequest,
} from "./target";

mockDbConnection();

const { AgentExecutor } = await import("../executor");
const { EventBus } = await import("../events");
const { WorkflowExecutor } = await import("../workflow-executor");
const { createProject } = await import("../../db/queries/projects");
const { sandboxBindings } = await import("../../db/schema");

let binding: SandboxWorkspaceBinding = {
  projectId: "set-in-beforeAll",
  workspaceId: "workspace-1",
  connectionId: "connection-1",
  providerId: "incus",
  generation: 7,
  presetId: "small",
  releaseDigest: "a".repeat(64),
  presetDigest: "b".repeat(64),
  effectiveSettingsDigest: "c".repeat(64),
};

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Propagation", path: "/tmp/sandbox-propagation" });
  binding = { ...binding, projectId: project.id };
  await getTestDb().insert(sandboxBindings).values({
    id: crypto.randomUUID(), projectId: project.id,
    providerInstallationId: "incus-provider", providerReleaseId: "release-1",
    connectionId: binding.connectionId, resourceKey: binding.workspaceId,
    desiredState: "RUNNING", observedState: "RUNNING", generation: binding.generation,
  });
}, 30_000);
afterAll(async () => closeTestDb());

function executorWithAgents(
  agents: AgentDefinition[],
  localTouches: { reads: number; writes: number; shells: number },
): AgentExecutorType {
  return new AgentExecutor(
    new Map(agents.map((agent) => [agent.name, agent])),
    new EventBus<AgentEvents>(),
    {
      shell: {
        async run() {
          localTouches.shells++;
          return { stdout: "AMD", stderr: "", exitCode: 0 };
        },
      },
      file: {
        async read() { localTouches.reads++; return "AMD"; },
        async write() { localTouches.writes++; },
        async exists() { localTouches.reads++; return true; },
      },
    },
  );
}

const reader: AgentDefinition = {
  name: "reader",
  description: "read one workspace file",
  capabilities: ["file"],
  async execute(ctx) {
    return { success: true, output: await ctx.file.read("canary.txt") };
  },
};

describe("workspace target propagation", () => {
  test("nested code agents inherit the exact sandbox binding", async () => {
    const requests: SandboxWorkspaceToolRequest[] = [];
    const localTouches = { reads: 0, writes: 0, shells: 0 };
    const parent: AgentDefinition = {
      name: "parent",
      description: "spawn child",
      capabilities: ["agent"],
      async execute(ctx) {
        return ctx.run("reader", {});
      },
    };
    const executor = executorWithAgents([parent, reader], localTouches);
    const target = sandboxWorkspaceTarget(binding, {
      async execute(request) {
        requests.push(request);
        return { content: [{ type: "text", text: "sandbox-data" }], details: {} };
      },
    });

    const run = await executor.runAgent(
      "parent",
      {},
      binding.projectId,
      "user-1",
      undefined,
      { workspaceTarget: target },
    );

    expect(run.result).toEqual({ success: true, output: "sandbox-data" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.binding).toEqual(binding);
    expect(requests[0]?.toolName).toBe("readFile");
    expect(localTouches).toEqual({ reads: 0, writes: 0, shells: 0 });
    executor.destroy();
  });

  test("workflow agent steps keep sandbox routing and deny failed-backend fallback", async () => {
    const localTouches = { reads: 0, writes: 0, shells: 0 };
    const bus = new EventBus<AgentEvents>();
    const executor = executorWithAgents([reader], localTouches);
    const workflow = new WorkflowExecutor(executor, bus);
    const target = sandboxWorkspaceTarget(binding, {
      async execute() { throw new Error("provider disconnected"); },
    });
    const definition = {
      name: "sandbox-reader",
      description: "read through an agent step",
      version: "1",
      steps: [{ name: "read", kind: "agent", agent: "reader" }],
    } as unknown as WorkflowDefinition;

    const run = await workflow.runWorkflow(
      definition,
      {},
      binding.projectId,
      "user-1",
      undefined,
      { workspaceTarget: target },
    );

    expect(run.status).toBe("error");
    expect(JSON.stringify(run.result)).toContain("Local workspace fallback was denied");
    expect(localTouches).toEqual({ reads: 0, writes: 0, shells: 0 });
    executor.destroy();
  });
});
