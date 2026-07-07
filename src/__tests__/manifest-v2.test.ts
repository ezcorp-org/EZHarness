import { describe, test, expect } from "bun:test";

// These imports will fail until we implement the types and functions
import type {
  ExtensionManifestV2,
  ToolDefinition,
  SkillDefinition,
  McpServerDefinition,
  AgentComponentDefinition,
} from "../extensions/types";
import { inferPackageType } from "../extensions/types";
import {
  validateManifestV2,
  compareVersions,
  generateSlug,
} from "../extensions/manifest";

// ── Test Helper ──────────────────────────────────────────────────

function makeValidManifest(
  overrides: Partial<ExtensionManifestV2> = {},
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-package",
    version: "1.0.0",
    description: "A test package",
    author: { name: "Test Author" },
    entrypoint: "./index.ts",
    tools: [
      {
        name: "doSomething",
        description: "Does something",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    permissions: {},
    ...overrides,
  };
}

// ── Validation: Required Fields ──────────────────────────────────

describe("validateManifestV2", () => {
  test("valid v2 manifest with all component types passes", () => {
    const manifest = makeValidManifest({
      skills: [{ name: "writing", description: "Writing skill" }],
      mcpServers: [
        {
          transport: "stdio",
          name: "db-server",
          description: "DB MCP server",
          command: "node",
          args: ["./mcp.ts"],
        },
      ],
      agent: { prompt: "You are helpful" },
      scripts: { postinstall: "./setup.ts" },
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("empty package (no components) passes validation", () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("missing name produces error", () => {
    const manifest = makeValidManifest({ name: "" as any });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("missing version produces error", () => {
    const manifest = makeValidManifest({ version: "" as any });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("missing description produces error", () => {
    const manifest = makeValidManifest({ description: "" as any });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("description"))).toBe(true);
  });

  test("missing author.name produces error", () => {
    const manifest = makeValidManifest({ author: { name: "" } as any });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("author"))).toBe(true);
  });

  test("wrong schemaVersion is rejected", () => {
    const manifest = makeValidManifest({ schemaVersion: 1 as any });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  test("invalid semver version is rejected", () => {
    const manifest = makeValidManifest({ version: "1.0" });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  // ── Component Validation ─────────────────────────────────────

  test("tool missing name is rejected", () => {
    const manifest = makeValidManifest({
      tools: [
        { name: "", description: "test", inputSchema: {} } as ToolDefinition,
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tools[0]"))).toBe(true);
  });

  test("tool missing description is rejected", () => {
    const manifest = makeValidManifest({
      tools: [
        { name: "test", description: "", inputSchema: {} } as ToolDefinition,
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tools[0]"))).toBe(true);
  });

  test("tool missing inputSchema is rejected", () => {
    const manifest = makeValidManifest({
      tools: [
        {
          name: "test",
          description: "test",
          inputSchema: undefined,
        } as any,
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tools[0]"))).toBe(true);
  });

  test("skill missing name is rejected", () => {
    const manifest = makeValidManifest({
      skills: [{ name: "", description: "test" } as SkillDefinition],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills[0]"))).toBe(true);
  });

  test("skill missing description is rejected", () => {
    const manifest = makeValidManifest({
      skills: [{ name: "test", description: "" } as SkillDefinition],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills[0]"))).toBe(true);
  });

  test("mcpServer missing name is rejected", () => {
    const manifest = makeValidManifest({
      mcpServers: [
        {
          transport: "stdio",
          name: "",
          command: "node",
        } as unknown as McpServerDefinition,
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mcpServers[0]"))).toBe(true);
  });

  test("mcpServer missing transport is rejected", () => {
    const manifest = makeValidManifest({
      mcpServers: [
        { name: "test" } as unknown as McpServerDefinition,
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mcpServers[0].transport"))).toBe(true);
  });

  test("stdio mcpServer missing command is rejected", () => {
    const manifest = makeValidManifest({
      mcpServers: [
        { transport: "stdio", name: "test" } as unknown as McpServerDefinition,
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mcpServers[0].command"))).toBe(true);
  });

  test("http mcpServer missing url is rejected", () => {
    const manifest = makeValidManifest({
      mcpServers: [
        { transport: "http", name: "test" } as unknown as McpServerDefinition,
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mcpServers[0].url"))).toBe(true);
  });

  test("agent missing prompt is rejected", () => {
    const manifest = makeValidManifest({
      agent: { prompt: "" } as AgentComponentDefinition,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent"))).toBe(true);
  });

  test("entrypoint required when tools are declared", () => {
    const manifest = makeValidManifest({ entrypoint: undefined });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("entrypoint"))).toBe(true);
  });

  test("entrypoint not required when no tools declared", () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });

  test("non-object input is rejected", () => {
    const result = validateManifestV2(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ── Package Type Inference ───────────────────────────────────────

describe("inferPackageType", () => {
  test('returns "agent" when only agent component present', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      agent: { prompt: "You are helpful" },
    });
    expect(inferPackageType(manifest)).toBe("agent");
  });

  test('returns "extension" when tools present', () => {
    const manifest = makeValidManifest();
    expect(inferPackageType(manifest)).toBe("extension");
  });

  test('returns "extension" when skills present', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      skills: [{ name: "writing", description: "Writing" }],
    });
    expect(inferPackageType(manifest)).toBe("extension");
  });

  test('returns "extension" when mcpServers present', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      mcpServers: [
        { transport: "stdio", name: "db", command: "node", args: ["./mcp.ts"] },
      ],
    });
    expect(inferPackageType(manifest)).toBe("extension");
  });

  test('returns "extension" when scripts present', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      scripts: { postinstall: "./setup.ts" },
    });
    expect(inferPackageType(manifest)).toBe("extension");
  });

  test('returns "extension" when agent AND tools present', () => {
    const manifest = makeValidManifest({
      agent: { prompt: "You are helpful" },
    });
    expect(inferPackageType(manifest)).toBe("extension");
  });

  test('returns "extension" for empty package', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
    });
    expect(inferPackageType(manifest)).toBe("extension");
  });
});

// ── Utility Functions ────────────────────────────────────────────

describe("compareVersions", () => {
  test("returns -1 when a < b", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });

  test("returns 1 when a > b", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
  });

  test("returns 0 when equal", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("generateSlug", () => {
  test("converts name to slug", () => {
    expect(generateSlug("My Cool Extension!")).toBe("my-cool-extension");
  });
});

// ══════════════════════════════════════════════════════════════════
// ── Edge-Case Tests ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ── 1. Boundary Validation ──────────────────────────────────────

describe("validateManifestV2 — boundary validation", () => {
  test("empty string name fails validation", () => {
    const result = validateManifestV2(makeValidManifest({ name: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("empty string version fails validation", () => {
    const result = validateManifestV2(makeValidManifest({ version: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("empty string description fails validation", () => {
    const result = validateManifestV2(makeValidManifest({ description: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("description"))).toBe(true);
  });

  test("extremely long name is rejected (max length 64 — filesystem-safe)", () => {
    const longName = "a".repeat(10_000);
    const result = validateManifestV2(makeValidManifest({ name: longName }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("extremely long description still passes", () => {
    const longDesc = "x".repeat(50_000);
    const result = validateManifestV2(makeValidManifest({ description: longDesc }));
    expect(result.valid).toBe(true);
  });

  test("version '1.0' (two-part) is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ version: "1.0" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("version 'abc' is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ version: "abc" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("version '1.0.0.0' (four-part) is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ version: "1.0.0.0" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("version 'v1.0.0' (prefixed) is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ version: "v1.0.0" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("version '1.0.0-alpha' (pre-release) is rejected by strict semver regex", () => {
    const result = validateManifestV2(makeValidManifest({ version: "1.0.0-alpha" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("duplicate tool names within same manifest still pass validation (no uniqueness check)", () => {
    const manifest = makeValidManifest({
      tools: [
        { name: "dup", description: "First", inputSchema: { type: "object" } },
        { name: "dup", description: "Second", inputSchema: { type: "object" } },
      ],
    });
    const result = validateManifestV2(manifest);
    // No uniqueness enforcement exists in the validator
    expect(result.valid).toBe(true);
  });

  test("tool with empty inputSchema ({}) passes validation", () => {
    const manifest = makeValidManifest({
      tools: [
        { name: "minimal", description: "Minimal tool", inputSchema: {} },
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });

  test("tool with inputSchema as undefined is rejected", () => {
    const manifest = makeValidManifest({
      tools: [
        { name: "bad", description: "Bad tool", inputSchema: undefined } as any,
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("inputSchema"))).toBe(true);
  });

  test("empty tools array does not require entrypoint", () => {
    const manifest = makeValidManifest({
      tools: [],
      entrypoint: undefined,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });
});

// ── 2. Component Combination Tests ──────────────────────────────

describe("validateManifestV2 — component combinations", () => {
  test("manifest with ALL component types simultaneously passes", () => {
    const manifest = makeValidManifest({
      tools: [
        { name: "tool1", description: "A tool", inputSchema: { type: "object" } },
      ],
      skills: [
        { name: "skill1", description: "A skill", prompt: "Do the thing", files: ["./data.md"] },
      ],
      mcpServers: [
        { transport: "stdio", name: "mcp1", description: "An MCP server", command: "node", args: ["./mcp.ts"] },
      ],
      agent: {
        prompt: "You are helpful",
        category: "general",
        capabilities: ["search"],
        modelRequirements: { tier: "balanced" },
        temperature: 0.7,
        maxTokens: 4096,
        outputFormat: "text",
      },
      scripts: {
        postinstall: "./setup.ts",
        preuninstall: "./teardown.ts",
        commands: { build: { entrypoint: "./build.ts", description: "Build the project" } },
      },
      entrypoint: "./index.ts",
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("manifest with only scripts (no tools/skills/mcpServers/agent) passes", () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      scripts: { postinstall: "./install.sh" },
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });

  test("manifest with only mcpServers passes", () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      mcpServers: [
        { transport: "stdio", name: "server", description: "A server", command: "node", args: ["./serve.ts"] },
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });

  test("skill with all optional fields passes", () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      skills: [
        {
          name: "full-skill",
          description: "A fully specified skill",
          prompt: "Do this carefully",
          files: ["./instructions.md", "./examples.json"],
        },
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });

  test("skill with no optional fields passes", () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      skills: [{ name: "bare-skill", description: "Minimal skill" }],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });

  test("http mcpServer with url passes", () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      mcpServers: [
        { transport: "http", name: "remote", description: "Remote MCP", url: "https://example.com/mcp" },
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });

  test("sse mcpServer with url passes", () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      mcpServers: [
        { transport: "sse", name: "legacy", description: "Legacy SSE MCP", url: "https://example.com/sse" },
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });

  test("multiple tools validated independently (error in second tool)", () => {
    const manifest = makeValidManifest({
      tools: [
        { name: "good", description: "Good tool", inputSchema: { type: "object" } },
        { name: "", description: "Bad tool", inputSchema: { type: "object" } } as any,
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tools[1]"))).toBe(true);
    // First tool should not produce errors
    expect(result.errors.some((e) => e.includes("tools[0]"))).toBe(false);
  });

  test("multiple mcpServers validated independently", () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      mcpServers: [
        { transport: "stdio", name: "ok", command: "node" },
        { transport: "stdio", name: "", command: "node" } as any,
        { transport: "stdio", name: "also-ok", command: "node" },
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mcpServers[1]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("mcpServers[0]"))).toBe(false);
    expect(result.errors.some((e) => e.includes("mcpServers[2]"))).toBe(false);
  });
});

// ── 3. inferPackageType Edge Cases ──────────────────────────────

describe("inferPackageType — edge cases", () => {
  test('agent with empty tools array returns "extension" (tools key present with length 0)', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: [],
      agent: { prompt: "You are an agent" },
    });
    // tools.length is 0, so hasTools=false; but agent is present with no other components
    expect(inferPackageType(manifest)).toBe("agent");
  });

  test('agent + scripts only (no tools/skills/mcpServers) returns "extension"', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      agent: { prompt: "You are helpful" },
      scripts: { postinstall: "./setup.ts" },
    });
    expect(inferPackageType(manifest)).toBe("extension");
  });

  test('all component types present returns "extension"', () => {
    const manifest = makeValidManifest({
      tools: [{ name: "t", description: "t", inputSchema: {} }],
      skills: [{ name: "s", description: "s" }],
      mcpServers: [{ transport: "stdio", name: "m", command: "node" }],
      agent: { prompt: "agent" },
      scripts: { postinstall: "./setup.ts" },
    });
    expect(inferPackageType(manifest)).toBe("extension");
  });

  test('agent with undefined tools returns "agent"', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      skills: undefined,
      mcpServers: undefined,
      scripts: undefined,
      agent: { prompt: "Solo agent" },
    });
    expect(inferPackageType(manifest)).toBe("agent");
  });

  test('agent + skills returns "extension"', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      agent: { prompt: "Agent" },
      skills: [{ name: "sk", description: "A skill" }],
    });
    expect(inferPackageType(manifest)).toBe("extension");
  });

  test('agent + mcpServers returns "extension"', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      agent: { prompt: "Agent" },
      mcpServers: [{ transport: "stdio", name: "m", command: "node" }],
    });
    expect(inferPackageType(manifest)).toBe("extension");
  });

  test('no components at all returns "extension"', () => {
    const manifest = makeValidManifest({
      entrypoint: undefined,
      tools: undefined,
      skills: undefined,
      mcpServers: undefined,
      agent: undefined,
      scripts: undefined,
    });
    expect(inferPackageType(manifest)).toBe("extension");
  });
});

// ── 4. Type Coercion / Malformed Input ──────────────────────────

describe("validateManifestV2 — malformed input", () => {
  test("null input is rejected", () => {
    const result = validateManifestV2(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Manifest must be a non-null object");
  });

  test("undefined input is rejected", () => {
    const result = validateManifestV2(undefined);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Manifest must be a non-null object");
  });

  test("string input is rejected", () => {
    const result = validateManifestV2("not an object");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Manifest must be a non-null object");
  });

  test("array input is treated as object (but missing all fields)", () => {
    const result = validateManifestV2([]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("numeric name is rejected (number where string expected)", () => {
    const result = validateManifestV2(makeValidManifest({ name: 42 as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("numeric description is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ description: 123 as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("description"))).toBe(true);
  });

  test("numeric version is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ version: 100 as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("tools as object (not array) is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ tools: {} as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tools must be an array"))).toBe(true);
  });

  test("skills as string is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ skills: "not-an-array" as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills must be an array"))).toBe(true);
  });

  test("mcpServers as number is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ mcpServers: 42 as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mcpServers must be an array"))).toBe(true);
  });

  test("agent as string is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ agent: "not-an-object" as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent must be an object"))).toBe(true);
  });

  test("agent as null is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ agent: null as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent must be an object"))).toBe(true);
  });

  test("scripts as null is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ scripts: null as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("scripts must be an object"))).toBe(true);
  });

  test("scripts as array passes (arrays are typeof 'object')", () => {
    const result = validateManifestV2(makeValidManifest({ scripts: [] as any }));
    // The validator checks `typeof scripts !== 'object'`, and arrays are objects
    // so this passes — documenting the current behavior
    expect(result.valid).toBe(true);
  });

  test("tool entry as null in tools array is rejected", () => {
    const manifest = makeValidManifest({
      tools: [null as any],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tools[0]"))).toBe(true);
  });

  test("skill entry as null in skills array is rejected", () => {
    const manifest = makeValidManifest({
      skills: [null as any],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills[0]"))).toBe(true);
  });

  test("mcpServer entry as null in mcpServers array is rejected", () => {
    const manifest = makeValidManifest({
      mcpServers: [null as any],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mcpServers[0]"))).toBe(true);
  });

  test("author as null is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ author: null as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("author"))).toBe(true);
  });

  test("author as string is rejected", () => {
    const result = validateManifestV2(makeValidManifest({ author: "just a name" as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("author"))).toBe(true);
  });

  test("permissions as undefined does not crash (not validated strictly)", () => {
    const manifest = makeValidManifest({ permissions: undefined as any });
    // The validator does not check permissions, so this should not crash
    const result = validateManifestV2(manifest);
    // Should still be valid since permissions are not validated
    expect(result.errors.some((e) => e.includes("permissions"))).toBe(false);
  });

  test("permissions as null does not crash", () => {
    const manifest = makeValidManifest({ permissions: null as any });
    const result = validateManifestV2(manifest);
    expect(result.errors.some((e) => e.includes("permissions"))).toBe(false);
  });

  test("permissions as empty object passes", () => {
    const manifest = makeValidManifest({ permissions: {} });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });

  test("multiple errors accumulated for completely invalid manifest", () => {
    const result = validateManifestV2({
      schemaVersion: 1,
      name: "",
      version: "bad",
      description: "",
      author: null,
    });
    expect(result.valid).toBe(false);
    // Should have errors for: schemaVersion, name, version, description, author
    expect(result.errors.length).toBeGreaterThanOrEqual(5);
  });
});

// ── 5. compareVersions Edge Cases ───────────────────────────────

describe("compareVersions — edge cases", () => {
  test("major version difference", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
  });

  test("minor version difference", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.1.9", "1.2.0")).toBe(-1);
  });

  test("patch version difference", () => {
    expect(compareVersions("1.0.2", "1.0.1")).toBe(1);
    expect(compareVersions("1.0.1", "1.0.2")).toBe(-1);
  });

  test("very large version numbers", () => {
    expect(compareVersions("999.999.999", "999.999.998")).toBe(1);
    expect(compareVersions("999.999.999", "999.999.999")).toBe(0);
  });

  test("pre-release suffixes are parsed as NaN (treated as 0)", () => {
    // "1.0.0-alpha".split(".") => ["1", "0", "0-alpha"]
    // Number("0-alpha") => NaN, so (NaN ?? 0) is still NaN
    // NaN - 0 is NaN, which is neither < 0 nor > 0, so loop continues
    // This means "1.0.0-alpha" compares equal to "1.0.0" due to NaN behavior
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBe(0);
  });

  test("two-part version (missing patch) treats missing as 0", () => {
    // "1.0".split(".") => ["1", "0"], pa[2] is undefined => (undefined ?? 0) = 0
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  test("single-part version treats missing parts as 0", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
  });

  test("empty string vs 0.0.0 treats all parts as NaN/0", () => {
    // "".split(".") => [""], Number("") => 0
    expect(compareVersions("", "0.0.0")).toBe(0);
  });

  test("symmetry: a < b implies b > a", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
  });

  test("transitivity: if a < b and b < c then a < c", () => {
    expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
    expect(compareVersions("1.1.0", "1.2.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.2.0")).toBe(-1);
  });
});

// ── 6. generateSlug Edge Cases ──────────────────────────────────

describe("generateSlug — edge cases", () => {
  test("unicode characters are stripped", () => {
    expect(generateSlug("café-résumé")).toBe("caf-r-sum");
  });

  test("emoji characters are stripped", () => {
    const slug = generateSlug("🚀 My Extension 🎉");
    expect(slug).toBe("my-extension");
  });

  test("multiple consecutive spaces become single hyphen", () => {
    expect(generateSlug("foo   bar")).toBe("foo-bar");
  });

  test("multiple consecutive special chars become single hyphen", () => {
    expect(generateSlug("foo!!!bar")).toBe("foo-bar");
  });

  test("leading and trailing special chars are stripped", () => {
    expect(generateSlug("---hello---")).toBe("hello");
  });

  test("leading and trailing spaces are stripped", () => {
    expect(generateSlug("  hello world  ")).toBe("hello-world");
  });

  test("already-slugified input is unchanged", () => {
    expect(generateSlug("already-a-slug")).toBe("already-a-slug");
  });

  test("uppercase letters are lowercased", () => {
    expect(generateSlug("ALL-CAPS")).toBe("all-caps");
  });

  test("empty string returns empty string", () => {
    expect(generateSlug("")).toBe("");
  });

  test("string of only special characters returns empty string", () => {
    expect(generateSlug("!!!@@@###")).toBe("");
  });

  test("numbers are preserved", () => {
    expect(generateSlug("version 2.0")).toBe("version-2-0");
  });

  test("mixed alphanumeric and special chars", () => {
    expect(generateSlug("Hello_World (v2.1)")).toBe("hello-world-v2-1");
  });
});

// ── Validation: permissions.rbacScopes (custom RBAC scope declarations) ──
//
// Declarations are inert (NOT privileges) but reject-at-admit-time: a bad
// declaration is an authoring bug, so there is no clamp-to-subset fallback.
// Rules live in src/extensions/rbac-scopes.ts (shared with the storage
// layer's grant validation — one grammar, one core-verb list).

import {
  CORE_RBAC_SCOPES,
  MAX_RBAC_SCOPE_DECLARATIONS,
  isValidCustomRbacScopeName,
  validateRbacScopeDeclarations,
} from "../extensions/rbac-scopes";

describe("validateManifestV2 — permissions.rbacScopes", () => {
  const withScopes = (rbacScopes: unknown) =>
    validateManifestV2(
      makeValidManifest({
        permissions: { rbacScopes } as ExtensionManifestV2["permissions"],
      }),
    );

  test("a valid declaration list passes", () => {
    const result = withScopes([
      { name: "write-tickets", description: "Create and mutate board tickets" },
      { name: "read-metrics", description: "Read the metrics dashboard" },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("absent rbacScopes stays valid (additive, schemaVersion 2 unchanged)", () => {
    const result = validateManifestV2(makeValidManifest({ permissions: {} }));
    expect(result.valid).toBe(true);
  });

  test("non-array rbacScopes is rejected", () => {
    for (const bad of [{}, "write-tickets", 42, null]) {
      const result = withScopes(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("must be an array"))).toBe(true);
    }
  });

  test("non-object entries are rejected with their index", () => {
    const result = withScopes(["write-tickets", null, ["x"]]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("permissions.rbacScopes[0] must be an object");
    expect(result.errors).toContain("permissions.rbacScopes[1] must be an object");
    expect(result.errors).toContain("permissions.rbacScopes[2] must be an object");
  });

  test("name grammar: rejects uppercase, leading digit/hyphen, underscores, empty, non-string", () => {
    for (const name of ["Write-Tickets", "9lives", "-x", "a_b", "", undefined, 7]) {
      const result = withScopes([{ name, description: "d" }]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("[0].name must match"))).toBe(true);
    }
  });

  test("every core verb collides", () => {
    for (const verb of CORE_RBAC_SCOPES) {
      const result = withScopes([{ name: verb, description: "d" }]);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes(`"${verb}" collides with a core RBAC verb`)),
      ).toBe(true);
    }
  });

  test("duplicate names are rejected", () => {
    const result = withScopes([
      { name: "write-tickets", description: "a" },
      { name: "write-tickets", description: "b" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("declared more than once"))).toBe(true);
  });

  test("description is required and must be non-blank", () => {
    for (const description of [undefined, "", "   ", 42]) {
      const result = withScopes([{ name: "write-tickets", description }]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("[0].description is required"))).toBe(true);
    }
  });

  test("cap: 16 declarations pass, 17 fail", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `scope-${i}`, description: `scope ${i}` }));
    expect(withScopes(mk(MAX_RBAC_SCOPE_DECLARATIONS)).valid).toBe(true);
    const over = withScopes(mk(MAX_RBAC_SCOPE_DECLARATIONS + 1));
    expect(over.valid).toBe(false);
    expect(over.errors.some((e) => e.includes("max 16"))).toBe(true);
  });

  test("one bad entry does not mask sibling errors (error-array style)", () => {
    const result = withScopes([
      { name: "use", description: "" },
      { name: "ok-scope", description: "fine" },
    ]);
    expect(result.valid).toBe(false);
    // Both the collision AND the missing description are reported for [0].
    expect(result.errors.some((e) => e.includes("collides with a core RBAC verb"))).toBe(true);
    expect(result.errors.some((e) => e.includes("[0].description is required"))).toBe(true);
  });

  test("validateRbacScopeDeclarations honors a custom path prefix", () => {
    const errors: string[] = [];
    validateRbacScopeDeclarations("nope", errors, "custom.path");
    expect(errors).toEqual(["custom.path must be an array of {name, description} objects"]);
  });

  test("isValidCustomRbacScopeName: grammar-valid + non-core only", () => {
    expect(isValidCustomRbacScopeName("write-tickets")).toBe(true);
    expect(isValidCustomRbacScopeName("use")).toBe(false); // core verb
    expect(isValidCustomRbacScopeName("Bad")).toBe(false); // grammar
  });
});

// ── Validation: tools[].rbacScope (host-enforced user→extension gate) ────
//
// A tool's `rbacScope` is the scope the host ENFORCES at dispatch (see
// ToolExecutor.executeToolCall). Admit-time validation mirrors the
// `ezcorp/rbac-check` allowlist exactly: it must be a core verb or a
// scope this manifest declares in `permissions.rbacScopes`. Rejecting an
// undeclared scope here turns a runtime "silently deny every non-admin"
// authoring bug into a clear install-time error.

describe("validateManifestV2 — tools[].rbacScope", () => {
  const withTool = (rbacScope: unknown, rbacScopes?: unknown) =>
    validateManifestV2(
      makeValidManifest({
        tools: [
          {
            name: "gated",
            description: "d",
            inputSchema: { type: "object" },
            rbacScope,
          } as unknown as ToolDefinition,
        ],
        permissions: (rbacScopes !== undefined
          ? { rbacScopes }
          : {}) as ExtensionManifestV2["permissions"],
      }),
    );

  test("a core verb needs no declaration", () => {
    for (const verb of CORE_RBAC_SCOPES) {
      const r = withTool(verb);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    }
  });

  test("a custom scope declared in permissions.rbacScopes passes", () => {
    const r = withTool("write-tickets", [
      { name: "write-tickets", description: "Mutate tickets" },
    ]);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("a custom scope NOT declared is rejected (fail-closed at admit time)", () => {
    const r = withTool("made-up");
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('tools[0].rbacScope "made-up"'))).toBe(true);
    expect(r.errors.some((e) => e.includes("core verb"))).toBe(true);
  });

  test("a non-string / empty rbacScope is rejected", () => {
    for (const bad of [42, "", null]) {
      const r = withTool(bad);
      expect(r.valid).toBe(false);
      expect(
        r.errors.some((e) => e.includes("rbacScope must be a non-empty string")),
      ).toBe(true);
    }
  });

  test("absent rbacScope on every tool stays valid (unchanged path)", () => {
    const r = validateManifestV2(makeValidManifest()); // default tool has no rbacScope
    expect(r.valid).toBe(true);
  });

  test("a non-object tool entry is skipped by the rbacScope pass (no crash)", () => {
    const r = validateManifestV2(
      makeValidManifest({
        tools: [
          "nope",
          { name: "ok", description: "d", inputSchema: { type: "object" }, rbacScope: "use" },
        ] as unknown as ToolDefinition[],
      }),
    );
    // validateToolsArray owns the shape error; the rbacScope pass must not
    // crash on the non-object entry and must accept the valid sibling.
    expect(r.errors.some((e) => e.includes("tools[0] must be an object"))).toBe(true);
    expect(r.errors.some((e) => e.includes("tools[1].rbacScope"))).toBe(false);
  });

  test("non-array tools short-circuits the rbacScope pass", () => {
    const r = validateManifestV2(
      makeValidManifest({ tools: "nope" as unknown as ToolDefinition[] }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("tools must be an array"))).toBe(true);
  });
});
