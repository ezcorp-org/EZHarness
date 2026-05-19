/**
 * Server-handler unit tests for /api/extensions/[name]/tools (+server.ts).
 *
 * Auth-gated read of the tools a given extension (by name) exposes via
 * the ExtensionRegistry singleton. The registry and built-in-tools
 * helper are mocked so tests don't need a live runtime.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getAllTools = vi.fn();

vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ getAllTools }),
  },
}));

vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => undefined),
}));

vi.mock("$server/runtime/tools/builtin-registry", () => ({
  getBuiltInToolsByCategory: vi.fn(),
}));

const { getBuiltInToolsByCategory } = await import(
  "$server/runtime/tools/builtin-registry"
);
const { GET } = await import(
  "../routes/api/extensions/[name]/tools/+server.ts"
);

function makeEvent(opts: {
  name?: string;
  locals?: Record<string, unknown>;
}) {
  const name = opts.name ?? "my-ext";
  return {
    url: new URL(`http://localhost/api/extensions/${name}/tools`),
    locals: opts.locals ?? {},
    params: { name },
    request: new Request(`http://localhost/api/extensions/${name}/tools`),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/extensions/[name]/tools", () => {
  beforeEach(() => {
    getAllTools.mockReset();
    vi.mocked(getBuiltInToolsByCategory).mockReset();
  });

  test("unauthenticated request throws 401", async () => {
    getAllTools.mockReturnValue([]);
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

  test("404 when no extension tools and no built-in category matches", async () => {
    getAllTools.mockReturnValue([]);
    vi.mocked(getBuiltInToolsByCategory).mockReturnValue([]);
    const res = await GET(makeEvent({ locals: { user }, name: "unknown-ext" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("No tools found for extension");
  });

  test("returns built-in tools when no extension tools but category matches", async () => {
    getAllTools.mockReturnValue([]);
    vi.mocked(getBuiltInToolsByCategory).mockReturnValue([
      { name: "scratch-set", description: "d", inputSchema: {} },
    ]);
    const res = await GET(
      makeEvent({ locals: { user }, name: "scratchpad" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string }> };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("scratch-set");
  });

  test("returns namespaced extension tools with prefix stripped", async () => {
    getAllTools.mockReturnValue([
      { name: "my-ext.do-thing", description: "d1", inputSchema: {} },
      { name: "my-ext.other", description: "d2", inputSchema: {} },
      { name: "other-ext.tool", description: "d3", inputSchema: {} },
    ]);
    const res = await GET(makeEvent({ locals: { user }, name: "my-ext" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: Array<{ name: string; description: string }>;
    };
    expect(body.tools).toHaveLength(2);
    expect(body.tools.map((t) => t.name).sort()).toEqual(["do-thing", "other"]);
  });
});
