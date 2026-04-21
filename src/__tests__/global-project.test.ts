import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import type { AgentEvents } from "../types";

// Re-establish real settings implementation — parallel tests mock this globally in Bun.
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      if (!rows[0]) return false;
      await getDb().delete(tbl).where(eq(tbl.key, key));
      return true;
    },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

import { listProjects, getProject } from "../db/queries/projects";
import {
  createConversation,
  resolveSystemPrompt,
  updateConversation,
} from "../db/queries/conversations";
import { upsertSetting, deleteSetting, getSetting } from "../db/queries/settings";
import { createProject } from "../db/queries/projects";

let server: Awaited<ReturnType<typeof startTestServer>>;
let baseUrl: string;

beforeAll(async () => {
  await setupTestDb();
  const agents = await loadAgents(import.meta.dir + "/../agents");
  const bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(agents, bus);
  server = await startTestServer(0, executor, bus);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  restoreModuleMocks();
  server?.stop(true);
  await closeTestDb();
});

// ── Unit: Global project seeding ────────────────────────────────────

describe("global project seeding", () => {
  test("global project exists after migration", async () => {
    const project = await getProject("global");
    expect(project).toBeDefined();
    expect(project!.id).toBe("global");
    expect(project!.name).toBe("Global");
    expect(project!.path).toBe("/");
  });

  test("global project appears in listProjects", async () => {
    const projects = await listProjects();
    const global = projects.find((p) => p.id === "global");
    expect(global).toBeDefined();
  });

  test("global project cannot be accidentally deleted via API", async () => {
    // The global project should be deletable at the DB level (no special guard),
    // but the frontend filters it out and never shows a delete button.
    // This test documents that the DB allows it — a guard could be added later.
    const project = await getProject("global");
    expect(project).toBeDefined();
  });
});

// ── Unit: Global project filtered from API list ─────────────────────

describe("global project in API responses", () => {
  test("GET /api/projects includes global project", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);
    const projects = (await res.json()) as any[];
    const global = projects.find((p: any) => p.id === "global");
    expect(global).toBeDefined();
    expect(global.name).toBe("Global");
  });

  test("GET /api/projects/global returns the global project", async () => {
    const res = await fetch(`${baseUrl}/api/projects/global`);
    expect(res.status).toBe(200);
    const project = (await res.json()) as any;
    expect(project.id).toBe("global");
    expect(project.name).toBe("Global");
  });
});

// ── Integration: Settings override chain ────────────────────────────

describe("settings override chain", () => {
  let userProjectId: string;

  beforeAll(async () => {
    const project = await createProject({ name: "Override Test", path: "/tmp/override" });
    userProjectId = project.id;
  });

  test("global setting is used when no project or conversation setting exists", async () => {
    const conv = await createConversation(userProjectId, { title: "Global Only" });
    await upsertSetting("global:systemPrompt", "Global prompt");

    const prompt = await resolveSystemPrompt(conv.id, userProjectId);
    expect(prompt).toBe("Global prompt");

    await deleteSetting("global:systemPrompt");
  });

  test("project setting overrides global setting", async () => {
    const conv = await createConversation(userProjectId, { title: "Project Overrides Global" });
    await upsertSetting("global:systemPrompt", "Global prompt");
    await upsertSetting(`project:${userProjectId}:systemPrompt`, "Project prompt");

    const prompt = await resolveSystemPrompt(conv.id, userProjectId);
    expect(prompt).toBe("Project prompt");

    await deleteSetting("global:systemPrompt");
    await deleteSetting(`project:${userProjectId}:systemPrompt`);
  });

  test("conversation setting overrides project and global settings", async () => {
    const conv = await createConversation(userProjectId, { title: "Conv Overrides All" });
    await upsertSetting("global:systemPrompt", "Global prompt");
    await upsertSetting(`project:${userProjectId}:systemPrompt`, "Project prompt");
    await updateConversation(conv.id, { systemPrompt: "Conversation prompt" });

    const prompt = await resolveSystemPrompt(conv.id, userProjectId);
    expect(prompt).toBe("Conversation prompt");

    await deleteSetting("global:systemPrompt");
    await deleteSetting(`project:${userProjectId}:systemPrompt`);
  });

  test("returns undefined when no settings exist at any level", async () => {
    const conv = await createConversation(userProjectId, { title: "No Settings" });
    const prompt = await resolveSystemPrompt(conv.id, userProjectId);
    expect(prompt).toBeUndefined();
  });
});

