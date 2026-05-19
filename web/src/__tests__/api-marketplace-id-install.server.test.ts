/**
 * Server-handler unit tests for /api/marketplace/[id]/install (+server.ts).
 *
 * Walks the install pipeline branches: auth gate, missing-listing 404,
 * malformed-body 400 (zod schema), missing version 404, no-agent
 * manifest 400, the name-collision rename branch, and the happy path.
 * All DB writes are mocked so the test stays off PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/marketplace", () => ({
  getListingById: vi.fn(),
  incrementInstallCount: vi.fn(async () => undefined),
}));

vi.mock("$server/db/queries/marketplace-versions", () => ({
  getLatestVersion: vi.fn(),
  getVersion: vi.fn(),
}));

vi.mock("$server/db/queries/agent-configs", () => ({
  createAgentConfig: vi.fn(),
  getAgentConfigByName: vi.fn(),
}));

vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

vi.mock("$server/db/queries/settings", () => ({
  upsertSetting: vi.fn(async () => undefined),
}));

const { getListingById, incrementInstallCount } = await import(
  "$server/db/queries/marketplace"
);
const { getLatestVersion, getVersion } = await import(
  "$server/db/queries/marketplace-versions"
);
const { createAgentConfig, getAgentConfigByName } = await import(
  "$server/db/queries/agent-configs"
);
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { upsertSetting } = await import("$server/db/queries/settings");
const { POST } = await import(
  "../routes/api/marketplace/[id]/install/+server.ts"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const id = opts.id ?? "listing-1";
  const href = `http://localhost/api/marketplace/${id}/install`;
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

const fullManifest = {
  name: "Marketplace Agent",
  description: "An agent",
  agent: {
    prompt: "you are an agent",
    capabilities: { tools: ["foo"] },
    category: "research",
    temperature: 0.5,
    maxTokens: 1024,
    outputFormat: "text",
    inputSchema: { type: "object" },
  },
};

describe("POST /api/marketplace/[id]/install", () => {
  beforeEach(() => {
    vi.mocked(getListingById).mockReset();
    vi.mocked(incrementInstallCount).mockClear();
    vi.mocked(getLatestVersion).mockReset();
    vi.mocked(getVersion).mockReset();
    vi.mocked(createAgentConfig).mockReset();
    vi.mocked(getAgentConfigByName).mockReset();
    vi.mocked(insertAuditEntry).mockClear();
    vi.mocked(upsertSetting).mockClear();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ locals: {}, body: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 403 when apiKeyScopes lacks 'extensions'", async () => {
    const res = await POST(
      makeEvent({
        locals: { user, apiKeyScopes: ["read", "chat"] },
        body: {},
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("extensions");
  });

  test("returns 404 when the listing does not exist", async () => {
    vi.mocked(getListingById).mockResolvedValue(null as any);
    const res = await POST(
      makeEvent({ locals: { user }, body: {} }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
    expect(getLatestVersion).not.toHaveBeenCalled();
  });

  test("returns 400 when body has empty version string (schema rejects)", async () => {
    vi.mocked(getListingById).mockResolvedValue({
      id: "listing-1",
    } as any);
    const res = await POST(
      makeEvent({ locals: { user }, body: { version: "" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid request body");
  });

  test("returns 404 when no version record can be resolved", async () => {
    vi.mocked(getListingById).mockResolvedValue({
      id: "listing-1",
    } as any);
    vi.mocked(getLatestVersion).mockResolvedValue(null as any);
    const res = await POST(
      makeEvent({ locals: { user }, body: {} }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Version not found");
    expect(getLatestVersion).toHaveBeenCalledWith("listing-1");
    expect(getVersion).not.toHaveBeenCalled();
  });

  test("explicit version param routes to getVersion, not getLatestVersion", async () => {
    vi.mocked(getListingById).mockResolvedValue({
      id: "listing-1",
    } as any);
    vi.mocked(getVersion).mockResolvedValue(null as any);
    const res = await POST(
      makeEvent({ locals: { user }, body: { version: "1.2.3" } }),
    );
    expect(res.status).toBe(404);
    expect(getVersion).toHaveBeenCalledWith("listing-1", "1.2.3");
    expect(getLatestVersion).not.toHaveBeenCalled();
  });

  test("returns 400 when manifest has no agent definition", async () => {
    vi.mocked(getListingById).mockResolvedValue({
      id: "listing-1",
    } as any);
    vi.mocked(getLatestVersion).mockResolvedValue({
      version: "1.0.0",
      manifest: { name: "X", description: "x" }, // no agent
    } as any);
    const res = await POST(
      makeEvent({ locals: { user }, body: {} }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Listing has no agent definition");
  });

  test("happy path: creates agent config, upserts provenance, increments count, audits", async () => {
    vi.mocked(getListingById).mockResolvedValue({
      id: "listing-1",
    } as any);
    vi.mocked(getLatestVersion).mockResolvedValue({
      version: "2.0.0",
      manifest: fullManifest,
    } as any);
    vi.mocked(getAgentConfigByName).mockResolvedValue(null as any);
    vi.mocked(createAgentConfig).mockResolvedValue({
      id: "agent-1",
      name: "Marketplace Agent",
      description: "An agent",
    } as any);

    const res = await POST(
      makeEvent({ locals: { user }, body: {} }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agentConfig: { id: string; name: string };
      extensionsNeeded: unknown[];
    };
    expect(body.agentConfig.id).toBe("agent-1");
    expect(body.extensionsNeeded).toEqual([]);

    // Side-effect: createAgentConfig propagates manifest fields + the
    // calling user's id
    expect(createAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Marketplace Agent",
        description: "An agent",
        prompt: "you are an agent",
        category: "research",
        temperature: 0.5,
        maxTokens: 1024,
        outputFormat: "text",
        userId: "u1",
      }),
    );
    // Provenance row keyed by agent config id
    expect(upsertSetting).toHaveBeenCalledWith(
      "marketplace:installed:agent-1",
      expect.objectContaining({
        listingId: "listing-1",
        version: "2.0.0",
      }),
    );
    expect(incrementInstallCount).toHaveBeenCalledWith("listing-1");
    expect(insertAuditEntry).toHaveBeenCalledWith(
      "u1",
      "marketplace:install",
      "listing-1",
      { version: "2.0.0", agentConfigId: "agent-1" },
    );
  });

  test("name collision: appends '(Marketplace)' suffix when a config with the same name already exists", async () => {
    vi.mocked(getListingById).mockResolvedValue({
      id: "listing-1",
    } as any);
    vi.mocked(getLatestVersion).mockResolvedValue({
      version: "1.0.0",
      manifest: fullManifest,
    } as any);
    vi.mocked(getAgentConfigByName).mockResolvedValue({
      id: "existing-cfg",
    } as any);
    vi.mocked(createAgentConfig).mockResolvedValue({
      id: "agent-2",
      name: "Marketplace Agent (Marketplace)",
    } as any);

    const res = await POST(
      makeEvent({ locals: { user }, body: {} }),
    );
    expect(res.status).toBe(201);
    expect(createAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Marketplace Agent (Marketplace)",
      }),
    );
  });

  test("empty body still routes through the success path (no version param)", async () => {
    vi.mocked(getListingById).mockResolvedValue({
      id: "listing-1",
    } as any);
    vi.mocked(getLatestVersion).mockResolvedValue({
      version: "1.0.0",
      manifest: fullManifest,
    } as any);
    vi.mocked(getAgentConfigByName).mockResolvedValue(null as any);
    vi.mocked(createAgentConfig).mockResolvedValue({
      id: "agent-3",
      name: "Marketplace Agent",
    } as any);

    // No body at all → handler does request.json().catch(() => ({}))
    const href = "http://localhost/api/marketplace/listing-1/install";
    const res = await POST({
      url: new URL(href),
      locals: { user },
      params: { id: "listing-1" },
      request: new Request(href, { method: "POST" }),
    } as any);
    expect(res.status).toBe(201);
    expect(getLatestVersion).toHaveBeenCalledWith("listing-1");
  });
});
