/**
 * Server-handler unit tests for /api/agent-configs (+server.ts).
 *
 * Covers the auth gate (401), create-schema validation (400), and a
 * happy-path POST that stubs the executor + DB query. We don't exercise
 * the real configToAgent/executor registration wiring — both live under
 * vi.mock() so the test stays off the runtime.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

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

const { listAgentConfigs, createAgentConfig } = await import(
  "$server/db/queries/agent-configs"
);
const { GET, POST } = await import("../routes/api/agent-configs/+server.ts");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const href = "http://localhost/api/agent-configs";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

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
});