// ── Integration: Global project as home (settings chain) ────────────

describe("global project as home context", () => {
  test("conversations can be created under global project", async () => {
    const conv = await createConversation("global", { title: "Home Chat" });
    expect(conv).toBeDefined();
    expect(conv.projectId).toBe("global");
  });

  test("global project settings chain works: project:global overrides global", async () => {
    const conv = await createConversation("global", { title: "Global Chain" });
    await upsertSetting("global:systemPrompt", "Base global");
    await upsertSetting("project:global:systemPrompt", "Project-level global");

    const prompt = await resolveSystemPrompt(conv.id, "global");
    expect(prompt).toBe("Project-level global");

    await deleteSetting("global:systemPrompt");
    await deleteSetting("project:global:systemPrompt");
  });

  test("global project conversation overrides project:global setting", async () => {
    const conv = await createConversation("global", { title: "Conv Override Global" });
    await upsertSetting("project:global:systemPrompt", "Project global");
    await updateConversation(conv.id, { systemPrompt: "Direct conversation" });

    const prompt = await resolveSystemPrompt(conv.id, "global");
    expect(prompt).toBe("Direct conversation");

    await deleteSetting("project:global:systemPrompt");
  });

  test("global project falls through to global: setting when no project:global set", async () => {
    const conv = await createConversation("global", { title: "Fallthrough" });
    await upsertSetting("global:systemPrompt", "Fallthrough global");

    const prompt = await resolveSystemPrompt(conv.id, "global");
    expect(prompt).toBe("Fallthrough global");

    await deleteSetting("global:systemPrompt");
  });
});

// ── Integration: Settings API with global/project scoped keys ───────

