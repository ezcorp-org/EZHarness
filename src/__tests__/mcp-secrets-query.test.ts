/**
 * MCP credential isolation (db-audit/mcp-secrets).
 *
 * An MCP server definition carries transport auth — `headers` (http/sse
 * bearer tokens) and `env` (stdio API keys). Persisting those verbatim in
 * `manifest.mcpServers` leaked them to every read-scope member via GET
 * /api/extensions (and every other row-serving route). These tests prove the
 * fix in src/db/queries/extensions.ts:
 *
 *   (a) install/update store a VALUE-BLANKED manifest — the secret is absent
 *       from anything a read query returns (the GET /api/extensions payload).
 *   (b) the real secret round-trips through the AAD-bound extension_secrets
 *       store and is rehydrated on the connect path (rehydrateMcpServerSecrets).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  installMcpExtension,
  updateMcpExtension,
  getExtension,
  getExtensionByName,
  listExtensions,
  createExtension,
  redactMcpServer,
  redactExtensionSecrets,
  rehydrateMcpServerSecrets,
} from "../db/queries/extensions";
import { getSecret, setSecret } from "../extensions/secrets-store";
import { getSecretRow } from "../db/queries/extension-secrets";
import type { McpServerDefinition } from "../extensions/types";
import type { NewExtension } from "../db/schema";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe("redactMcpServer (pure)", () => {
  test("http/sse: blanks header VALUES, keeps KEYS", () => {
    const redacted = redactMcpServer({
      transport: "http",
      name: "s",
      url: "https://x/mcp",
      headers: { Authorization: "Bearer SECRET", "X-Api-Key": "abc123" },
    });
    expect(redacted).toEqual({
      transport: "http",
      name: "s",
      url: "https://x/mcp",
      headers: { Authorization: "", "X-Api-Key": "" },
    });
  });

  test("stdio: blanks env VALUES, keeps KEYS", () => {
    const redacted = redactMcpServer({
      transport: "stdio",
      name: "s",
      command: "node",
      env: { API_TOKEN: "tok", OTHER: "v" },
    });
    expect(redacted).toEqual({
      transport: "stdio",
      name: "s",
      command: "node",
      env: { API_TOKEN: "", OTHER: "" },
    });
  });

  test("no headers/env → returned unchanged", () => {
    const stdio: McpServerDefinition = { transport: "stdio", name: "s", command: "node" };
    expect(redactMcpServer(stdio)).toBe(stdio);
    const http: McpServerDefinition = { transport: "http", name: "s", url: "https://x/mcp" };
    expect(redactMcpServer(http)).toBe(http);
  });
});

describe("redactExtensionSecrets (row-level, for read responses)", () => {
  test("scrubs a legacy MCP manifest carrying a plaintext bearer token", () => {
    const row = {
      id: "x",
      manifest: {
        kind: "mcp",
        name: "legacy",
        mcpServers: [
          { transport: "sse", name: "legacy", url: "https://x/sse", headers: { Authorization: "Bearer LEAK" } },
        ],
        tools: [],
        permissions: {},
      },
    };
    const redacted = redactExtensionSecrets(row);
    expect(JSON.stringify(redacted)).not.toContain("LEAK");
    expect((redacted.manifest as any).mcpServers[0].headers).toEqual({ Authorization: "" });
  });

  test("non-MCP row passes through untouched (same reference)", () => {
    const row = { id: "x", manifest: { kind: "local", name: "l", tools: [], permissions: {} } };
    expect(redactExtensionSecrets(row)).toBe(row);
  });
});

describe("installMcpExtension — http headers", () => {
  test("stored manifest is blanked; secret round-trips through the encrypted store", async () => {
    const ext = await installMcpExtension({
      name: "mcp-sec-http",
      server: {
        transport: "http",
        name: "mcp-sec-http",
        url: "https://api.example/mcp",
        headers: { Authorization: "Bearer TOP-SECRET" },
      },
      cachedTools: [],
    });

    // (a) The returned + persisted manifest carries the KEY but no VALUE.
    const stored = ext.manifest.mcpServers?.[0] as any;
    expect(stored.headers).toEqual({ Authorization: "" });
    expect(JSON.stringify(ext.manifest)).not.toContain("TOP-SECRET");

    // A read query (what GET /api/extensions serves) never returns the secret.
    const roundtrip = await getExtensionByName("mcp-sec-http");
    expect(JSON.stringify(roundtrip)).not.toContain("TOP-SECRET");
    const list = await listExtensions();
    expect(JSON.stringify(list)).not.toContain("TOP-SECRET");

    // (b) The ciphertext row exists (keyed by the extension SLUG) and is
    // opaque — the plaintext is not stored anywhere in the clear.
    const secretRow = await getSecretRow({
      extensionId: "mcp-sec-http",
      projectId: null,
      userId: null,
      name: "mcp:auth",
    });
    expect(secretRow).toBeDefined();
    expect(secretRow!.ciphertext).not.toContain("TOP-SECRET");

    // Round-trip decrypt for the connect path.
    const plaintext = await getSecret("mcp-sec-http", null, "mcp:auth");
    expect(plaintext).toBe(JSON.stringify({ Authorization: "Bearer TOP-SECRET" }));

    const rehydrated = await rehydrateMcpServerSecrets("mcp-sec-http", stored);
    expect((rehydrated as any).headers).toEqual({ Authorization: "Bearer TOP-SECRET" });
  });
});

describe("installMcpExtension — stdio env", () => {
  test("env secret is moved out of the manifest and rehydrates for connect", async () => {
    const ext = await installMcpExtension({
      name: "mcp-sec-stdio",
      server: {
        transport: "stdio",
        name: "mcp-sec-stdio",
        command: "node",
        args: ["srv.js"],
        env: { API_KEY: "sk-live-123" },
      },
      cachedTools: [],
    });

    const stored = ext.manifest.mcpServers?.[0] as any;
    expect(stored.env).toEqual({ API_KEY: "" });
    expect(JSON.stringify(ext.manifest)).not.toContain("sk-live-123");

    const rehydrated = await rehydrateMcpServerSecrets("mcp-sec-stdio", stored);
    expect((rehydrated as any).env).toEqual({ API_KEY: "sk-live-123" });
    // Non-secret fields survive rehydration.
    expect((rehydrated as any).command).toBe("node");
    expect((rehydrated as any).args).toEqual(["srv.js"]);
  });

  test("no headers/env → no secret row written; rehydrate is a no-op", async () => {
    await installMcpExtension({
      name: "mcp-sec-none",
      server: { transport: "stdio", name: "mcp-sec-none", command: "node" },
      cachedTools: [],
    });
    const secretRow = await getSecretRow({
      extensionId: "mcp-sec-none",
      projectId: null,
      userId: null,
      name: "mcp:auth",
    });
    expect(secretRow).toBeUndefined();

    const server: McpServerDefinition = { transport: "stdio", name: "mcp-sec-none", command: "node" };
    expect(await rehydrateMcpServerSecrets("mcp-sec-none", server)).toEqual(server);
  });
});

describe("updateMcpExtension", () => {
  test("re-encrypts the new secret and keeps the manifest blanked", async () => {
    const ext = await installMcpExtension({
      name: "mcp-sec-upd",
      server: {
        transport: "http",
        name: "mcp-sec-upd",
        url: "https://old.example/mcp",
        headers: { Authorization: "Bearer OLD-TOKEN" },
      },
      cachedTools: [],
    });

    const updated = await updateMcpExtension({
      id: ext.id,
      server: {
        transport: "http",
        name: "mcp-sec-upd",
        url: "https://new.example/mcp",
        headers: { Authorization: "Bearer NEW-TOKEN" },
      },
      cachedTools: [],
    });
    expect(updated).not.toBeNull();

    const stored = updated!.manifest.mcpServers?.[0] as any;
    expect(stored.headers).toEqual({ Authorization: "" });
    expect(JSON.stringify(updated!.manifest)).not.toContain("NEW-TOKEN");
    expect(JSON.stringify(updated!.manifest)).not.toContain("OLD-TOKEN");

    // The store now holds the rotated value.
    const plaintext = await getSecret("mcp-sec-upd", null, "mcp:auth");
    expect(plaintext).toBe(JSON.stringify({ Authorization: "Bearer NEW-TOKEN" }));

    // Read-path row is clean.
    const roundtrip = await getExtension(ext.id);
    expect(JSON.stringify(roundtrip)).not.toContain("NEW-TOKEN");
  });
});

describe("rehydrateMcpServerSecrets edge cases", () => {
  test("missing store blob → server returned unchanged", async () => {
    const server: McpServerDefinition = {
      transport: "http",
      name: "no-secret",
      url: "https://x/mcp",
      headers: { Authorization: "" },
    };
    // No extension row / secret for this slug.
    expect(await rehydrateMcpServerSecrets("nonexistent-slug", server)).toEqual(server);
  });

  test("corrupt (non-JSON) store blob → server returned unchanged", async () => {
    const ext = await installMcpExtension({
      name: "mcp-sec-corrupt",
      server: { transport: "http", name: "mcp-sec-corrupt", url: "https://x/mcp", headers: { Authorization: "Bearer X" } },
      cachedTools: [],
    });
    // Overwrite the auth blob with a non-JSON string.
    await setSecret("mcp-sec-corrupt", null, "mcp:auth", "not-json{");
    const stored = ext.manifest.mcpServers?.[0] as McpServerDefinition;
    const rehydrated = await rehydrateMcpServerSecrets("mcp-sec-corrupt", stored);
    // Blanked manifest value survives (no crash, no partial secret).
    expect((rehydrated as any).headers).toEqual({ Authorization: "" });
  });

  test("non-MCP extension can't smuggle secrets through the MCP helpers", async () => {
    // Sanity: a plain local extension is untouched by redactExtensionSecrets.
    const local = await createExtension({
      name: "plain-local",
      version: "1.0.0",
      description: "local",
      manifest: {
        schemaVersion: 2,
        name: "plain-local",
        version: "1.0.0",
        description: "local",
        author: { name: "local" },
        kind: "local",
        tools: [],
        permissions: {},
      },
      source: "local",
      installPath: "/tmp/x",
      enabled: true,
      grantedPermissions: { grantedAt: {} },
      checksumVerified: false,
      consecutiveFailures: 0,
    } as NewExtension);
    expect(redactExtensionSecrets(local)).toBe(local);
  });
});
