import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgents, loadAgentsStatic } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import type { AgentDefinition, AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
// ── 1. CLI run with --input skips prompts ───────────────────────────

describe("CLI run with --input", () => {
  test("skips prompts and outputs result with stdout", async () => {
    await setupTestDb();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { cli } = await import("../cli");
      await cli(["run", "shell-runner", "--input", '{"command":"echo e2e-test"}']);
    } finally {
      console.log = originalLog;
    }

    const result = JSON.parse(logs[logs.length - 1]!);
    expect(result.success).toBe(true);
    expect(result.output.stdout).toContain("e2e-test");
  });
});

// ── 2. Executor with inputSchema agent ──────────────────────────────

describe("Executor with inputSchema agent", () => {
  test("agent receives correct input and listAgents includes inputSchema", async () => {
    let receivedInput: Record<string, unknown> | undefined;

    const agent: AgentDefinition = {
      name: "schema-test",
      description: "Test agent with schema",
      capabilities: ["shell"],
      inputSchema: {
        name: { type: "string", label: "Name", required: true },
        count: { type: "number", label: "Count", default: 1 },
      },
      async execute(ctx) {
        receivedInput = ctx.input;
        return { success: true, output: ctx.input };
      },
    };

    const agents = loadAgentsStatic([agent]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    const run = await exec.runAgent("schema-test", { name: "hello", count: 5 });

    expect(run.status).toBe("success");
    expect(receivedInput).toEqual({ name: "hello", count: 5 });

    const listed = exec.listAgents();
    const found = listed.find((a) => a.name === "schema-test");
    expect(found).toBeDefined();
    expect(found!.inputSchema).toEqual({
      name: { type: "string", label: "Name", required: true },
      count: { type: "number", label: "Count", default: 1 },
    });
  });
});

// ── 3. Full server round-trip ───────────────────────────────────────

describe("Server round-trip with inputSchema", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;

  beforeAll(async () => {
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

  test("POST run and GET by id returns success with correct stdout", async () => {
    const postRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo roundtrip" }),
    });
    expect(postRes.status).toBe(200);
    const postRun = await postRes.json() as any;
    expect(postRun.status).toBe("success");
    expect(postRun.result.success).toBe(true);
    expect(postRun.result.output.stdout.trim()).toBe("roundtrip");

    const getRes = await fetch(`${baseUrl}/api/runs/${postRun.id}`);
    expect(getRes.status).toBe(200);
    const getRun = await getRes.json() as any;
    expect(getRun.id).toBe(postRun.id);
    expect(getRun.result.success).toBe(true);
    expect(getRun.result.output.stdout.trim()).toBe("roundtrip");
  });

  test("GET /api/agents includes inputSchema for shell-runner", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    const agents = await res.json() as any;
    const shellRunner = agents.find((a: any) => a.name === "shell-runner");
    expect(shellRunner).toBeDefined();
    expect(shellRunner.inputSchema).toBeDefined();
    expect(shellRunner.inputSchema.command).toEqual({
      type: "string",
      label: "Command",
      description: "Shell command to run",
      required: true,
    });
  });
});

// ── 4. Agent without inputSchema ────────────────────────────────────

describe("Agent without inputSchema", () => {
  test("listAgents returns agent without inputSchema as undefined", () => {
    const agent: AgentDefinition = {
      name: "no-schema",
      description: "Agent without schema",
      capabilities: ["shell"],
      async execute() {
        return { success: true, output: null };
      },
    };

    const agents = loadAgentsStatic([agent]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    const listed = exec.listAgents();
    const found = listed.find((a) => a.name === "no-schema");
    expect(found).toBeDefined();
    expect(found!.inputSchema).toBeUndefined();
  });
});

// ── 5. parseArgs distinguishes no --input from empty --input ─────

describe("parseArgs --input handling", () => {
  test("no --input yields undefined", () => {
    const { parseArgs } = require("../cli") as typeof import("../cli");
    const parsed = parseArgs(["run", "agent"]);
    expect(parsed.input).toBeUndefined();
  });

  test("--input '{}' yields empty object", () => {
    const { parseArgs } = require("../cli") as typeof import("../cli");
    const parsed = parseArgs(["run", "agent", "--input", "{}"]);
    expect(parsed.input).toEqual({});
  });
});

// ── 6. Agent with all field types ────────────────────────────────

describe("Agent with all field types", () => {
  test("agent receives correct input for every field type", async () => {
    let receivedInput: Record<string, unknown> | undefined;

    const agent: AgentDefinition = {
      name: "all-types",
      description: "Agent with every field type",
      capabilities: ["shell"],
      inputSchema: {
        name: { type: "string", label: "Name" },
        bio: { type: "text", label: "Bio" },
        age: { type: "number", label: "Age" },
        active: { type: "boolean", label: "Active" },
        role: { type: "select", label: "Role", options: ["admin", "user"] },
        config: { type: "file-path", label: "Config" },
        extra: { type: "custom", label: "Extra", component: "MyWidget" },
      },
      async execute(ctx) {
        receivedInput = ctx.input;
        return { success: true, output: ctx.input };
      },
    };

    const input = {
      name: "Alice",
      bio: "Hello world",
      age: 30,
      active: true,
      role: "admin",
      config: "/tmp/config.json",
      extra: { foo: "bar" },
    };

    const agents = loadAgentsStatic([agent]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    const run = await exec.runAgent("all-types", input);

    expect(run.status).toBe("success");
    expect(receivedInput).toEqual(input);
  });
});

// ── 7. Server WebSocket events ──────────────────────────────────

describe("Server WebSocket events", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;
  let bus: EventBus<AgentEvents>;

  beforeAll(async () => {
    await setupTestDb();
    const agents = await loadAgents(import.meta.dir + "/../agents");
    bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(agents, bus);
    server = await startServer(0, executor, bus);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server?.stop(true);
    await closeTestDb();
  });

  test("receives run:start and run:complete via WebSocket", async () => {
    const messages: { type: string }[] = [];

    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    ws.onmessage = (event) => {
      messages.push(JSON.parse(String(event.data)));
    };

    await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo ws-test" }),
    });

    // Give WebSocket messages time to arrive
    await new Promise((r) => setTimeout(r, 200));

    ws.close();

    const types = messages.map((m) => m.type);
    expect(types).toContain("run:start");
    expect(types).toContain("run:complete");
  });
});

// ── 8. Schema defaults are UI-only ──────────────────────────────

describe("Schema defaults are UI-only", () => {
  test("default value is NOT auto-applied at runtime", async () => {
    let receivedInput: Record<string, unknown> | undefined;

    const agent: AgentDefinition = {
      name: "defaults-test",
      description: "Agent with default in schema",
      capabilities: ["shell"],
      inputSchema: {
        greeting: {
          type: "string",
          label: "Greeting",
          default: "should-not-appear",
        },
      },
      async execute(ctx) {
        receivedInput = ctx.input;
        return { success: true, output: ctx.input };
      },
    };

    const agents = loadAgentsStatic([agent]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    await exec.runAgent("defaults-test", {});

    expect(receivedInput).toEqual({});
  });
});
