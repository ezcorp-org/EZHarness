import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import type { AgentDefinition, AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
// ── Helpers ──────────────────────────────────────────────────────────

function makeAgent(
  name: string,
  fn: AgentDefinition["execute"],
  inputSchema?: AgentDefinition["inputSchema"],
): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    capabilities: ["shell"],
    inputSchema,
    execute: fn,
  };
}

// ── 1. Unit: inferSchema logic (type inference from project vars) ────

describe("Project variable type inference", () => {
  // We replicate the inferSchema/toTitleCase logic from the Svelte component
  // to unit-test it independently of the browser runtime.

  function toTitleCase(key: string): string {
    return key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  type InputField = {
    type: string;
    label: string;
    default?: unknown;
  };

  function inferSchema(
    vars: Record<string, unknown>,
    existing: Record<string, { type: string }>,
  ): Record<string, InputField> {
    const extra: Record<string, InputField> = {};
    for (const [key, value] of Object.entries(vars)) {
      if (key in existing) continue;
      const type =
        typeof value === "boolean"
          ? "boolean"
          : typeof value === "number"
            ? "number"
            : "string";
      extra[key] = { type, label: toTitleCase(key), default: value };
    }
    return extra;
  }

  test("string values produce string fields", () => {
    const result = inferSchema({ apiKey: "sk-123" }, {});
    expect(result.apiKey).toEqual({
      type: "string",
      label: "Api Key",
      default: "sk-123",
    });
  });

  test("number values produce number fields", () => {
    const result = inferSchema({ maxTokens: 4096 }, {});
    expect(result.maxTokens).toEqual({
      type: "number",
      label: "Max Tokens",
      default: 4096,
    });
  });

  test("boolean values produce boolean fields", () => {
    const result = inferSchema({ verbose: true }, {});
    expect(result.verbose).toEqual({
      type: "boolean",
      label: "Verbose",
      default: true,
    });
  });

  test("object/array values fall through to string type", () => {
    const result = inferSchema(
      { config: { nested: true }, tags: ["a", "b"] },
      {},
    );
    expect(result.config!.type).toBe("string");
    expect(result.tags!.type).toBe("string");
  });

  test("null values fall through to string type", () => {
    const result = inferSchema({ empty: null }, {});
    expect(result.empty!.type).toBe("string");
  });

  test("overlapping keys are excluded from extra schema", () => {
    const agentSchema = {
      provider: { type: "select" },
    };
    const result = inferSchema(
      { provider: "google", apiKey: "sk-123" },
      agentSchema,
    );
    expect(result.provider).toBeUndefined();
    expect(result.apiKey).toBeDefined();
  });

  test("empty project variables produce empty schema", () => {
    const result = inferSchema({}, { name: { type: "string" } });
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("all project variable keys overlap → empty extra schema", () => {
    const agentSchema = {
      provider: { type: "select" },
      model: { type: "string" },
    };
    const result = inferSchema(
      { provider: "google", model: "pro" },
      agentSchema,
    );
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("toTitleCase converts camelCase correctly", () => {
    expect(toTitleCase("apiKey")).toBe("Api Key");
    expect(toTitleCase("maxTokens")).toBe("Max Tokens");
    expect(toTitleCase("outputFormat")).toBe("Output Format");
  });

  test("toTitleCase converts snake_case correctly", () => {
    expect(toTitleCase("api_key")).toBe("Api Key");
    expect(toTitleCase("max_tokens")).toBe("Max Tokens");
  });

  test("toTitleCase converts kebab-case correctly", () => {
    expect(toTitleCase("api-key")).toBe("Api Key");
  });

  test("toTitleCase handles single word", () => {
    expect(toTitleCase("provider")).toBe("Provider");
  });

  test("mixed types inferred correctly", () => {
    const result = inferSchema(
      {
        name: "test",
        count: 42,
        enabled: false,
        data: { nested: 1 },
      },
      {},
    );
    expect(result.name!.type).toBe("string");
    expect(result.count!.type).toBe("number");
    expect(result.enabled!.type).toBe("boolean");
    expect(result.enabled!.default).toBe(false);
    expect(result.data!.type).toBe("string");
  });
});

// ── 2. Unit: buildDefaults merges agent schema + extra vars + overrides ──

describe("buildDefaults merging", () => {
  type InputField = { type: string; label: string; default?: unknown };
  type Schema = Record<string, InputField>;

  function buildDefaults(
    s: Schema,
    extra: Schema,
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    const base = Object.fromEntries(
      Object.entries(s).map(([key, field]) => [
        key,
        field.default ?? (field.type === "boolean" ? false : ""),
      ]),
    );
    const extraBase = Object.fromEntries(
      Object.entries(extra).map(([key, field]) => [
        key,
        field.default ?? (field.type === "boolean" ? false : ""),
      ]),
    );
    return { ...base, ...extraBase, ...overrides };
  }

  test("agent schema defaults are set", () => {
    const schema: Schema = {
      provider: { type: "select", label: "Provider", default: "anthropic" },
      model: { type: "string", label: "Model" },
    };
    const result = buildDefaults(schema, {}, {});
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("");
  });

  test("extra var defaults are included", () => {
    const extra: Schema = {
      apiKey: { type: "string", label: "Api Key", default: "sk-123" },
    };
    const result = buildDefaults({}, extra, {});
    expect(result.apiKey).toBe("sk-123");
  });

  test("overrides take precedence over both schemas", () => {
    const schema: Schema = {
      provider: { type: "select", label: "Provider", default: "anthropic" },
    };
    const extra: Schema = {
      apiKey: { type: "string", label: "Api Key", default: "old-key" },
    };
    const result = buildDefaults(schema, extra, {
      provider: "google",
      apiKey: "new-key",
    });
    expect(result.provider).toBe("google");
    expect(result.apiKey).toBe("new-key");
  });

  test("boolean fields without default get false", () => {
    const schema: Schema = {
      verbose: { type: "boolean", label: "Verbose" },
    };
    const result = buildDefaults(schema, {}, {});
    expect(result.verbose).toBe(false);
  });

  test("non-boolean fields without default get empty string", () => {
    const schema: Schema = {
      name: { type: "string", label: "Name" },
      count: { type: "number", label: "Count" },
    };
    const result = buildDefaults(schema, {}, {});
    expect(result.name).toBe("");
    expect(result.count).toBe("");
  });
});

// ── 3. Integration: Executor resolveInput merges project variables ──

describe("Executor resolveInput with project variables", () => {
  let executor: AgentExecutor;
  let receivedInput: Record<string, unknown>;

  beforeAll(async () => {
    await setupTestDb();
    const agents = loadAgentsStatic([
      makeAgent(
        "capture-input",
        async (ctx) => {
          receivedInput = ctx.input;
          return { success: true, output: ctx.input };
        },
        {
          provider: {
            type: "select",
            label: "Provider",
            options: ["anthropic", "google", "openai"],
            default: "anthropic",
          },
          text: { type: "text", label: "Text", required: true },
        },
      ),
      makeAgent("no-schema", async (ctx) => {
        receivedInput = ctx.input;
        return { success: true, output: ctx.input };
      }),
    ]);
    const bus = new EventBus<AgentEvents>();
    executor = new AgentExecutor(agents, bus, { persist: true });
  });

  afterAll(async () => await closeTestDb());

  test("project variables are merged into agent input", async () => {
    // Create a project with variables
    const { createProject } = await import("../db/queries/projects");
    const project = await createProject({
      name: "test-proj-vars",
      path: "/tmp/test",
      variables: { apiKey: "sk-test-123", temperature: 0.7 },
    });

    await executor.runAgent(
      "capture-input",
      { text: "hello", provider: "google" },
      project.id,
    );

    expect(receivedInput.text).toBe("hello");
    expect(receivedInput.provider).toBe("google"); // explicit input wins
    expect(receivedInput.apiKey).toBe("sk-test-123"); // from project vars
    expect(receivedInput.temperature).toBe(0.7); // from project vars
    expect(receivedInput.cwd).toBe("/tmp/test"); // project path injected as cwd
  });

  test("explicit input overrides project variables", async () => {
    const { createProject } = await import("../db/queries/projects");
    const project = await createProject({
      name: "test-override",
      path: "/tmp/test2",
      variables: { provider: "openai", apiKey: "proj-key" },
    });

    await executor.runAgent(
      "capture-input",
      { text: "test", provider: "anthropic", apiKey: "user-key" },
      project.id,
    );

    expect(receivedInput.provider).toBe("anthropic"); // explicit wins over project var
    expect(receivedInput.apiKey).toBe("user-key"); // explicit wins over project var
  });

  test("no project ID means no project variables or cwd merged", async () => {
    await executor.runAgent("capture-input", { text: "plain" });

    expect(receivedInput.text).toBe("plain");
    expect(receivedInput.apiKey).toBeUndefined();
    expect(receivedInput.cwd).toBeUndefined();
  });

  test("project path is injected as cwd", async () => {
    const { createProject } = await import("../db/queries/projects");
    const project = await createProject({
      name: "test-cwd-inject",
      path: "/home/user/myproject",
      variables: {},
    });

    await executor.runAgent("capture-input", { text: "test" }, project.id);

    expect(receivedInput.cwd).toBe("/home/user/myproject");
  });

  test("explicit cwd in input overrides project path", async () => {
    const { createProject } = await import("../db/queries/projects");
    const project = await createProject({
      name: "test-cwd-override",
      path: "/home/user/project",
      variables: {},
    });

    await executor.runAgent(
      "capture-input",
      { text: "test", cwd: "/custom/dir" },
      project.id,
    );

    expect(receivedInput.cwd).toBe("/custom/dir"); // explicit wins
  });

  test("project variable cwd overrides project path cwd", async () => {
    const { createProject } = await import("../db/queries/projects");
    const project = await createProject({
      name: "test-var-cwd",
      path: "/home/user/project",
      variables: { cwd: "/var/override" },
    });

    await executor.runAgent("capture-input", { text: "test" }, project.id);

    expect(receivedInput.cwd).toBe("/var/override"); // variable overrides path
  });

  test("agent without schema still receives project variables", async () => {
    const { createProject } = await import("../db/queries/projects");
    const project = await createProject({
      name: "test-no-schema",
      path: "/tmp/test3",
      variables: { customVar: "hello", count: 5 },
    });

    await executor.runAgent(
      "no-schema",
      { arbitrary: "data" },
      project.id,
    );

    expect(receivedInput.arbitrary).toBe("data");
    expect(receivedInput.customVar).toBe("hello");
    expect(receivedInput.count).toBe(5);
  });
});

// ── 4. Integration: Server API round-trip with project variables ────

describe("Server API: project variables in agent runs", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;
  let receivedInput: Record<string, unknown>;

  beforeAll(async () => {
    await setupTestDb();
    const captureAgent = makeAgent(
      "capture",
      async (ctx) => {
        receivedInput = ctx.input;
        return { success: true, output: ctx.input };
      },
      {
        provider: {
          type: "select",
          label: "Provider",
          options: ["anthropic", "google"],
          default: "anthropic",
        },
        text: { type: "text", label: "Text", required: true },
      },
    );
    const noSchemaAgent = makeAgent("bare", async (ctx) => {
      receivedInput = ctx.input;
      return { success: true, output: ctx.input };
    });

    const agents = loadAgentsStatic([captureAgent, noSchemaAgent]);
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(agents, bus, { persist: true });
    server = await startServer(0, executor, bus);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server?.stop(true);
    await closeTestDb();
  });

  test("create project with variables and run agent with projectId", async () => {
    // Create project via API
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "api-test-proj",
        path: "/tmp/api-test",
        variables: { apiKey: "proj-api-key", debugMode: true },
      }),
    });
    expect(projRes.status).toBe(201);
    const project = (await projRes.json()) as { id: string };

    // Run agent with projectId
    const runRes = await fetch(`${baseUrl}/api/agents/capture/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "test input",
        provider: "google",
        projectId: project.id,
      }),
    });
    expect(runRes.status).toBe(200);
    const run = (await runRes.json()) as { status: string; result: { output: Record<string, unknown> } };

    expect(run.status).toBe("success");
    // Project variables are merged into input
    expect(receivedInput.apiKey).toBe("proj-api-key");
    expect(receivedInput.debugMode).toBe(true);
    // Explicit input preserved
    expect(receivedInput.text).toBe("test input");
    expect(receivedInput.provider).toBe("google");
  });

  test("agent without schema receives project variables via API", async () => {
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bare-proj",
        path: "/tmp/bare",
        variables: { customField: "value123", retries: 3 },
      }),
    });
    const project = (await projRes.json()) as { id: string };

    const runRes = await fetch(`${baseUrl}/api/agents/bare/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        freeForm: "data",
        projectId: project.id,
      }),
    });
    expect(runRes.status).toBe(200);

    expect(receivedInput.freeForm).toBe("data");
    expect(receivedInput.customField).toBe("value123");
    expect(receivedInput.retries).toBe(3);
  });

  test("run without projectId has no project variables", async () => {
    const runRes = await fetch(`${baseUrl}/api/agents/capture/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "no project" }),
    });
    expect(runRes.status).toBe(200);

    expect(receivedInput.text).toBe("no project");
    expect(receivedInput.apiKey).toBeUndefined();
    expect(receivedInput.debugMode).toBeUndefined();
  });

  test("GET /api/projects/:id returns variables for frontend consumption", async () => {
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "vars-check",
        path: "/tmp/vars",
        variables: { provider: "google", apiKey: "key-abc", verbose: false },
      }),
    });
    const project = (await projRes.json()) as { id: string };

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { variables: Record<string, unknown> };

    expect(fetched.variables).toEqual({
      provider: "google",
      apiKey: "key-abc",
      verbose: false,
    });
  });

  test("PUT /api/projects/:id updates variables and subsequent run uses new values", async () => {
    // Create project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "update-vars",
        path: "/tmp/update",
        variables: { apiKey: "old-key" },
      }),
    });
    const project = (await projRes.json()) as { id: string };

    // Update variables
    const putRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variables: { apiKey: "new-key", extra: "val" } }),
    });
    expect(putRes.status).toBe(200);

    // Run agent — should use updated variables
    await fetch(`${baseUrl}/api/agents/capture/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "after update", projectId: project.id }),
    });

    expect(receivedInput.apiKey).toBe("new-key");
    expect(receivedInput.extra).toBe("val");
  });
});

