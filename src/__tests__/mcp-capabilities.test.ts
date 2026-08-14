import { test, expect, describe } from "bun:test";

import {
  mcpInstallGrant,
  mcpManifestPermissions,
  mcpNetworkHosts,
  normalizeMcpManifest,
  withMcpToolCapabilities,
} from "../extensions/mcp-capabilities";
import { capabilityDeclarationToSet } from "../extensions/capability-types";
import type {
  ExtensionManifestV2,
  McpServerDefinition,
  ToolDefinition,
} from "../extensions/types";

/**
 * Unit coverage for the MCP capability derivation (B5).
 *
 * The behavior under test is the fix for an INERT PDP: before this module,
 * `installMcpExtension` wrote `permissions: {}` and capability-less tools, so
 * `capabilityDeclarationToSet(tool.capabilities, …)` produced `[]` for every
 * MCP tool and `engine.authorize(ctx, [])` allowed unconditionally. Each case
 * below asserts on the CAP SET the PDP would actually compare, not just on
 * the intermediate shape.
 */

function stdio(over: Partial<{ command: string; args: string[] }> = {}): McpServerDefinition {
  return {
    transport: "stdio",
    name: "srv",
    command: over.command ?? "npx",
    ...(over.args !== undefined ? { args: over.args } : {}),
  };
}

function remote(url: string, transport: "http" | "sse" = "http"): McpServerDefinition {
  return { transport, name: "srv", url };
}

function mcpManifest(
  server: McpServerDefinition,
  over: Partial<ExtensionManifestV2> = {},
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "srv",
    version: "0.0.0",
    description: "",
    author: { name: "local" },
    kind: "mcp",
    mcpServers: [server],
    tools: [{ name: "probe", description: "p", inputSchema: { type: "object" } }],
    permissions: {},
    ...over,
  } as ExtensionManifestV2;
}

describe("mcpNetworkHosts", () => {
  test("remote http transport declares the target url host", () => {
    expect(mcpNetworkHosts(remote("https://mcp.example.com/mcp"))).toEqual([
      "mcp.example.com",
    ]);
  });

  test("remote sse transport declares the target url host", () => {
    expect(mcpNetworkHosts(remote("https://sse.example.com/stream", "sse"))).toEqual([
      "sse.example.com",
    ]);
  });

  test("host is lowercased so it matches the proxy's normalizeHostname value", () => {
    expect(mcpNetworkHosts(remote("https://MCP.Example.COM/mcp"))).toEqual([
      "mcp.example.com",
    ]);
  });

  test("IPv6 literals lose their URL brackets, matching the proxy's cap value", () => {
    expect(mcpNetworkHosts(remote("http://[::1]:3000/mcp"))).toEqual(["::1"]);
  });

  test("an unparseable remote url derives nothing (fail closed, never a guess)", () => {
    expect(mcpNetworkHosts(remote("https://:::/not-a-url"))).toEqual([]);
  });

  test("a url with no host derives nothing", () => {
    expect(mcpNetworkHosts(remote("file:///srv/mcp"))).toEqual([]);
  });

  test("stdio derives every url its command line names", () => {
    expect(
      mcpNetworkHosts(
        stdio({ args: ["-y", "mcp-remote", "https://mcp.notion.com/mcp", "--verbose"] }),
      ),
    ).toEqual(["mcp.notion.com"]);
  });

  test("stdio scans the command token too, not just args", () => {
    expect(mcpNetworkHosts(stdio({ command: "https://cmd.example.com/bin" }))).toEqual([
      "cmd.example.com",
    ]);
  });

  test("stdio dedupes a host repeated across tokens, preserving order", () => {
    expect(
      mcpNetworkHosts(
        stdio({
          args: ["https://b.example.com/x", "https://a.example.com/y", "https://b.example.com/z"],
        }),
      ),
    ).toEqual(["b.example.com", "a.example.com"]);
  });

  test("stdio derives a flag-attached url too (--endpoint=https://…)", () => {
    expect(
      mcpNetworkHosts(stdio({ args: ["--endpoint=https://flag.example.com/mcp"] })),
    ).toEqual(["flag.example.com"]);
  });

  test("a flag whose value only LOOKS like a scheme derives nothing", () => {
    // `://` with no RFC-3986 scheme in front of it is not a URL.
    expect(mcpNetworkHosts(stdio({ args: ["--path=://nope"] }))).toEqual([]);
  });

  test("stdio with no url in its command line is DENY-BY-DEFAULT (empty)", () => {
    expect(mcpNetworkHosts(stdio({ args: ["-y", "@modelcontextprotocol/server-github"] }))).toEqual(
      [],
    );
  });

  test("stdio with no args at all derives nothing", () => {
    expect(mcpNetworkHosts(stdio())).toEqual([]);
  });

  test("a non-string arg is ignored rather than throwing", () => {
    const server = stdio({ args: ["ok"] });
    // A hand-edited row can carry anything in jsonb; the derivation must not
    // throw inside the install path on a malformed element.
    (server as { args: unknown[] }).args = [42, null, "https://ok.example.com/x"];
    expect(mcpNetworkHosts(server)).toEqual(["ok.example.com"]);
  });
});

