import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { createProject } from "../db/queries/projects";
import { createConversation, getConversation } from "../db/queries/conversations";
import type { AgentDefinition, AgentEvents, AgentRun } from "../types";

mockDbConnection();

function makeAgent(name: string, fn: AgentDefinition["execute"]): AgentDefinition {
  return { name, description: `${name} agent`, capabilities: ["shell"], execute: fn };
}

// Seed an in-memory "running" run + runConversations mapping directly. This mirrors
// the executor unit-test seam: runAgent doesn't populate runConversations (that only
// happens via streamChat, which requires an LLM), so tests poke the internal maps.
function seedRunningRun(
  executor: AgentExecutor,
  opts: { runId: string; agentName: string; conversationId: string; projectId?: string; startedAt?: number; status?: AgentRun["status"] },
): AgentRun {
  const run: AgentRun = {
    id: opts.runId,
    agentName: opts.agentName,
    projectId: opts.projectId,
    status: opts.status ?? "running",
    startedAt: opts.startedAt ?? Date.now(),
    logs: [],
  };
  (executor as any).runs.set(run.id, run);
  (executor as any).runConversations.set(run.id, opts.conversationId);
  return run;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let executor: AgentExecutor;
let bus: EventBus<AgentEvents>;
let projectAId: string;
let projectBId: string;

beforeAll(async () => {
  await setupTestDb();

  const agents = loadAgentsStatic([
    makeAgent("chat", async () => ({ success: true, output: null })),
  ]);
  bus = new EventBus<AgentEvents>();
  executor = new AgentExecutor(agents, bus, { persist: true });

  // Inline Bun.serve re-implementing the +server.ts logic. Importing the SvelteKit
  // handler directly would pull in $app/$lib request helpers, so we glue the pure
  // pieces (executor.listActiveAgentRuns + getConversation) into a minimal server.
  server = Bun.serve({
    port: 0,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/active-agents") {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        const active = executor.listActiveAgentRuns(projectId);
        const rows = await Promise.all(
          active.map(async ({ run, conversationId }) => {
            const conv = await getConversation(conversationId);
            if (projectId && conv?.projectId !== projectId) return null;
            return {
              runId: run.id,
              agentName: run.agentName,
              conversationId,
              parentConversationId: conv?.parentConversationId ?? null,
              projectId: conv?.projectId ?? run.projectId ?? null,
              conversationTitle: conv?.title ?? null,
              startedAt: run.startedAt,
            };
          }),
        );
        return new Response(JSON.stringify(rows.filter((r) => r !== null)), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  baseUrl = `http://localhost:${server.port}`;

  const projectA = await createProject({ name: "Project A", path: "/tmp/active-agents-a" });
  const projectB = await createProject({ name: "Project B", path: "/tmp/active-agents-b" });
  projectAId = projectA.id;
  projectBId = projectB.id;
});

afterAll(async () => {
  server?.stop(true);
  await closeTestDb();
});

function clearRuns() {
  (executor as any).runs.clear();
  (executor as any).runConversations.clear();
}

describe("GET /api/active-agents", () => {
  test("returns [] when no active runs", async () => {
    clearRuns();
    const res = await fetch(`${baseUrl}/api/active-agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test("returns a row for a running run with correct shape and DB-enriched title", async () => {
    clearRuns();
    const conv = await createConversation(projectAId, { title: "hello A" });
    const startedAt = Date.now();
    seedRunningRun(executor, {
      runId: "run-a",
      agentName: "chat",
      conversationId: conv.id,
      projectId: projectAId,
      startedAt,
    });

    const res = await fetch(`${baseUrl}/api/active-agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      runId: "run-a",
      agentName: "chat",
      conversationId: conv.id,
      parentConversationId: null,
      projectId: projectAId,
      conversationTitle: "hello A",
      startedAt,
    });
    // Sanity: the enriched title is non-null when the conversation exists.
    expect(body[0].conversationTitle).not.toBeNull();
  });

  test("?projectId filter excludes runs whose conversation belongs to another project", async () => {
    clearRuns();
    const convA = await createConversation(projectAId, { title: "A conv" });
    const convB = await createConversation(projectBId, { title: "B conv" });

    // Both runs tagged as project A at the run level, but their *conversations* differ.
    // The handler filters by conv.projectId when projectId is supplied, so the run
    // pointing at convB must be excluded.
    seedRunningRun(executor, { runId: "run-for-a", agentName: "chat", conversationId: convA.id, projectId: projectAId });
    seedRunningRun(executor, { runId: "run-for-b", agentName: "chat", conversationId: convB.id, projectId: projectBId });

    const res = await fetch(`${baseUrl}/api/active-agents?projectId=${projectAId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe("run-for-a");
    expect(body[0].conversationId).toBe(convA.id);
    expect(body[0].projectId).toBe(projectAId);
  });

  test("surfaces parentConversationId when the run's conversation is a sub-conversation", async () => {
    clearRuns();
    const parent = await createConversation(projectAId, { title: "parent" });
    const child = await createConversation(projectAId, {
      title: "child",
      parentConversationId: parent.id,
    });

    seedRunningRun(executor, {
      runId: "run-sub",
      agentName: "chat",
      conversationId: child.id,
      projectId: projectAId,
    });

    const res = await fetch(`${baseUrl}/api/active-agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe("run-sub");
    expect(body[0].conversationId).toBe(child.id);
    expect(body[0].parentConversationId).toBe(parent.id);
  });

  test("unfiltered fetch returns runs from multiple projects so the home view can group them", async () => {
    clearRuns();
    const convA = await createConversation(projectAId, { title: "A conv" });
    const convB = await createConversation(projectBId, { title: "B conv" });

    seedRunningRun(executor, { runId: "run-a", agentName: "chat", conversationId: convA.id, projectId: projectAId });
    seedRunningRun(executor, { runId: "run-b", agentName: "chat", conversationId: convB.id, projectId: projectBId });

    const res = await fetch(`${baseUrl}/api/active-agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    // Row-level projectId reflects each conversation's project — required for
    // client-side grouping to put the rows under the correct headers.
    const byRun = new Map<string, { projectId: string | null }>(
      body.map((r: { runId: string; projectId: string | null }) => [r.runId, r]),
    );
    expect(byRun.get("run-a")?.projectId).toBe(projectAId);
    expect(byRun.get("run-b")?.projectId).toBe(projectBId);
  });

  test("?projectId filter keeps sub-agent runs whose sub-conversation belongs to that project", async () => {
    clearRuns();
    const parent = await createConversation(projectAId, { title: "parent in A" });
    const child = await createConversation(projectAId, {
      title: "sub-agent in A",
      parentConversationId: parent.id,
    });
    // A control run in project B that must NOT appear.
    const convB = await createConversation(projectBId, { title: "B conv" });

    seedRunningRun(executor, { runId: "run-sub-a", agentName: "chat", conversationId: child.id, projectId: projectAId });
    seedRunningRun(executor, { runId: "run-b", agentName: "chat", conversationId: convB.id, projectId: projectBId });

    const res = await fetch(`${baseUrl}/api/active-agents?projectId=${projectAId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe("run-sub-a");
    expect(body[0].parentConversationId).toBe(parent.id);
    expect(body[0].projectId).toBe(projectAId);
  });

  test("excludes runs whose status is not 'running'", async () => {
    clearRuns();
    const convRunning = await createConversation(projectAId, { title: "running" });
    const convDone = await createConversation(projectAId, { title: "done" });

    seedRunningRun(executor, {
      runId: "run-running",
      agentName: "chat",
      conversationId: convRunning.id,
      projectId: projectAId,
    });
    seedRunningRun(executor, {
      runId: "run-success",
      agentName: "chat",
      conversationId: convDone.id,
      projectId: projectAId,
      status: "success",
    });

    const res = await fetch(`${baseUrl}/api/active-agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe("run-running");
  });
});
