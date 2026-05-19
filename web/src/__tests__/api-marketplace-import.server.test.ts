/**
 * Server-handler unit tests for /api/marketplace/import (+server.ts).
 *
 * Validation-first: the import endpoint consumes a manifest JSON body
 * (NOT a tarball — there is no archive extraction in this handler).
 * Covers auth gate, schema validation failures, manifest semantic
 * validation (validateManifestV2), and the "no agent component" guard.
 * DB and manifest validator are mocked at their module boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/extensions/manifest", () => ({
  validateManifestV2: vi.fn(),
}));

vi.mock("$server/db/queries/agent-configs", () => ({
  createAgentConfig: vi.fn(),
  getAgentConfigByName: vi.fn(),
}));

vi.mock("$server/db/queries/settings", () => ({
  upsertSetting: vi.fn(async () => undefined),
}));

const { validateManifestV2 } = await import("$server/extensions/manifest");
const { createAgentConfig, getAgentConfigByName } = await import(
  "$server/db/queries/agent-configs"
);
const { POST } = await import("../routes/api/marketplace/import/+server.ts");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const href = "http://localhost/api/marketplace/import";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body ?? {}),
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

const validManifestBody = {
  schemaVersion: 2,
  name: "TestAgent",
  version: "1.0.0",
  description: "A test agent manifest",
  agent: { prompt: "You are a test agent." },
};

describe("POST /api/marketplace/import", () => {
  beforeEach(() => {
    vi.mocked(validateManifestV2).mockReset();
    vi.mocked(createAgentConfig).mockReset();
    vi.mocked(getAgentConfigByName).mockReset();
  });

  test("unauthenticated request throws 401", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ locals: {}, body: validManifestBody }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("API-key scope check returns 403 when scope missing", async () => {
    const res = await POST(
      makeEvent({
        locals: { user, apiKeyScopes: ["read"] },
        body: validManifestBody,
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("extensions");
  });

  test("schema rejects body missing schemaVersion/name/version", async () => {
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("400 when validateManifestV2 reports semantic errors", async () => {
    vi.mocked(validateManifestV2).mockReturnValue({
      valid: false,
      errors: ["bad capability"],
    } as any);
    const res = await POST(
      makeEvent({ locals: { user }, body: validManifestBody }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; errors?: string[] };
    expect(body.error).toBe("Invalid manifest");
    expect(body.errors).toEqual(["bad capability"]);
  });

  test("400 when manifest lacks an agent component", async () => {
    vi.mocked(validateManifestV2).mockReturnValue({ valid: true } as any);
    const res = await POST(
      makeEvent({
        locals: { user },
        body: {
          schemaVersion: 2,
          name: "NoAgent",
          version: "1.0.0",
          description: "no agent block",
          // agent omitted on purpose
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("agent component");
  });

  test("happy path: creates agent config and returns 201", async () => {
    vi.mocked(validateManifestV2).mockReturnValue({ valid: true } as any);
    vi.mocked(getAgentConfigByName).mockResolvedValue(undefined as any);
    vi.mocked(createAgentConfig).mockResolvedValue({
      id: "cfg-1",
      name: "TestAgent",
    } as any);
    const res = await POST(
      makeEvent({ locals: { user }, body: validManifestBody }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agentConfig: { id: string };
      extensionsNeeded: unknown[];
    };
    expect(body.agentConfig.id).toBe("cfg-1");
    expect(body.extensionsNeeded).toEqual([]);
  });

  test("renames agent on name collision", async () => {
    vi.mocked(validateManifestV2).mockReturnValue({ valid: true } as any);
    vi.mocked(getAgentConfigByName).mockResolvedValue({
      id: "existing",
      name: "TestAgent",
    } as any);
    vi.mocked(createAgentConfig).mockResolvedValue({
      id: "cfg-2",
      name: "TestAgent (Imported)",
    } as any);
    const res = await POST(
      makeEvent({ locals: { user }, body: validManifestBody }),
    );
    expect(res.status).toBe(201);
    const call = vi.mocked(createAgentConfig).mock.calls[0]![0];
    expect(call.name).toBe("TestAgent (Imported)");
  });
});