// ── 5. E2E: Frontend data flow simulation ───────────────────────────
// Simulates what the Svelte components do: deriving extra schema,
// building form defaults, and collecting form values for submission.

describe("E2E: frontend form data flow", () => {
  function toTitleCase(key: string): string {
    return key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  type InputField = {
    type: string;
    label: string;
    default?: unknown;
    required?: boolean;
    options?: string[];
  };
  type Schema = Record<string, InputField>;

  function inferSchema(
    vars: Record<string, unknown>,
    existing: Schema,
  ): Schema {
    const extra: Schema = {};
    for (const [key, value] of Object.entries(vars)) {
      if (key in existing) continue;
      const type =
        typeof value === "boolean"
          ? "boolean"
          : typeof value === "number"
            ? "number"
            : "string";
      extra[key] = { type, label: toTitleCase(key), default: value };
    }
    return extra;
  }

  function buildDefaults(
    s: Schema,
    extra: Schema,
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    const base = Object.fromEntries(
      Object.entries(s).map(([key, field]) => [
        key,
        field.default ?? (field.type === "boolean" ? false : ""),
      ]),
    );
    const extraBase = Object.fromEntries(
      Object.entries(extra).map(([key, field]) => [
        key,
        field.default ?? (field.type === "boolean" ? false : ""),
      ]),
    );
    return { ...base, ...extraBase, ...overrides };
  }

  function collectInput(
    formData: Record<string, unknown>,
    schema: Schema,
    extraVarSchema: Schema,
  ): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    for (const [key, field] of Object.entries({ ...schema, ...extraVarSchema })) {
      const val = formData[key];
      if (val !== undefined && val !== null && val !== "") {
        input[key] = val;
      } else if (field.type === "boolean") {
        input[key] = val;
      }
    }
    return input;
  }

  test("full flow: agent with schema + project variables with overlap", () => {
    const agentSchema: Schema = {
      text: { type: "text", label: "Text", required: true },
      provider: {
        type: "select",
        label: "Provider",
        options: ["anthropic", "google"],
        default: "anthropic",
      },
    };
    const projectVars = {
      provider: "google", // overlaps → skipped in extraVarSchema
      apiKey: "sk-project",
      maxTokens: 2048,
      stream: true,
    };

    // Step 1: Derive extra schema
    const extraVarSchema = inferSchema(projectVars, agentSchema);
    expect(Object.keys(extraVarSchema)).toEqual(["apiKey", "maxTokens", "stream"]);
    expect(extraVarSchema.apiKey!.type).toBe("string");
    expect(extraVarSchema.maxTokens!.type).toBe("number");
    expect(extraVarSchema.stream!.type).toBe("boolean");

    // Step 2: Build defaults (projectVars also act as overrides/defaults)
    const formData = buildDefaults(agentSchema, extraVarSchema, projectVars);
    expect(formData.text).toBe(""); // no default, no override
    expect(formData.provider).toBe("google"); // override from project vars
    expect(formData.apiKey).toBe("sk-project");
    expect(formData.maxTokens).toBe(2048);
    expect(formData.stream).toBe(true);

    // Step 3: User fills in required field
    formData.text = "Hello world";

    // Step 4: Collect input for submission
    const input = collectInput(formData, agentSchema, extraVarSchema);
    expect(input).toEqual({
      text: "Hello world",
      provider: "google",
      apiKey: "sk-project",
      maxTokens: 2048,
      stream: true,
    });
  });

  test("full flow: agent without schema + project variables", () => {
    const agentSchema: Schema = {};
    const projectVars = { env: "production", retries: 3, debug: false };

    const extraVarSchema = inferSchema(projectVars, agentSchema);
    expect(Object.keys(extraVarSchema)).toEqual(["env", "retries", "debug"]);

    const formData = buildDefaults(agentSchema, extraVarSchema, projectVars);
    expect(formData.env).toBe("production");
    expect(formData.retries).toBe(3);
    expect(formData.debug).toBe(false);

    const input = collectInput(formData, agentSchema, extraVarSchema);
    expect(input).toEqual({
      env: "production",
      retries: 3,
      debug: false, // boolean false is included
    });
  });

  test("full flow: no active project → no extra fields", () => {
    const agentSchema: Schema = {
      text: { type: "text", label: "Text", required: true },
    };
    const projectVars = {};

    const extraVarSchema = inferSchema(projectVars, agentSchema);
    expect(Object.keys(extraVarSchema)).toHaveLength(0);

    const formData = buildDefaults(agentSchema, extraVarSchema, projectVars);
    expect(Object.keys(formData)).toEqual(["text"]);

    formData.text = "test";
    const input = collectInput(formData, agentSchema, extraVarSchema);
    expect(input).toEqual({ text: "test" });
  });

  test("empty optional string fields are omitted from submission", () => {
    const agentSchema: Schema = {
      text: { type: "text", label: "Text", required: true },
    };
    const extraVarSchema: Schema = {
      apiKey: { type: "string", label: "Api Key", default: "" },
    };

    const formData = buildDefaults(agentSchema, extraVarSchema, {});
    formData.text = "hello";
    // apiKey stays as ""

    const input = collectInput(formData, agentSchema, extraVarSchema);
    expect(input).toEqual({ text: "hello" });
    expect(input.apiKey).toBeUndefined();
  });

  test("boolean false is preserved in submission", () => {
    const schema: Schema = {};
    const extra: Schema = {
      enabled: { type: "boolean", label: "Enabled", default: false },
    };

    const formData = buildDefaults(schema, extra, {});
    expect(formData.enabled).toBe(false);

    const input = collectInput(formData, schema, extra);
    expect(input.enabled).toBe(false);
  });
});

