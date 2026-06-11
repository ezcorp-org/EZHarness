/**
 * Server-handler unit tests for /api/agent-configs/[id] (+server.ts).
 *
 * Covers GET/PUT/DELETE auth gate (401), ownership/missing (404) paths,
 * and the happy path with mocked DB + executor. The config->agent
 * registration wiring is mocked so we stay off the runtime.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const registerAgent = vi.fn();
const unregisterAgent = vi.fn();

vi.mock("$server/db/queries/agent-configs", () => ({
  getAgentConfig: vi.fn(),
  updateAgentConfig: vi.fn(),
  deleteAgentConfig: vi.fn(),
}));

vi.mock("$server/runtime/config-to-agent", () => ({
  configToAgent: vi.fn(() => ({ name: "stub", description: "", capabilities: [] })),
}));

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({ registerAgent, unregisterAgent }),
}));

const { getAgentConfig, updateAgentConfig, deleteAgentConfig } = await import(
  "$server/db/queries/agent-configs"
);
const { GET, PUT, DELETE } = await import(
  "../routes/api/agent-configs/[id]/+server.ts"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const id = opts.id ?? "cfg-1";
  const href = `http://localhost/api/agent-configs/${id}`;
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const admin = { id: "a1", email: "a@x", name: "a", role: "admin" };

// NULL-userId rows are SYSTEM-owned (e.g. the shared "Daily Briefing"
// agent minted at boot) — readable by everyone, mutable by admins only.
const systemConfig = { id: "cfg-sys", userId: null, name: "Daily Briefing" };

async function expectThrown(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  let res: Response | undefined;
  try {
    res = await fn();
    if (!res || res.status !== status) expect.fail("expected thrown Response");
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  expect(res!.status).toBe(status);
  return res!;
}

describe("GET /api/agent-configs/[id]", () => {
  beforeEach(() => vi.mocked(getAgentConfig).mockReset());

  test("rejects 401 when unauthenticated", async () => {
    await expectThrown(() => GET(makeEvent({ locals: {} })), 401);
  });

  test("returns 404 when config is missing", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(undefined);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("returns 404 when config is owned by another user", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      id: "cfg-1",
      userId: "other",
    } as any);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("returns config on happy path", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      id: "cfg-1",
      userId: "u1",
      name: "a",
    } as any);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("cfg-1");
  });

  test("system (NULL-owner) config stays readable by a regular member", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(systemConfig as any);
    const res = await GET(makeEvent({ id: "cfg-sys", locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("cfg-sys");
  });
});

describe("PUT /api/agent-configs/[id]", () => {
  beforeEach(() => {
    vi.mocked(getAgentConfig).mockReset();
    vi.mocked(updateAgentConfig).mockReset();
    registerAgent.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    await expectThrown(
      () => PUT(makeEvent({ locals: {}, body: { name: "b" } })),
      401,
    );
  });

  test("returns 404 when config is missing", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(undefined);
    const res = await PUT(makeEvent({ locals: { user }, body: { name: "b" } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("returns 404 when config is owned by another user", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      id: "cfg-1",
      userId: "other",
    } as any);
    const res = await PUT(makeEvent({ locals: { user }, body: { name: "b" } }));
    expect(res.status).toBe(404);
  });

  test("returns 404 when updateAgentConfig reports missing row", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      id: "cfg-1",
      userId: "u1",
      name: "a",
    } as any);
    vi.mocked(updateAgentConfig).mockResolvedValue(undefined);
    const res = await PUT(makeEvent({ locals: { user }, body: { name: "b" } }));
    expect(res.status).toBe(404);
  });

  test("updates config on happy path and returns 200", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      id: "cfg-1",
      userId: "u1",
      name: "a",
    } as any);
    vi.mocked(updateAgentConfig).mockResolvedValue({
      id: "cfg-1",
      userId: "u1",
      name: "b",
      description: null,
      prompt: "p",
      capabilities: [],
      inputSchema: null,
      outputFormat: null,
      provider: null,
      model: null,
      temperature: null,
      maxTokens: null,
    } as any);
    const res = await PUT(makeEvent({ locals: { user }, body: { name: "b" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("b");
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  test("returns 403 when a member PUTs a system (NULL-owner) config", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(systemConfig as any);
    const res = await expectThrown(
      () => PUT(makeEvent({ id: "cfg-sys", locals: { user }, body: { prompt: "hijacked" } })),
      403,
    );
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Insufficient permissions/);
    expect(updateAgentConfig).not.toHaveBeenCalled();
  });

  test("admin can still PUT a system (NULL-owner) config", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(systemConfig as any);
    vi.mocked(updateAgentConfig).mockResolvedValue({
      ...systemConfig,
      description: "tuned",
      prompt: "p",
      capabilities: [],
    } as any);
    const res = await PUT(makeEvent({ id: "cfg-sys", locals: { user: admin }, body: { description: "tuned" } }));
    expect(res.status).toBe(200);
    expect(updateAgentConfig).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/agent-configs/[id]", () => {
  beforeEach(() => {
    vi.mocked(getAgentConfig).mockReset();
    vi.mocked(deleteAgentConfig).mockReset();
    unregisterAgent.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    await expectThrown(() => DELETE(makeEvent({ locals: {} })), 401);
  });

  test("returns 404 when config is missing", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(undefined);
    const res = await DELETE(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("returns 404 when config is owned by another user", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      id: "cfg-1",
      userId: "other",
    } as any);
    const res = await DELETE(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("deletes on happy path and returns 200", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      id: "cfg-1",
      userId: "u1",
      name: "a",
    } as any);
    vi.mocked(deleteAgentConfig).mockResolvedValue(true as any);
    const res = await DELETE(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(unregisterAgent).toHaveBeenCalledWith("a");
  });

  test("returns 403 when a member DELETEs a system (NULL-owner) config (no adopt-by-recreate)", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(systemConfig as any);
    await expectThrown(() => DELETE(makeEvent({ id: "cfg-sys", locals: { user } })), 403);
    expect(deleteAgentConfig).not.toHaveBeenCalled();
    expect(unregisterAgent).not.toHaveBeenCalled();
  });

  test("admin can still DELETE a system (NULL-owner) config", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(systemConfig as any);
    vi.mocked(deleteAgentConfig).mockResolvedValue(true as any);
    const res = await DELETE(makeEvent({ id: "cfg-sys", locals: { user: admin } }));
    expect(res.status).toBe(200);
    expect(deleteAgentConfig).toHaveBeenCalledTimes(1);
    expect(unregisterAgent).toHaveBeenCalledWith("Daily Briefing");
  });
});
