/**
 * Unit tests for `src/extensions/mcp-audit.ts` — the credential-free
 * projection from an MCP server definition to `audit_log.metadata`.
 *
 * The assertions are deliberately two-sided. Checking that the useful fields
 * are PRESENT is the easy half; the half that matters is checking that the
 * secret-bearing ones are ABSENT from the serialized payload, because a leak
 * here writes a live credential into a table the audit UI renders and an
 * operator exports.
 */
import { test, expect, describe } from "bun:test";
import { buildMcpAuditMetadata, describeMcpServerForAudit } from "../extensions/mcp-audit";
import type { McpServerDefinition, ToolDefinition } from "../extensions/types";

const TOOLS = [
  { name: "forecast", description: "Get forecast", inputSchema: {} },
  { name: "alerts", description: "Severe alerts", inputSchema: {} },
] as unknown as ToolDefinition[];

const SECRET = "sk-live-do-not-log-me";

describe("describeMcpServerForAudit — stdio", () => {
  const stdio = {
    transport: "stdio",
    name: "weather",
    command: "npx",
    args: ["weather-mcp", "--token", SECRET],
    env: { WEATHER_API_KEY: SECRET, OTHER: "x" },
  } as McpServerDefinition;

  test("records the executable, the argv COUNT, and the env KEY names only", () => {
    expect(describeMcpServerForAudit(stdio, TOOLS)).toEqual({
      transport: "stdio",
      target: "npx",
      argCount: 3,
      // Sorted so a header/env reorder is not a spurious diff.
      authKeys: ["OTHER", "WEATHER_API_KEY"],
      toolCount: 2,
      toolNames: ["forecast", "alerts"],
    });
  });

  test("no argv VALUE and no env VALUE reaches the payload", () => {
    // argv is where `--token <secret>` lives, and env is where an API key
    // lives. Serializing and searching is the assertion that actually
    // catches a future field being added back by hand.
    const serialized = JSON.stringify(describeMcpServerForAudit(stdio, TOOLS));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("weather-mcp"); // an argv value
  });

  test("absent args / env read as zero and empty, not as a throw", () => {
    const bare = { transport: "stdio", name: "n", command: "run" } as McpServerDefinition;
    expect(describeMcpServerForAudit(bare)).toEqual({
      transport: "stdio",
      target: "run",
      argCount: 0,
      authKeys: [],
      toolCount: 0,
      toolNames: [],
    });
  });
});

describe("describeMcpServerForAudit — http / sse", () => {
  test("the URL is reduced to origin + path, dropping query and fragment", () => {
    const http = {
      transport: "http",
      name: "remote",
      url: `https://mcp.example.com/v1/rpc?api_key=${SECRET}#frag`,
      headers: { Authorization: `Bearer ${SECRET}`, "X-Trace": "1" },
    } as McpServerDefinition;

    const facts = describeMcpServerForAudit(http, TOOLS);
    expect(facts.transport).toBe("http");
    expect(facts.target).toBe("https://mcp.example.com/v1/rpc");
    expect(facts.authKeys).toEqual(["Authorization", "X-Trace"]);
    expect(facts.argCount).toBeUndefined();
    expect(JSON.stringify(facts)).not.toContain(SECRET);
  });

  test("sse is handled on the same arm", () => {
    const sse = {
      transport: "sse",
      name: "stream",
      url: "https://mcp.example.com/events",
    } as McpServerDefinition;
    expect(describeMcpServerForAudit(sse)).toEqual({
      transport: "sse",
      target: "https://mcp.example.com/events",
      authKeys: [],
      toolCount: 0,
      toolNames: [],
    });
  });

  test("an unparseable URL is replaced, never echoed", () => {
    // The raw string is withheld precisely because a URL that will not parse
    // is the case most likely to be a malformed credential blob.
    const broken = { transport: "http", name: "b", url: `not a url ${SECRET}` } as McpServerDefinition;
    const facts = describeMcpServerForAudit(broken);
    expect(facts.target).toBe("<unparseable-url>");
    expect(JSON.stringify(facts)).not.toContain(SECRET);
  });
});

describe("buildMcpAuditMetadata", () => {
  const after = describeMcpServerForAudit(
    { transport: "stdio", name: "w", command: "npx", args: [] } as McpServerDefinition,
    TOOLS,
  );

  test("an install has no before side", () => {
    const meta = buildMcpAuditMetadata({
      extensionName: "weather-mcp",
      actorUserId: "admin-1",
      reason: "mcp-install",
      before: null,
      after,
    });
    expect(meta).toEqual({
      permission: "network",
      oldValue: null,
      newValue: after,
      actor: "admin-1",
      reason: "mcp-install",
      extensionName: "weather-mcp",
    });
  });

  test("an update carries both sides so a re-pointed connection is diffable", () => {
    const before = describeMcpServerForAudit(
      { transport: "http", name: "w", url: "https://old.example.com/rpc" } as McpServerDefinition,
      [],
    );
    const meta = buildMcpAuditMetadata({
      extensionName: "weather-mcp",
      actorUserId: "admin-1",
      reason: "mcp-update",
      before,
      after,
    });
    expect(meta.oldValue).toEqual(before);
    expect(meta.newValue).toEqual(after);
    expect(meta.reason).toBe("mcp-update");
  });

  test("the payload satisfies the ExtensionAuditMetadata contract the audit UI reads", () => {
    const meta = buildMcpAuditMetadata({
      extensionName: "weather-mcp",
      actorUserId: "admin-1",
      reason: "mcp-refresh",
      before: after,
      after,
    });
    // `actor` and the oldValue/newValue pair are the required fields every
    // `ext:*` consumer switches on.
    expect(meta.actor).toBe("admin-1");
    expect("oldValue" in meta).toBe(true);
    expect("newValue" in meta).toBe(true);
    // `permission: "network"` matches the sibling ext:mcp:* runtime rows, so
    // MCP dashboards need no special case for the lifecycle actions.
    expect(meta.permission).toBe("network");
  });
});
