import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings, restoreFetch } from "./helpers/test-pglite";
import type { AgentCapability, AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
let server: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;

beforeAll(async () => {
  restoreFetch();
  mockDbConnection();
  mockRealSettings();
  await setupTestDb();
  const agents = await loadAgents(import.meta.dir + "/../agents");
  const bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(agents, bus);
  server = await startServer(0, executor, bus);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server?.stop(true);
  await closeTestDb();
});

beforeEach(() => {
  restoreFetch();
  mockDbConnection();
  mockRealSettings();
});

describe("GET /api/agents inputSchema", () => {
  test("agents include inputSchema in response", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const agents = await res.json() as any;

    const summarizer = agents.find((a: any) => a.name === "summarizer");
    const shellRunner = agents.find((a: any) => a.name === "shell-runner");

    expect(summarizer).toBeDefined();
    expect(shellRunner).toBeDefined();
    expect(summarizer.inputSchema).toBeDefined();
    expect(shellRunner.inputSchema).toBeDefined();

    // Both have the correct top-level keys
    expect(Object.keys(summarizer.inputSchema)).toEqual(["text", "file", "provider", "model"]);
    expect(Object.keys(shellRunner.inputSchema)).toEqual(["command", "cwd"]);
  });

  test("summarizer schema shape", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    const agents = await res.json() as any;
    const schema = agents.find((a: any) => a.name === "summarizer").inputSchema;

    // text field
    expect(schema.text.type).toBe("text");
    expect(schema.text.label).toBe("Text");
    expect(schema.text.description).toBe("Text to summarize");
    expect(schema.text.required).toBe(true);

    // file field
    expect(schema.file.type).toBe("file-path");
    expect(schema.file.label).toBe("File");
    expect(schema.file.description).toBe("Or read from file path");

    // provider field
    expect(schema.provider.type).toBe("select");
    expect(schema.provider.label).toBe("Provider");
    expect(schema.provider.options).toEqual(["anthropic", "google", "openai", "openrouter"]);
    expect(schema.provider.default).toBe("anthropic");

    // model field
    expect(schema.model.type).toBe("string");
    expect(schema.model.label).toBe("Model");
    expect(schema.model.description).toBe("Override model name");
  });

  test("shell-runner schema shape", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    const agents = await res.json() as any;
    const schema = agents.find((a: any) => a.name === "shell-runner").inputSchema;

    // command field
    expect(schema.command.type).toBe("string");
    expect(schema.command.label).toBe("Command");
    expect(schema.command.description).toBe("Shell command to run");
    expect(schema.command.required).toBe(true);

    // cwd field
    expect(schema.cwd.type).toBe("file-path");
    expect(schema.cwd.label).toBe("Working Directory");
    expect(schema.cwd.description).toBe("Directory to run in");
  });

  test("schema field properties are complete", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    const agents = await res.json() as any;

    for (const agent of agents) {
      if (!agent.inputSchema) continue;
      for (const [_key, field] of Object.entries(agent.inputSchema) as [string, any][]) {
        // Every field must have type and label
        expect(field.type).toBeDefined();
        expect(field.label).toBeDefined();
        expect(typeof field.type).toBe("string");
        expect(typeof field.label).toBe("string");

        // Select fields must have options
        if (field.type === "select") {
          expect(Array.isArray(field.options)).toBe(true);
          expect(field.options.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("POST /api/agents/:name/run with schema-matching input", () => {
  test("shell-runner accepts schema-valid input", async () => {
    const res = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo schema-test" }),
    });
    expect(res.status).toBe(200);
    const run = await res.json() as any;
    expect(run.agentName).toBe("shell-runner");
    expect(run.status).toBe("success");
    expect(run.result.success).toBe(true);
    expect(run.result.output.stdout.trim()).toBe("schema-test");
  });

  test("run is retrievable by ID via GET /api/runs/:id", async () => {
    const postRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo retrieve-test" }),
    });
    const postRun = await postRes.json() as any;

    const getRes = await fetch(`${baseUrl}/api/runs/${postRun.id}`);
    expect(getRes.status).toBe(200);
    const getRun = await getRes.json() as any;
    expect(getRun.id).toBe(postRun.id);
    expect(getRun.agentName).toBe("shell-runner");
    expect(getRun.result.output.stdout.trim()).toBe("retrieve-test");
  });

  test("shell-runner with optional cwd field works", async () => {
    const { realpathSync } = require("node:fs");
    // On macOS, /tmp is a symlink to /private/tmp; resolve to the real path
    const realTmp = realpathSync("/tmp");
    const res = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "pwd", cwd: "/tmp" }),
    });
    expect(res.status).toBe(200);
    const run = await res.json() as any;
    expect(run.status).toBe("success");
    expect(run.result.output.stdout.trim()).toBe(realTmp);
  });

  test("shell-runner fails gracefully when required command is missing", async () => {
    const res = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const run = await res.json() as any;
    expect(run.result.success).toBe(false);
    expect(run.result.error).toContain("command");
  });
});

