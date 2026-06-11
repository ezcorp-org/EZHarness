/**
 * Server-handler unit tests for /api/tools/+server.ts.
 *
 * The GET handler merges built-in tool metadata with ExtensionRegistry
 * tools. We mock both so the test stays off the runtime context init
 * path. Covers auth/scope gates and the merged-list happy path.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getAllTools = vi.fn(() => [] as Array<{ name: string; description: string }>);
const getExtensionType = vi.fn((_name: string) => "local");
const getExtensionDescription = vi.fn((_name: string): string | undefined => undefined);
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getAllTools,
      getExtensionType,
      getExtensionDescription,
    }),
  },
}));

vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => undefined),
}));

const getBuiltInToolMetadata = vi.fn(
  () =>
    [] as Array<{ name: string; description: string; category: string }>,
);
const getBuiltInCategoryDescription = vi.fn((_cat: string): string | undefined => undefined);
vi.mock("$server/runtime/tools/builtin-registry", () => ({
  getBuiltInToolMetadata,
  getBuiltInCategoryDescription,
}));

const { GET } = await import("../routes/api/tools/+server");

function makeEvent(opts: { locals?: Record<string, unknown> }) {
  return {
    url: new URL("http://localhost/api/tools"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/tools"),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

async function expectThrown(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  let res: Response | undefined;
  try {
    res = await fn();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  expect(res!.status).toBe(status);
  return res!;
}

describe("GET /api/tools", () => {
  beforeEach(() => {
    getAllTools.mockReset();
    getAllTools.mockReturnValue([]);
    getBuiltInToolMetadata.mockReset();
    getBuiltInToolMetadata.mockReturnValue([]);
    getExtensionType.mockReturnValue("local");
  });

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => GET(makeEvent({})), 401);
  });

  test("rejects 403 when API-key lacks 'read' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
  });

  test("returns merged built-in + extension tools with correct shape", async () => {
    getBuiltInToolMetadata.mockReturnValue([
      { name: "task_write", description: "desc", category: "task-tracking" },
    ]);
    getAllTools.mockReturnValue([
      { name: "my-ext__do_thing", description: "ext-desc" },
      { name: "bad-no-sep", description: "ext-other" },
    ]);
    getExtensionType.mockImplementation((name: string) =>
      name === "my-ext" ? "local" : "unknown",
    );
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools?: Array<{
        name: string;
        extension: string;
        extensionType: string;
      }>;
      count?: number;
    };
    expect(body.count).toBe(3);
    const names = body.tools!.map((t) => t.name);
    expect(names).toContain("task_write");
    expect(names).toContain("do_thing");
    expect(names).toContain("bad-no-sep");
    const doThing = body.tools!.find((t) => t.name === "do_thing")!;
    expect(doThing.extension).toBe("my-ext");
    const noSep = body.tools!.find((t) => t.name === "bad-no-sep")!;
    expect(noSep.extension).toBe("unknown");
    const builtIn = body.tools!.find((t) => t.name === "task_write")!;
    expect(builtIn.extensionType).toBe("built-in");
    expect(builtIn.extension).toBe("task-tracking");
  });
});
