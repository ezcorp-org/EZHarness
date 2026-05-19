// Real-subprocess regression test for AF-1 — MCP stdio spawns must run
// under the extension sandbox envelope (prlimit + bounded env).
//
// Source of truth:
//   - tasks/ext-audit-fixes/requirements.md §AF-1
//   - src/extensions/mcp-sandbox.ts          — pure-function envelope
//   - src/extensions/registry.ts:getMcpClient — wiring point (commit e015ed7)
//
// Why this file is separate from audit-regressions.test.ts:
//   That file globally mocks `../extensions/registry` (stub needed for the
//   AF-2 installFromLocal test). AF-1 needs the REAL ExtensionRegistry so
//   the `buildSandboxedMcpSpec` wrapping actually runs. Scoping the test
//   to its own file keeps the mocks non-overlapping and mirrors the
//   permission-enforcement.test.ts pattern (real subprocess, real /proc).
//
// What this locks:
//   1. Child env does NOT inherit EZCORP_PERMITTED_HOSTS from parent
//      when `permissions.network` is not granted.
//   2. Child env does NOT inherit EZCORP_SHELL_ALLOWED from parent.
//   3. Child env does NOT inherit arbitrary host secrets (AF1_SECRET_LEAK).
//   4. Child PATH IS still present (subprocess survival — NR-1).
//   5. `/proc/self/limits` shows a bounded `Max address space` — proof
//      the prlimit wrapper actually engaged.
//   6. The MCP protocol round-trip (initialize → tools/list → tools/call)
//      still completes through the envelope (NR-1).
//
// This test MUST fail on HEAD pre-9ecd1a4 (direct StdioClientTransport
// spawn leaks process.env + lacks prlimit) and pass after.

import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import type { ExtensionManifestV2 } from "../extensions/types";

// Minimal DB mock so registry.ts loads without a live Postgres. `getMcpClient`
// never calls listExtensions — it reads in-memory maps seeded below via the
// `setManifestForTest` / `setGrantedPermsForTest` helpers.
mock.module("../db/queries/extensions", () => ({
  listExtensions: async () => [],
  updateExtension: async () => null,
}));
mock.module("../db/connection", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: async () => [] }) }),
  }),
}));

afterAll(() => restoreModuleMocks());

// Imports AFTER mocks are registered:
import { ExtensionRegistry } from "../extensions/registry";

// ── probe server ─────────────────────────────────────────────────────
//
// A minimal MCP stdio server that dumps its own `process.env` and the
// contents of `/proc/self/limits` via the `who_am_i` tool. The harness
// then inspects the payload for the invariants listed at top-of-file.
function makeProbeServer(): { command: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "af1-probe-"));
  const scriptPath = join(dir, "server.ts");
  writeFileSync(
    scriptPath,
    `
    const fs = require("node:fs");
    const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          send({ jsonrpc: "2.0", id: req.id, result: {
            protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "af1-probe", version: "0.0.1" },
          }});
        } else if (req.method === "notifications/initialized") {
          // no-op
        } else if (req.method === "tools/list") {
          send({ jsonrpc: "2.0", id: req.id, result: { tools: [
            { name: "who_am_i", description: "probe",
              inputSchema: { type: "object", properties: {} } },
          ]}});
        } else if (req.method === "tools/call") {
          let limits = "";
          try { limits = fs.readFileSync("/proc/self/limits", "utf8"); }
          catch (e) { limits = "ERR:" + (e && e.message || String(e)); }
          send({ jsonrpc: "2.0", id: req.id, result: {
            content: [{ type: "text", text: JSON.stringify({
              env: { ...process.env },
              limits,
              pid: process.pid,
            }) }],
            isError: false,
          }});
        } else {
          send({ jsonrpc: "2.0", id: req.id, error: {
            code: -32601, message: "Method not found",
          }});
        }
      }
    });
    `,
  );
  return { command: "bun", args: ["run", scriptPath] };
}

function mcpManifest(server: {
  command: string;
  args: string[];
}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "af1-probe",
    version: "1.0.0",
    description: "AF-1 probe",
    author: { name: "sdet" },
    kind: "mcp",
    mcpServers: [
      { transport: "stdio", name: "probe", command: server.command, args: server.args },
    ],
    permissions: {},
  };
}

async function probe(extId: string): Promise<{
  env: Record<string, string>;
  limits: string;
  pid: number;
}> {
  const registry = ExtensionRegistry.getInstance();
  const client = await registry.getMcpClient(extId);
  try {
    const res = await client.callTool("who_am_i", {});
    expect(res.isError).toBe(false);
    const text = res.content[0]?.text;
    expect(typeof text).toBe("string");
    return JSON.parse(text as string);
  } finally {
    await client.close().catch(() => {});
  }
}

