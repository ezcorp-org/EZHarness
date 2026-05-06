import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EzcorpClient } from "../../src/client.js";
import { register, TOOLS } from "../../src/mcp/tools/discover.js";
import { startStubServer, type StubServer } from "../fixtures/stub-server.js";

describe("tools/discover", () => {
  let stub: StubServer;
  let client: EzcorpClient;
  let server: McpServer;

  beforeEach(() => {
    stub = startStubServer();
    client = new EzcorpClient({ baseUrl: stub.url });
    server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    register(server, client);
  });

  afterEach(() => stub.stop());

  test("TOOLS constant has 6 entries with correct names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("list_agents");
    expect(names).toContain("search_mentions");
    expect(names).toContain("list_models");
    expect(names).toContain("list_extensions");
    expect(names).toContain("extension_search");
    expect(TOOLS).toHaveLength(6);
  });

  test("list_extensions description carries DEPRECATED marker", () => {
    const tool = TOOLS.find((t) => t.name === "list_extensions")!;
    expect(tool.description).toContain("DEPRECATED");
    expect(tool.description).toContain("extension_search");
  });

  test("extension_search description mentions tools projection", () => {
    const tool = TOOLS.find((t) => t.name === "extension_search")!;
    expect(tool.description.toLowerCase()).toContain("tools");
    expect(tool.description.toLowerCase()).toContain("name");
    expect(tool.description.toLowerCase()).toContain("description");
  });

  test("list_projects returns stub project list", async () => {
    const projects = await client.listProjects();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects[0]).toMatchObject({ id: "global", name: "Global" });
  });

  test("list_agents returns empty list by default", async () => {
    const agents = await client.listAgents();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents).toHaveLength(0);
  });

  test("search_mentions returns hits for a query", async () => {
    const hits = await client.searchMentions({ q: "test" });
    expect(Array.isArray(hits)).toBe(true);
    expect(hits[0]).toMatchObject({ name: "test-match" });
  });

  test("search_mentions with type filter passes type to stub", async () => {
    const hits = await client.searchMentions({ q: "foo", type: "agent" });
    expect(hits[0]).toMatchObject({ kind: "agent" });
  });

  test("list_models returns model list", async () => {
    const models = await client.listModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  test("list_extensions returns empty array", async () => {
    const exts = await client.listExtensions();
    expect(Array.isArray(exts)).toBe(true);
  });

  test("all tool descriptions are action-oriented (start with a verb)", () => {
    for (const tool of TOOLS) {
      // description should start with a capital letter verb phrase
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  describe("extension_search", () => {
    function seedExtensions() {
      stub.state.extensions = [
        {
          id: "ext-1",
          name: "weather",
          version: "1.0.0",
          description: "Get current weather and forecasts",
          enabled: true,
          manifest: {
            tools: [
              { name: "get_current", description: "Get current conditions", inputSchema: { type: "object", properties: { city: { type: "string" } } } },
              { name: "get_forecast", description: "Get a 5-day forecast", inputSchema: { type: "object" } },
            ],
          },
        },
        {
          id: "ext-2",
          name: "notes",
          version: "0.2.1",
          description: "Persist user notes across conversations",
          enabled: true,
          manifest: {
            tools: [
              { name: "create_note", description: "Create a note", inputSchema: {} },
            ],
          },
        },
        {
          id: "ext-3",
          name: "calendar-skills",
          version: "1.1.0",
          description: "Skill-only calendar helper",
          enabled: false,
          // skill-only extension: no tools field
          manifest: {},
        },
      ];
    }

    test("returns all extensions when query is omitted", async () => {
      seedExtensions();
      const hits = await client.searchExtensions();
      expect(hits).toHaveLength(3);
      expect(hits.map((h) => h.name)).toEqual(["weather", "notes", "calendar-skills"]);
    });

    test("filters by case-insensitive substring match on name", async () => {
      seedExtensions();
      const hits = await client.searchExtensions("WEATHER");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.name).toBe("weather");
    });

    test("filters by case-insensitive substring match on description", async () => {
      seedExtensions();
      const hits = await client.searchExtensions("forecast");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.name).toBe("weather");
    });

    test("returns curated tools projection without inputSchema", async () => {
      seedExtensions();
      const [hit] = await client.searchExtensions("weather");
      expect(hit!.tools).toEqual([
        { name: "get_current", description: "Get current conditions" },
        { name: "get_forecast", description: "Get a 5-day forecast" },
      ]);
      // Defensive: ensure inputSchema didn't leak in
      for (const tool of hit!.tools) {
        expect((tool as unknown as Record<string, unknown>).inputSchema).toBeUndefined();
      }
    });

    test("returns tools: [] for skill-only extensions with no manifest.tools", async () => {
      seedExtensions();
      const hits = await client.searchExtensions("calendar");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.tools).toEqual([]);
    });

    test("returns empty array when query matches nothing", async () => {
      seedExtensions();
      const hits = await client.searchExtensions("nonexistent-xyz");
      expect(hits).toEqual([]);
    });

    test("trims and lowercases the query", async () => {
      seedExtensions();
      const hits = await client.searchExtensions("  Notes  ");
      expect(hits).toHaveLength(1);
      expect(hits[0]!.name).toBe("notes");
    });

    test("returns hits with the expected curated shape", async () => {
      seedExtensions();
      const [hit] = await client.searchExtensions("notes");
      expect(hit).toMatchObject({
        id: "ext-2",
        name: "notes",
        version: "0.2.1",
        description: "Persist user notes across conversations",
        enabled: true,
      });
      expect(Array.isArray(hit!.tools)).toBe(true);
    });
  });
});
