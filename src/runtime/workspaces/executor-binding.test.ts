import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDefinition, AgentEvents, WorkflowDefinition } from "../../types";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { sandboxBindingRow } from "../../__tests__/helpers/sandbox-binding-row";

mockDbConnection();

const { createProject } = await import("../../db/queries/projects");
const { createConversation } = await import("../../db/queries/conversations");
const { sandboxBindings } = await import("../../db/schema");
const { AgentExecutor } = await import("../executor");
const { WorkflowExecutor } = await import("../workflow-executor");
const { EventBus } = await import("../events");

beforeAll(async () => setupTestDb(), 30_000);
afterAll(async () => closeTestDb());

describe("direct agent workspace admission", () => {
  test("a bound project cannot read an AMD canary when its target is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-bound-canary-"));
    const canaryPath = join(root, "package.json");
    await writeFile(canaryPath, "AMD_SECRET_CANARY");
    const project = await createProject({ name: "Bound agent", path: root });
    await getTestDb().insert(sandboxBindings).values(sandboxBindingRow(project.id));
    const reader: AgentDefinition = {
      name: "read-canary",
      description: "Read a workspace file",
      capabilities: ["file"],
      async execute(ctx) {
        return { success: true, output: await ctx.file.read(canaryPath) };
      },
    };
    const executor = new AgentExecutor(
      new Map([[reader.name, reader]]),
      new EventBus<AgentEvents>(),
    );
    try {
      await expect(executor.runAgent(reader.name, {}, project.id))
        .rejects.toThrow("Local workspace fallback was denied");
    } finally {
      executor.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a bound chat conversation is denied before a run starts when its target is omitted", async () => {
    const project = await createProject({ name: "Bound chat", path: "/amd/chat-canary" });
    const conversation = await createConversation(project.id, { title: "bound chat" });
    await getTestDb().insert(sandboxBindings).values(sandboxBindingRow(project.id));
    const bus = new EventBus<AgentEvents>();
    let starts = 0;
    const unsub = bus.on("run:start", () => { starts++; });
    const executor = new AgentExecutor(new Map(), bus);
    try {
      await expect(executor.streamChat(conversation.id, "read package.json", {
        projectId: project.id,
      })).rejects.toThrow("Local workspace fallback was denied");
      expect(starts).toBe(0);
    } finally {
      unsub();
      executor.destroy();
    }
  });

  test("a tool-only workflow cannot read an AMD canary when its target is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-bound-canary-"));
    const canaryPath = join(root, "package.json");
    await writeFile(canaryPath, "AMD_WORKFLOW_SECRET_CANARY");
    const project = await createProject({ name: "Bound workflow", path: root });
    await getTestDb().insert(sandboxBindings).values(sandboxBindingRow(project.id));
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);
    let hostReads = 0;
    const workflow = new WorkflowExecutor(executor, bus, {
      toolRunnerFactory: () => ({
        setCurrentUserId() {},
        async executeToolCall() {
          hostReads++;
          return { content: [{ type: "text" as const, text: await readFile(canaryPath, "utf8") }], isError: false };
        },
      }),
    });
    const definition: WorkflowDefinition = {
      name: "bound-tool-only",
      description: "Read through a workflow tool",
      steps: [{ name: "read", kind: "tool", tool: "host__read" }],
    };
    try {
      await expect(workflow.runWorkflow(definition, {}, project.id))
        .rejects.toThrow("Local workspace fallback was denied");
      expect(hostReads).toBe(0);
      const resumed = await workflow.resumeWorkflow(definition, {
        id: crypto.randomUUID(), workflowName: definition.name, status: "suspended",
        input: {}, cursor: null, definitionHash: null, projectId: project.id,
        startedAt: new Date(),
      });
      expect(resumed.status).toBe("suspended");
      expect(resumed.result).toEqual({
        success: false, output: null,
        error: expect.objectContaining({ code: "workspace-unavailable" }),
      });
      expect(hostReads).toBe(0);
    } finally {
      executor.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });
});
