/**
 * Server-handler unit tests for /api/agents (+server.ts).
 *
 * Covers the auth gate (requireAuth throws 401) and the happy path that
 * merges file-based agents with DB-backed agent configs. The executor
 * and agent-config query are mocked to keep the test off the runtime.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const listAgents = vi.fn();

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({ listAgents }),
}));

vi.mock("$server/db/queries/agent-configs", () => ({
  listAgentConfigs: vi.fn(),
}));

const { listAgentConfigs } = await import("$server/db/queries/agent-configs");
const { GET } = await import("../routes/api/agents/+server.ts");

function makeEvent(opts: { locals?: Record<string, unknown> }) {
  const href = "http://localhost/api/agents";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/agents", () => {
  beforeEach(() => {
    listAgents.mockReset();
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

  test("returns empty array when no file agents and no DB configs", async () => {
    listAgents.mockReturnValue([]);
    vi.mocked(listAgentConfigs).mockResolvedValue([] as any);

    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  test("marks file-only agents source=file and DB-only agents source=config", async () => {
    listAgents.mockReturnValue([
      {
        name: "file-agent",
        description: "desc",
        capabilities: [],
        inputSchema: null,
      },
    ]);
    vi.mocked(listAgentConfigs).mockResolvedValue([
      {
        id: "cfg-1",
        name: "db-agent",
        description: "db desc",
        prompt: "sys",
        capabilities: [],
        inputSchema: null,
        category: null,
      },
    ] as any);

    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      name: string;
      source: string;
      id: string | null;
    }>;
    expect(body).toHaveLength(2);
    const file = body.find((a) => a.name === "file-agent")!;
    const db = body.find((a) => a.name === "db-agent")!;
    expect(file.source).toBe("file");
    expect(file.id).toBeNull();
    expect(db.source).toBe("config");
    expect(db.id).toBe("cfg-1");
  });

  test("file agent overlaid by same-named DB config has source=config and id set", async () => {
    listAgents.mockReturnValue([
      {
        name: "shared-name",
        description: "file-desc",
        capabilities: [],
        inputSchema: null,
      },
    ]);
    vi.mocked(listAgentConfigs).mockResolvedValue([
      {
        id: "cfg-42",
        name: "shared-name",
        description: "db-desc",
        prompt: "sys",
        capabilities: [],
        inputSchema: null,
        category: "test",
      },
    ] as any);

    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      name: string;
      source: string;
      id: string | null;
      category: string | null;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0].source).toBe("config");
    expect(body[0].id).toBe("cfg-42");
    expect(body[0].category).toBe("test");
  });

  test("multi-agent listing preserves per-row category including null", async () => {
    listAgents.mockReturnValue([]);
    vi.mocked(listAgentConfigs).mockResolvedValue([
      {
        id: "cfg-a",
        name: "agent-a",
        description: "",
        prompt: "p",
        capabilities: [],
        inputSchema: null,
        category: "Productivity",
      },
      {
        id: "cfg-b",
        name: "agent-b",
        description: "",
        prompt: "p",
        capabilities: [],
        inputSchema: null,
        category: null,
      },
      {
        id: "cfg-c",
        name: "agent-c",
        description: "",
        prompt: "p",
        capabilities: [],
        inputSchema: null,
        category: "Engineering",
      },
    ] as any);

    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string; category: string | null }>;
    expect(body).toHaveLength(3);
    // Per-row preservation; sort by name to be order-stable
    const byName = Object.fromEntries(body.map((a) => [a.name, a.category]));
    expect(byName["agent-a"]).toBe("Productivity");
    expect(byName["agent-b"]).toBeNull();
    expect(byName["agent-c"]).toBe("Engineering");
  });
});