// ── 6. E2E: Full server round-trip matching frontend flow ───────────

describe("E2E: server round-trip with project variable auto-populate", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;
  let receivedInput: Record<string, unknown>;

  beforeAll(async () => {
    await setupTestDb();
    const agent = makeAgent(
      "e2e-agent",
      async (ctx) => {
        receivedInput = ctx.input;
        return { success: true, output: ctx.input };
      },
      {
        text: { type: "text", label: "Text", required: true },
        provider: {
          type: "select",
          label: "Provider",
          options: ["anthropic", "google", "openai"],
          default: "anthropic",
        },
        model: { type: "string", label: "Model" },
      },
    );

    const agents = loadAgentsStatic([agent]);
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(agents, bus, { persist: true });
    server = await startServer(0, executor, bus);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server?.stop(true);
    await closeTestDb();
  });

  test("simulates full frontend → backend flow with project variables", async () => {
    // 1. Create project with variables (some overlapping agent schema, some new)
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "e2e-project",
        path: "/tmp/e2e",
        variables: {
          provider: "google", // overlaps agent schema
          apiKey: "sk-e2e-key", // new variable
          temperature: 0.8, // new variable (number)
          verbose: true, // new variable (boolean)
        },
      }),
    });
    expect(projRes.status).toBe(201);
    const project = (await projRes.json()) as { id: string; variables: Record<string, unknown> };

    // 2. Frontend fetches project to get variables
    const getProj = await fetch(`${baseUrl}/api/projects/${project.id}`);
    const projectData = (await getProj.json()) as { variables: Record<string, unknown> };
    const projectVars = (projectData.variables as Record<string, unknown>) ?? {};

    // 3. Frontend fetches agent to get inputSchema
    const agentsRes = await fetch(`${baseUrl}/api/agents`);
    const agentsList = (await agentsRes.json()) as Array<{
      name: string;
      inputSchema?: Record<string, { type: string }>;
    }>;
    const agentDef = agentsList.find((a) => a.name === "e2e-agent")!;
    const agentSchema = agentDef.inputSchema!;

    // 4. Frontend derives extra schema (simulating AgentInputForm logic)
    const extraKeys = Object.keys(projectVars).filter((k) => !(k in agentSchema)).sort();
    expect(extraKeys).toEqual(["apiKey", "temperature", "verbose"]);
    // "provider" is excluded because it's in the agent schema

    // 5. Frontend submits form with merged values
    const formInput = {
      text: "Summarize this document",
      provider: "google", // from project var default (overlapping key)
      apiKey: "sk-e2e-key", // from project var (extra field)
      temperature: 0.8, // from project var (extra field)
      verbose: true, // from project var (extra field)
      projectId: project.id,
    };

    const runRes = await fetch(`${baseUrl}/api/agents/e2e-agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formInput),
    });
    expect(runRes.status).toBe(200);
    const run = (await runRes.json()) as { status: string };
    expect(run.status).toBe("success");

    // 6. Verify backend received all values correctly
    expect(receivedInput.text).toBe("Summarize this document");
    expect(receivedInput.provider).toBe("google");
    expect(receivedInput.apiKey).toBe("sk-e2e-key");
    expect(receivedInput.temperature).toBe(0.8);
    expect(receivedInput.verbose).toBe(true);
  });

  test("user override in form takes precedence over project variable", async () => {
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "override-proj",
        path: "/tmp/override",
        variables: { provider: "openai", apiKey: "proj-key" },
      }),
    });
    const project = (await projRes.json()) as { id: string };

    // User changes provider in the form (overriding project default)
    await fetch(`${baseUrl}/api/agents/e2e-agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "test",
        provider: "anthropic", // user changed from project default
        apiKey: "user-override-key", // user changed from project default
        projectId: project.id,
      }),
    });

    // Explicit input wins over project variables
    expect(receivedInput.provider).toBe("anthropic");
    expect(receivedInput.apiKey).toBe("user-override-key");
  });
});
