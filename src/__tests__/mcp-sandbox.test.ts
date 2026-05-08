/**
 * Unit tests for `buildSandboxedMcpSpec` — audit finding #1 + Phase 7
 * MCP isolation.
 *
 * Pure-function scope: we don't spawn anything. We just assert that the
 * spec returned by the wrapper has the shape the StdioClientTransport
 * will hand to child_process.spawn — prlimit prefix, bounded env, no
 * process.env leak.
 *
 * The AF-1 regression test in `audit-regressions.test.ts` covers the
 * end-to-end spawn; this file is the cheap unit-level safety net.
 *
 * Phase 7: `buildSandboxedMcpSpec` is now async and returns
 * `{ spec, proxyHandle }`. When called WITHOUT a `ctx` (this test
 * file's contract) the function falls back to the pre-Phase-7 prlimit-
 * only spec — proxyHandle is null and no listener is started. The
 * Phase-7 test coverage (proxy unit + netns integration + fallback)
 * lives in dedicated files (`mcp-proxy.test.ts`, etc.).
 */

import { test, expect, describe } from "bun:test";
import { buildSandboxedMcpSpec } from "../extensions/mcp-sandbox";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  McpServerDefinition,
  McpServerStdio,
} from "../extensions/types";

function mcpManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "probe",
    version: "1.0.0",
    description: "",
    author: { name: "t" },
    kind: "mcp",
    mcpServers: [],
    permissions: {},
    ...overrides,
  };
}

const SAVED_ENV_KEYS = ["EZCORP_PERMITTED_HOSTS", "EZCORP_SHELL_ALLOWED", "AF1_SECRET"] as const;
function stashEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV_KEYS) out[k] = process.env[k];
  return out;
}
function restoreEnv(stash: Record<string, string | undefined>) {
  for (const k of SAVED_ENV_KEYS) {
    if (stash[k] === undefined) delete process.env[k];
    else process.env[k] = stash[k]!;
  }
}