// Each test stashes + restores parent-env keys it dirties so a failing
// assertion can't leak state into a neighbour test.
const STASH_KEYS = ["EZCORP_PERMITTED_HOSTS", "EZCORP_SHELL_ALLOWED", "AF1_SECRET_LEAK"] as const;
function stash() {
  const out: Record<string, string | undefined> = {};
  for (const k of STASH_KEYS) out[k] = process.env[k];
  return out;
}
function unstash(saved: Record<string, string | undefined>) {
  for (const k of STASH_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
}

describe("AF-1: MCP stdio spawn inherits sandbox envelope", () => {
  test("child env does NOT leak EZCORP_PERMITTED_HOSTS / EZCORP_SHELL_ALLOWED / host secrets", async () => {
    const saved = stash();
    process.env.EZCORP_PERMITTED_HOSTS = "evil.example.com";
    process.env.EZCORP_SHELL_ALLOWED = "1";
    process.env.AF1_SECRET_LEAK = "nope";
    try {
      const server = makeProbeServer();
      const registry = ExtensionRegistry.getInstance();
      const extId = "af1-env-isolation";
      registry.setManifestForTest(extId, mcpManifest(server));
      registry.setGrantedPermsForTest(extId, { grantedAt: {} });

      const payload = await probe(extId);

      // Bounded env: nothing the parent set survives into the child.
      expect(payload.env.EZCORP_PERMITTED_HOSTS).toBeUndefined();
      expect(payload.env.EZCORP_SHELL_ALLOWED).toBeUndefined();
      expect(payload.env.AF1_SECRET_LEAK).toBeUndefined();

      // Subprocess survival: PATH is in buildAllowedEnv's allowlist so
      // the `bun` binary resolves inside the child.
      expect(payload.env.PATH).toBeDefined();
    } finally {
      unstash(saved);
      ExtensionRegistry.resetInstance();
    }
  }, 20_000);

  test("granted network hosts ARE forwarded as EZCORP_PERMITTED_HOSTS", async () => {
    // Positive-control: the envelope does not block granted perms. Without
    // this the first test would be ambiguous — "env is empty" could mean
    // either correctly bounded or plain-broken.
    const saved = stash();
    try {
      const server = makeProbeServer();
      const registry = ExtensionRegistry.getInstance();
      const extId = "af1-net-granted";
      registry.setManifestForTest(extId, mcpManifest(server));
      registry.setGrantedPermsForTest(extId, {
        grantedAt: {},
        network: ["api.example.com", "cdn.example.com"],
      });

      const payload = await probe(extId);
      expect(payload.env.EZCORP_PERMITTED_HOSTS).toBe("api.example.com,cdn.example.com");
    } finally {
      unstash(saved);
      ExtensionRegistry.resetInstance();
    }
  }, 20_000);

  test("spawned child runs under prlimit — Max address space is bounded", async () => {
    if (platform() !== "linux") {
      // /proc/self/limits is Linux-only. On other platforms we can't prove
      // prlimit engaged from inside the child, so this leg is skipped.
      // The env-bound leg above runs everywhere and is the stronger check
      // for the specific audit finding (env leak).
      return;
    }
    const saved = stash();
    try {
      const server = makeProbeServer();
      const registry = ExtensionRegistry.getInstance();
      const extId = "af1-prlimit";
      registry.setManifestForTest(extId, mcpManifest(server));
      registry.setGrantedPermsForTest(extId, { grantedAt: {} });

      const payload = await probe(extId);

      expect(payload.limits).toContain("Max address space");
      const line = payload.limits
        .split("\n")
        .find((l) => l.startsWith("Max address space"));
      expect(line).toBeDefined();
      // Pre-fix (direct StdioClientTransport spawn) would show
      // "unlimited unlimited" here because the parent web-server
      // inherits those. prlimit --as=<bytes> replaces that with a
      // finite integer.
      expect(line).not.toMatch(/unlimited\s+unlimited/);
      expect(line).toMatch(/Max address space\s+\d+\s+\d+/);
    } finally {
      unstash(saved);
      ExtensionRegistry.resetInstance();
    }
  }, 20_000);

  test("NR-1: MCP protocol round-trip still works through the envelope", async () => {
    // Requirements §0 + NR-1: the wrap must not silently disable working
    // extensions. Prove `listTools` returns the probe tool and a full
    // `callTool` returns a non-error result.
    const saved = stash();
    try {
      const server = makeProbeServer();
      const registry = ExtensionRegistry.getInstance();
      const extId = "af1-nr1";
      registry.setManifestForTest(extId, mcpManifest(server));
      registry.setGrantedPermsForTest(extId, { grantedAt: {} });

      const client = await registry.getMcpClient(extId);
      try {
        const tools = await client.listTools();
        expect(tools.map((t) => t.name)).toContain("who_am_i");

        const res = await client.callTool("who_am_i", {});
        expect(res.isError).toBe(false);
        expect(res.content[0]?.type).toBe("text");
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      unstash(saved);
      ExtensionRegistry.resetInstance();
    }
  }, 20_000);
});
