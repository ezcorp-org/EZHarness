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

  test("issue #205 — a URL typed into `command` loses its query values too", () => {
    // `command` is free text an admin types, and the http/sse branch would
    // never have written a query string into the row. Both branches now agree,
    // through the SAME classifier the persistence layer uses.
    const urlCommand = {
      transport: "stdio",
      name: "n",
      command: `https://runner.example/exec?api_key=${SECRET}`,
    } as McpServerDefinition;
    const facts = describeMcpServerForAudit(urlCommand);
    expect(facts.target).toBe("https://runner.example/exec?api_key=");
    expect(JSON.stringify(facts)).not.toContain(SECRET);
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
  test("the URL is reduced to its ORIGIN, dropping path, query and fragment", () => {
    const http = {
      transport: "http",
      name: "remote",
      url: `https://mcp.example.com/v1/rpc?api_key=${SECRET}#frag`,
      headers: { Authorization: `Bearer ${SECRET}`, "X-Trace": "1" },
    } as McpServerDefinition;

    const facts = describeMcpServerForAudit(http, TOOLS);
    expect(facts.transport).toBe("http");
    expect(facts.target).toBe("https://mcp.example.com");
    expect(facts.pathDepth).toBe(2);
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
      target: "https://mcp.example.com",
      pathDepth: 1,
      authKeys: [],
      toolCount: 0,
      toolNames: [],
    });
  });

  test("F7: a credential embedded in the PATH never reaches the audit row", () => {
    // The Slack/Zapier webhook shape. `redactForAudit` cannot save us here —
    // its pattern set anchors on `key=`-style assignments and an opaque path
    // segment has nothing to match — so this projection is the only net.
    const PATH_TOKEN = "QQQQopaqueTOKEN99";
    const hook = {
      transport: "http",
      name: "hooks",
      url: `https://hooks.example.com/services/T0001/B0002/${PATH_TOKEN}`,
    } as McpServerDefinition;

    const facts = describeMcpServerForAudit(hook, TOOLS);
    expect(facts.target).toBe("https://hooks.example.com");
    // Shape is kept; bytes are not.
    expect(facts.pathDepth).toBe(4);
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain(PATH_TOKEN);
    expect(serialized).not.toContain("T0001");
    expect(serialized).not.toContain("services");
  });

  test("two endpoints on one host stay distinguishable by pathDepth", () => {
    // What the dropped path cost us, and the floor under it: an operator can
    // still see that a connection was re-pointed at a different endpoint.
    const shallow = describeMcpServerForAudit(
      { transport: "http", name: "a", url: "https://mcp.example.com/rpc" } as McpServerDefinition,
    );
    const deep = describeMcpServerForAudit(
      { transport: "http", name: "a", url: "https://mcp.example.com/v2/team/rpc" } as McpServerDefinition,
    );
    expect(shallow.target).toBe(deep.target);
    expect(shallow.pathDepth).not.toBe(deep.pathDepth);
  });

  test("an unparseable URL is replaced, never echoed", () => {
    // The raw string is withheld precisely because a URL that will not parse
    // is the case most likely to be a malformed credential blob.
    const broken = { transport: "http", name: "b", url: `not a url ${SECRET}` } as McpServerDefinition;
    const facts = describeMcpServerForAudit(broken);
    expect(facts.target).toBe("<unparseable-url>");
    expect(facts.pathDepth).toBe(0);
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