describe("buildSandboxedMcpSpec — stdio wrap", () => {
  test("prepends prlimit with memory bounds before the original command", async () => {
    const spec: McpServerDefinition = {
      transport: "stdio",
      name: "x",
      command: "/usr/bin/python3",
      args: ["-m", "my_mcp_server"],
    };
    const manifest = mcpManifest();
    const granted: ExtensionPermissions = { grantedAt: {} };

    const { spec: rawWrapped, proxyHandle } = await buildSandboxedMcpSpec(
      spec, manifest, granted, "ext-1",
    );
    const wrapped = rawWrapped as McpServerStdio;

    // Phase 7: omitting `ctx` skips proxy startup — no handle returned.
    expect(proxyHandle).toBeNull();

    expect(wrapped.transport).toBe("stdio");
    expect(wrapped.command).toBe("prlimit");
    expect(wrapped.args?.[0]).toMatch(/^--rss=\d+$/);
    expect(wrapped.args?.[1]).toMatch(/^--as=\d+$/);
    // Original command + args preserved after prlimit flags
    const originalIdx = wrapped.args?.indexOf("/usr/bin/python3") ?? -1;
    expect(originalIdx).toBeGreaterThanOrEqual(0);
    expect(wrapped.args?.slice(originalIdx)).toEqual(["/usr/bin/python3", "-m", "my_mcp_server"]);
  });

  test("uses manifest.resources.memory to set prlimit bytes", async () => {
    const spec: McpServerDefinition = {
      transport: "stdio", name: "x", command: "/bin/true",
    };
    const manifest = mcpManifest({ resources: { memory: "1GB" } });
    const { spec: rawWrapped } = await buildSandboxedMcpSpec(
      spec, manifest, { grantedAt: {} }, "ext-mem",
    );
    const wrapped = rawWrapped as McpServerStdio;

    const expectedBytes = 1024 * 1024 * 1024;
    expect(wrapped.args?.[0]).toBe(`--rss=${expectedBytes}`);
    expect(wrapped.args?.[1]).toBe(`--as=${expectedBytes}`);
  });

  test("child env does NOT inherit EZCORP_PERMITTED_HOSTS from parent when network not granted", async () => {
    const stash = stashEnv();
    process.env.EZCORP_PERMITTED_HOSTS = "evil.example.com";
    try {
      const spec: McpServerDefinition = {
        transport: "stdio", name: "x", command: "/bin/true",
      };
      const { spec: rawWrapped } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-no-net",
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.EZCORP_PERMITTED_HOSTS).toBeUndefined();
    } finally {
      restoreEnv(stash);
    }
  });

  test("child env does NOT inherit EZCORP_SHELL_ALLOWED from parent", async () => {
    const stash = stashEnv();
    process.env.EZCORP_SHELL_ALLOWED = "1";
    try {
      const spec: McpServerDefinition = {
        transport: "stdio", name: "x", command: "/bin/true",
      };
      const { spec: rawWrapped } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-no-shell",
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.EZCORP_SHELL_ALLOWED).toBeUndefined();
    } finally {
      restoreEnv(stash);
    }
  });

  test("child env does NOT inherit arbitrary parent secrets", async () => {
    const stash = stashEnv();
    process.env.AF1_SECRET = "shh";
    try {
      const spec: McpServerDefinition = {
        transport: "stdio", name: "x", command: "/bin/true",
      };
      const { spec: rawWrapped } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-no-secret",
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.AF1_SECRET).toBeUndefined();
      // Subprocess survival: PATH is in the allowlist so binaries resolve.
      expect(wrapped.env?.PATH).toBeDefined();
    } finally {
      restoreEnv(stash);
    }
  });

  test("manifest-declared + granted env keys are forwarded (dual-gate)", async () => {
    const stash = stashEnv();
    process.env.AF1_SECRET = "from-host";
    try {
      const spec: McpServerDefinition = {
        transport: "stdio", name: "x", command: "/bin/true",
      };
      const manifest = mcpManifest({
        permissions: { env: ["AF1_SECRET"] },
      });
      const granted: ExtensionPermissions = {
        grantedAt: {},
        env: ["AF1_SECRET"],
      };
      const { spec: rawWrapped } = await buildSandboxedMcpSpec(
        spec, manifest, granted, "ext-granted-env",
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.AF1_SECRET).toBe("from-host");
    } finally {
      restoreEnv(stash);
    }
  });

  test("granted network hosts become EZCORP_PERMITTED_HOSTS", async () => {
    const spec: McpServerDefinition = {
      transport: "stdio", name: "x", command: "/bin/true",
    };
    const granted: ExtensionPermissions = {
      grantedAt: {},
      network: ["api.example.com", "cdn.example.com"],
    };
    const { spec: rawWrapped } = await buildSandboxedMcpSpec(
      spec, mcpManifest(), granted, "ext-net",
    );
    const wrapped = rawWrapped as McpServerStdio;
    expect(wrapped.env?.EZCORP_PERMITTED_HOSTS).toBe("api.example.com,cdn.example.com");
  });

  test("spec.env literal values (admin-approved in manifest) pass through", async () => {
    const spec: McpServerDefinition = {
      transport: "stdio",
      name: "x",
      command: "/bin/true",
      env: { MCP_MODE: "strict", MCP_LOG_LEVEL: "info" },
    };
    const { spec: rawWrapped } = await buildSandboxedMcpSpec(
      spec, mcpManifest(), { grantedAt: {} }, "ext-spec-env",
    );
    const wrapped = rawWrapped as McpServerStdio;
    expect(wrapped.env?.MCP_MODE).toBe("strict");
    expect(wrapped.env?.MCP_LOG_LEVEL).toBe("info");
  });
});

describe("buildSandboxedMcpSpec — non-stdio pass-through", () => {
  test("http spec is returned unchanged", async () => {
    const spec: McpServerDefinition = {
      transport: "http", name: "x", url: "https://example.com/mcp",
    };
    const { spec: wrapped, proxyHandle } = await buildSandboxedMcpSpec(
      spec, mcpManifest(), { grantedAt: {} }, "ext-http",
    );
    expect(wrapped).toBe(spec);
    expect(proxyHandle).toBeNull();
  });

  test("sse spec is returned unchanged", async () => {
    const spec: McpServerDefinition = {
      transport: "sse", name: "x", url: "https://example.com/sse",
    };
    const { spec: wrapped, proxyHandle } = await buildSandboxedMcpSpec(
      spec, mcpManifest(), { grantedAt: {} }, "ext-sse",
    );
    expect(wrapped).toBe(spec);
    expect(proxyHandle).toBeNull();
  });
});