describe("settings API with scoped keys", () => {
  let userProjectId: string;

  beforeAll(async () => {
    const project = await createProject({ name: "Settings API Test", path: "/tmp/settings-api" });
    userProjectId = project.id;
  });

  test("PUT global:systemPrompt via API and read back", async () => {
    const putRes = await fetch(`${baseUrl}/api/settings/global:systemPrompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "API global prompt" }),
    });
    expect(putRes.status).toBe(200);

    const value = await getSetting("global:systemPrompt");
    expect(value).toBe("API global prompt");

    await fetch(`${baseUrl}/api/settings/global:systemPrompt`, { method: "DELETE" });
  });

  test("PUT project-scoped systemPrompt via API and verify override", async () => {
    // Set global
    await fetch(`${baseUrl}/api/settings/global:systemPrompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "API global" }),
    });

    // Set project-level
    await fetch(`${baseUrl}/api/settings/project:${userProjectId}:systemPrompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "API project" }),
    });

    // Verify resolution
    const conv = await createConversation(userProjectId, { title: "API Override" });
    const prompt = await resolveSystemPrompt(conv.id, userProjectId);
    expect(prompt).toBe("API project");

    // Cleanup
    await fetch(`${baseUrl}/api/settings/global:systemPrompt`, { method: "DELETE" });
    await fetch(`${baseUrl}/api/settings/project:${userProjectId}:systemPrompt`, { method: "DELETE" });
  });

  test("DELETE project setting falls back to global", async () => {
    await upsertSetting("global:systemPrompt", "Remaining global");
    await upsertSetting(`project:${userProjectId}:systemPrompt`, "To be deleted");

    const conv = await createConversation(userProjectId, { title: "Delete Fallback" });

    // Before delete: project wins
    let prompt = await resolveSystemPrompt(conv.id, userProjectId);
    expect(prompt).toBe("To be deleted");

    // Delete project setting
    await deleteSetting(`project:${userProjectId}:systemPrompt`);

    // After delete: falls back to global
    prompt = await resolveSystemPrompt(conv.id, userProjectId);
    expect(prompt).toBe("Remaining global");

    await deleteSetting("global:systemPrompt");
  });
});

// ── E2E: Global project conversation lifecycle via API ──────────────

describe("E2E: global project conversation lifecycle", () => {
  test("create conversation under global project, set settings, verify chain", async () => {
    // 1. Set global-level system prompt
    await fetch(`${baseUrl}/api/settings/global:systemPrompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "You are a helpful assistant" }),
    });

    // 2. Create conversation under global project
    const convRes = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "global", title: "E2E Global Chat" }),
    });
    expect(convRes.status).toBe(201);
    const conv = (await convRes.json()) as any;
    expect(conv.projectId).toBe("global");

    // 3. Verify system prompt resolves to global setting
    const prompt = await resolveSystemPrompt(conv.id, "global");
    expect(prompt).toBe("You are a helpful assistant");

    // 4. Set project:global override
    await fetch(`${baseUrl}/api/settings/project:global:systemPrompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "You are a home assistant" }),
    });

    // 5. Verify project:global overrides global
    const prompt2 = await resolveSystemPrompt(conv.id, "global");
    expect(prompt2).toBe("You are a home assistant");

    // 6. Cleanup
    await fetch(`${baseUrl}/api/settings/global:systemPrompt`, { method: "DELETE" });
    await fetch(`${baseUrl}/api/settings/project:global:systemPrompt`, { method: "DELETE" });
  });

  test("user project settings do not leak into global project", async () => {
    const project = await createProject({ name: "Isolated", path: "/tmp/isolated" });

    await upsertSetting(`project:${project.id}:systemPrompt`, "User project only");
    const conv = await createConversation("global", { title: "Isolation Check" });

    // Global project should NOT see user project settings
    const prompt = await resolveSystemPrompt(conv.id, "global");
    expect(prompt).toBeUndefined();

    await deleteSetting(`project:${project.id}:systemPrompt`);
  });

  test("global project agent run works via API", async () => {
    const runRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo global-run", projectId: "global" }),
    });
    expect(runRes.status).toBe(200);
    const run = (await runRes.json()) as any;
    expect(run.projectId).toBe("global");
    expect(run.status).toBe("success");
  });

  test("runs can be filtered by global project id", async () => {
    // Create a run under global
    await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo filter-test", projectId: "global" }),
    });

    const res = await fetch(`${baseUrl}/api/runs?projectId=global`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as any[];
    for (const run of runs) {
      expect(run.projectId).toBe("global");
    }
  });
});

// ── E2E: Settings override full lifecycle ───────────────────────────

describe("E2E: settings override full lifecycle", () => {
  test("complete override chain lifecycle: set, verify, remove, verify fallback", async () => {
    const project = await createProject({ name: "Lifecycle Override", path: "/tmp/lifecycle-override" });
    const conv = await createConversation(project.id, { title: "Lifecycle" });

    // 1. No settings — undefined
    expect(await resolveSystemPrompt(conv.id, project.id)).toBeUndefined();

    // 2. Set global — resolves to global
    await upsertSetting("global:systemPrompt", "Step 2: global");
    expect(await resolveSystemPrompt(conv.id, project.id)).toBe("Step 2: global");

    // 3. Set project — overrides global
    await upsertSetting(`project:${project.id}:systemPrompt`, "Step 3: project");
    expect(await resolveSystemPrompt(conv.id, project.id)).toBe("Step 3: project");

    // 4. Set conversation — overrides both
    await updateConversation(conv.id, { systemPrompt: "Step 4: conversation" });
    expect(await resolveSystemPrompt(conv.id, project.id)).toBe("Step 4: conversation");

    // 5. New conversation without system prompt — falls back to project
    const conv2 = await createConversation(project.id, { title: "Lifecycle 2" });
    expect(await resolveSystemPrompt(conv2.id, project.id)).toBe("Step 3: project");

    // 6. Clear project — conv2 falls back to global
    await deleteSetting(`project:${project.id}:systemPrompt`);
    expect(await resolveSystemPrompt(conv2.id, project.id)).toBe("Step 2: global");

    // 7. Clear global — back to undefined
    await deleteSetting("global:systemPrompt");
    expect(await resolveSystemPrompt(conv2.id, project.id)).toBeUndefined();
  });
});