describe("mcpManifestPermissions", () => {
  test("always declares the network key so the clamp has a ceiling to admit against", () => {
    // `clampExtensionPermissions` gates on `if (submitted.network &&
    // manifest.network)` — an ABSENT key silently drops every submitted host,
    // which is exactly why the network grant was ungrantable for MCP rows.
    expect(mcpManifestPermissions(stdio())).toEqual({ network: [] });
  });

  test("declares the remote host as the ceiling", () => {
    expect(mcpManifestPermissions(remote("https://mcp.example.com/mcp"))).toEqual({
      network: ["mcp.example.com"],
    });
  });
});

describe("mcpInstallGrant", () => {
  test("grants the derived hosts and stamps grantedAt", () => {
    const grant = mcpInstallGrant(remote("https://mcp.example.com/mcp"), 1_700_000_000_000);
    expect(grant).toEqual({
      network: ["mcp.example.com"],
      grantedAt: { network: 1_700_000_000_000 },
    });
  });

  test("grants NOTHING when the definition names no host", () => {
    expect(mcpInstallGrant(stdio(), 1_700_000_000_000)).toEqual({ grantedAt: {} });
  });

  test("defaults the stamp to now when the caller omits it", () => {
    const before = Date.now();
    const grant = mcpInstallGrant(remote("https://mcp.example.com/mcp"));
    // Not a wall-clock budget: only that the default argument was taken and
    // produced a plausible epoch stamp.
    expect(grant.grantedAt.network).toBeGreaterThanOrEqual(before);
  });
});

describe("withMcpToolCapabilities", () => {
  test("stamps the declared hosts onto every tool, producing a real needed set", () => {
    const tools: ToolDefinition[] = [
      { name: "a", description: "a", inputSchema: { type: "object" } },
      { name: "b", description: "b", inputSchema: { type: "object" } },
    ];
    const out = withMcpToolCapabilities(tools, { network: ["mcp.example.com"] });
    expect(out.map((t) => t.capabilities)).toEqual([
      { network: { hosts: ["mcp.example.com"] } },
      { network: { hosts: ["mcp.example.com"] } },
    ]);
    // The PDP comparison surface, not just the shape.
    expect(capabilityDeclarationToSet(out[0]!.capabilities, {})).toEqual([
      { kind: "network", value: "mcp.example.com" },
    ]);
  });

  test("an empty ceiling yields an empty needed set (documented deny-by-default)", () => {
    const out = withMcpToolCapabilities(
      [{ name: "a", description: "a", inputSchema: { type: "object" } }],
      { network: [] },
    );
    expect(capabilityDeclarationToSet(out[0]!.capabilities, {})).toEqual([]);
  });

  test("never widens an authored declaration", () => {
    const out = withMcpToolCapabilities(
      [
        {
          name: "a",
          description: "a",
          inputSchema: { type: "object" },
          capabilities: { network: { hosts: ["narrow.example.com"] } },
        },
      ],
      { network: ["wide.example.com"] },
    );
    expect(out[0]!.capabilities).toEqual({ network: { hosts: ["narrow.example.com"] } });
  });
});

describe("normalizeMcpManifest", () => {
  test("derives the ceiling AND the per-tool declaration for a legacy row", () => {
    // The exact shape `installMcpExtension` wrote before this fix.
    const legacy = mcpManifest(remote("https://legacy.example.com/mcp"));
    const out = normalizeMcpManifest(legacy);
    expect(out.permissions.network).toEqual(["legacy.example.com"]);
    expect(capabilityDeclarationToSet(out.tools![0]!.capabilities, {})).toEqual([
      { kind: "network", value: "legacy.example.com" },
    ]);
  });

  test("a stored declaration is authoritative — normalization never re-derives it", () => {
    const narrowed = mcpManifest(remote("https://wide.example.com/mcp"), {
      permissions: { network: ["kept.example.com"] },
    });
    const out = normalizeMcpManifest(narrowed);
    expect(out.permissions.network).toEqual(["kept.example.com"]);
  });

  test("an explicitly EMPTY declaration is honored, not re-derived", () => {
    const revoked = mcpManifest(remote("https://wide.example.com/mcp"), {
      permissions: { network: [] },
    });
    expect(normalizeMcpManifest(revoked).permissions.network).toEqual([]);
  });

  test("is idempotent — a second pass changes nothing", () => {
    const once = normalizeMcpManifest(mcpManifest(remote("https://x.example.com/mcp")));
    expect(normalizeMcpManifest(once)).toEqual(once);
  });

  test("preserves the other permission keys it did not derive", () => {
    const legacy = mcpManifest(stdio(), { permissions: { storage: true } });
    expect(normalizeMcpManifest(legacy).permissions).toEqual({
      storage: true,
      network: [],
    });
  });

  test("tolerates a manifest with no tools array", () => {
    const out = normalizeMcpManifest(
      mcpManifest(remote("https://x.example.com/mcp"), { tools: undefined }),
    );
    expect(out.tools).toEqual([]);
  });

  test("a non-MCP manifest is returned untouched, by reference", () => {
    const plain = mcpManifest(stdio(), { kind: "local" } as Partial<ExtensionManifestV2>);
    expect(normalizeMcpManifest(plain)).toBe(plain);
  });

  test("an MCP manifest with no server entry is returned untouched, by reference", () => {
    const headless = mcpManifest(stdio(), { mcpServers: [] });
    expect(normalizeMcpManifest(headless)).toBe(headless);
  });
});