describe("agents without inputSchema via API", () => {
  let noSchemaServer: Awaited<ReturnType<typeof startServer>>;
  let noSchemaUrl: string;

  beforeAll(async () => {
    const { loadAgentsStatic } = await import("../runtime/loader");
    const noSchemaAgent = {
      name: "bare-agent",
      description: "Agent with no schema",
      capabilities: ["shell"] as AgentCapability[],
      async execute() {
        return { success: true, output: "ok" };
      },
    };
    const agents = loadAgentsStatic([noSchemaAgent]);
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(agents, bus);
    noSchemaServer = await startServer(0, executor, bus);
    noSchemaUrl = `http://localhost:${noSchemaServer.port}`;
  });

  afterAll(() => {
    noSchemaServer?.stop(true);
  });

  test("API omits inputSchema when agent has none", async () => {
    const res = await fetch(`${noSchemaUrl}/api/agents`);
    const agents = await res.json() as any;
    const bare = agents.find((a: any) => a.name === "bare-agent");
    expect(bare).toBeDefined();
    expect(bare.inputSchema).toBeUndefined();
    expect(bare.name).toBe("bare-agent");
    expect(bare.description).toBe("Agent with no schema");
  });

  test("agent without schema still runs with arbitrary input", async () => {
    const res = await fetch(`${noSchemaUrl}/api/agents/bare-agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anything: "goes" }),
    });
    expect(res.status).toBe(200);
    const run = await res.json() as any;
    expect(run.status).toBe("success");
    expect(run.result.output).toBe("ok");
  });
});

describe("additional inputSchema and run tests", () => {
  const VALID_FIELD_TYPES = new Set([
    "string",
    "text",
    "number",
    "boolean",
    "select",
    "file-path",
    "custom",
  ]);

  test("all field types are valid", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    const agents = await res.json() as any;

    for (const agent of agents) {
      if (!agent.inputSchema) continue;
      for (const [_key, field] of Object.entries(agent.inputSchema) as [string, any][]) {
        expect(VALID_FIELD_TYPES.has(field.type)).toBe(true);
      }
    }
  });

  test("POST with extra fields still succeeds", async () => {
    const res = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo hi", extraField: "ignored" }),
    });
    expect(res.status).toBe(200);
    const run = await res.json() as any;
    expect(run.status).toBe("success");
    expect(run.result.output.stdout.trim()).toBe("hi");
  });

  test("POST with only required fields succeeds", async () => {
    const res = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo minimal" }),
    });
    expect(res.status).toBe(200);
    const run = await res.json() as any;
    expect(run.status).toBe("success");
    expect(run.result.output.stdout.trim()).toBe("minimal");
  });

  test("multiple sequential runs appear in GET /api/runs", async () => {
    const headers = { "Content-Type": "application/json" };
    await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST", headers,
      body: JSON.stringify({ command: "echo run1" }),
    });
    await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST", headers,
      body: JSON.stringify({ command: "echo run2" }),
    });
    await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST", headers,
      body: JSON.stringify({ command: "echo run3" }),
    });

    const res = await fetch(`${baseUrl}/api/runs`);
    expect(res.status).toBe(200);
    const runs = await res.json() as any;
    expect(runs.length).toBeGreaterThanOrEqual(3);
  });

  test("GET /api/agents response shape", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const agents = await res.json() as any;

    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(typeof agent.name).toBe("string");
      expect(typeof agent.description).toBe("string");
      expect(Array.isArray(agent.capabilities)).toBe(true);
    }
  });
});
