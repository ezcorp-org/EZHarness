/**
 * Server-handler unit tests for /api/agent-configs (+server.ts).
 *
 * Covers the auth gate (401), create-schema validation (400), and a
 * happy-path POST that stubs the executor + DB query. We don't exercise
 * the real configToAgent/executor registration wiring — both live under
 * vi.mock() so the test stays off the runtime.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const registerAgent = vi.fn();

vi.mock("$server/db/queries/agent-configs", () => ({
  listAgentConfigs: vi.fn(),
  createAgentConfig: vi.fn(),
}));

vi.mock("$server/runtime/config-to-agent", () => ({
  configToAgent: vi.fn(() => ({ name: "stub", description: "", capabilities: [] })),
}));

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({ registerAgent }),
}));

// sec F3: `extensions[]` is now authorized at write time. The gate module has
// its own unit suite (agent-config-extension-gate.server.test.ts); here it is
// a seam so this file keeps testing the ROUTE — and so the forwarding test
// below is not silently answered by a real DB lookup.
let extensionGateResponse: Response | null = null;
const rejectUnauthorizedExtensions = vi.fn(async () => extensionGateResponse);
vi.mock("$lib/server/agent-config-extension-gate", () => ({
  rejectUnauthorizedExtensions: () => rejectUnauthorizedExtensions(),
}));

const { listAgentConfigs, createAgentConfig } = await import(
  "$server/db/queries/agent-configs"
);
const { GET, POST } = await import("../routes/api/agent-configs/+server.ts");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const href = "http://localhost/api/agent-configs";
  return makeRequestEvent(href, {
    locals: opts.locals ?? {},
    request: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  });
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

test("create strips caller-supplied managed provenance before writing or registering", async () => {
  vi.clearAllMocks();
  vi.mocked(createAgentConfig).mockResolvedValue({ id: "user-agent", name: "user-agent", description: "", capabilities: [], prompt: "User", managedByExtensionId: null } as Awaited<ReturnType<typeof createAgentConfig>>);
  const response = await POST(makeEvent({ locals: { user }, body: { name: "user-agent", prompt: "User", managedByExtensionId: "forged-installation" } }));
  expect(response.status).toBe(201);
  expect(createAgentConfig).toHaveBeenCalledTimes(1);
  expect(vi.mocked(createAgentConfig).mock.calls[0]![0]).not.toHaveProperty("managedByExtensionId");
});

describe("GET /api/agent-configs", () => {
  beforeEach(() => {
    vi.mocked(listAgentConfigs).mockReset();
  });

  test("rejects unauthenticated request with 401", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns list from DB query", async () => {
    vi.mocked(listAgentConfigs).mockResolvedValue([
      { id: "c1", name: "a", prompt: "p" },
    ] as any);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; name: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("c1");
    expect(listAgentConfigs).toHaveBeenCalledWith("u1");
  });
});

describe("POST /api/agent-configs", () => {
  beforeEach(() => {
    vi.mocked(createAgentConfig).mockReset();
    registerAgent.mockReset();
    rejectUnauthorizedExtensions.mockClear();
    extensionGateResponse = null;
  });

  test("rejects unauthenticated request with 401", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ locals: {}, body: { name: "x", prompt: "p" } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 400 when name missing", async () => {
    const res = await POST(
      makeEvent({ locals: { user }, body: { prompt: "p" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("rejects 400 when prompt missing", async () => {
    const res = await POST(
      makeEvent({ locals: { user }, body: { name: "a" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("rejects 400 when name exceeds max length", async () => {
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { name: "x".repeat(101), prompt: "p" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("creates config on happy path and returns 201", async () => {
    vi.mocked(createAgentConfig).mockResolvedValue({
      id: "new-cfg",
      name: "a",
      prompt: "p",
      description: null,
      capabilities: [],
      inputSchema: null,
      outputFormat: null,
      provider: null,
      model: null,
      temperature: null,
      maxTokens: null,
    } as any);
    const res = await POST(
      makeEvent({ locals: { user }, body: { name: "a", prompt: "p" } }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toBe("new-cfg");
    expect(createAgentConfig).toHaveBeenCalled();
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  test("forwards extensions + extensionTools through to the query layer", async () => {
    vi.mocked(createAgentConfig).mockResolvedValue({
      id: "cfg-et", name: "a", prompt: "p", description: null, capabilities: [],
      inputSchema: null, outputFormat: null, provider: null, model: null,
      temperature: null, maxTokens: null,
    } as any);
    const res = await POST(
      makeEvent({
        locals: { user },
        body: {
          name: "a", prompt: "p",
          extensions: ["ext-1"],
          extensionTools: { "ext-1": ["alpha"] },
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(createAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        extensions: ["ext-1"],
        extensionTools: { "ext-1": ["alpha"] },
      }),
    );
  });

  // sec F3 — `agent_configs.extensions` holds raw ids that
  // `registry.getToolsForAgent` hands to an LLM turn, and this route is
  // scope `chat` (any member). A member could name an admin-installed MCP
  // extension's id here and reach its tools by chatting with the agent.
  test("a denied extension id is refused BEFORE the row is created", async () => {
    extensionGateResponse = new Response(
      JSON.stringify({ error: "Unknown or unavailable extension(s)", unknown: ["ext-mcp"] }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    const res = await POST(
      makeEvent({ locals: { user }, body: { name: "a", prompt: "p", extensions: ["ext-mcp"] } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { unknown?: string[] }).unknown).toEqual(["ext-mcp"]);
    // Nothing persisted, and no agent registered with the executor.
    expect(createAgentConfig).not.toHaveBeenCalled();
    expect(registerAgent).not.toHaveBeenCalled();
  });

  test("the gate runs even when the body carries no extensions (it decides, not the route)", async () => {
    vi.mocked(createAgentConfig).mockResolvedValue({
      id: "cfg-x", name: "a", prompt: "p", description: null, capabilities: [],
      inputSchema: null, outputFormat: null, provider: null, model: null,
      temperature: null, maxTokens: null,
    } as never);
    await POST(makeEvent({ locals: { user }, body: { name: "a", prompt: "p" } }));
    // Keeping the call unconditional means the route can never grow a path
    // that skips authorization by accident; the helper short-circuits.
    expect(rejectUnauthorizedExtensions).toHaveBeenCalledTimes(1);
  });

  test("rejects 400 when extensionTools value is not a string array", async () => {
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { name: "a", prompt: "p", extensionTools: { "ext-1": "nope" } },
      }),
    );
    expect(res.status).toBe(400);
  });
});
