/**
 * MCP credential isolation — legacy at-rest backfill (db-audit/mcp-secrets
 * integration follow-up).
 *
 * New installs/updates already redact-at-rest and every read path scrubs
 * legacy rows defensively, but a row installed BEFORE the fix still carries
 * the plaintext transport auth inside `extensions.manifest` jsonb.
 * `backfillMcpManifestSecrets()` (wired into migrate()) moves each legacy
 * secret into the AAD-bound `extension_secrets` store and rewrites the manifest
 * to its blanked form. These tests prove it migrates, rehydrates, and is
 * idempotent + non-destructive to non-MCP rows.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createExtension,
  getExtensionByName,
  backfillMcpManifestSecrets,
  rehydrateMcpServerSecrets,
} from "../db/queries/extensions";
import { getSecret } from "../extensions/secrets-store";
import type { McpServerDefinition } from "../extensions/types";
import type { NewExtension } from "../db/schema";

/** Property-access view over a stored server def (the union hides headers/env). */
type ServerView = { headers?: Record<string, string>; env?: Record<string, string> };
function firstServer(manifest: unknown): McpServerDefinition & ServerView {
  return (manifest as { mcpServers: (McpServerDefinition & ServerView)[] }).mcpServers[0];
}

/** Insert a row whose manifest still carries a PLAINTEXT MCP secret — i.e. a
 *  pre-fix "legacy" row (createExtension persists the manifest verbatim). */
async function insertLegacyMcp(name: string, server: McpServerDefinition) {
  return createExtension({
    name,
    version: "1.0.0",
    description: "legacy mcp",
    manifest: {
      schemaVersion: 2,
      name,
      version: "1.0.0",
      description: "legacy mcp",
      author: { name: "t" },
      kind: "mcp",
      mcpServers: [server],
      tools: [],
      permissions: {},
    },
    source: "mcp:legacy",
    installPath: "",
    enabled: true,
    grantedPermissions: { grantedAt: {} },
    checksumVerified: false,
    consecutiveFailures: 0,
  } as NewExtension);
}

describe("backfillMcpManifestSecrets", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("migrates a legacy http row: manifest blanked at rest, secret rehydrates", async () => {
    await insertLegacyMcp("legacy-http", {
      transport: "http",
      name: "legacy-http",
      url: "https://x/mcp",
      headers: { Authorization: "Bearer LEAK", "X-Api-Key": "k123" },
    });

    const result = await backfillMcpManifestSecrets();
    expect(result.migrated).toBe(1);

    // Manifest at rest no longer carries the plaintext.
    const row = await getExtensionByName("legacy-http");
    const server = firstServer(row!.manifest);
    expect(server.headers).toEqual({ Authorization: "", "X-Api-Key": "" });
    expect(JSON.stringify(row!.manifest)).not.toContain("LEAK");

    // The real values live in the encrypted store and rehydrate on connect.
    const stored = await getSecret("legacy-http", null, "mcp:auth");
    expect(JSON.parse(stored!)).toEqual({ Authorization: "Bearer LEAK", "X-Api-Key": "k123" });
    const rehydrated = (await rehydrateMcpServerSecrets("legacy-http", server)) as McpServerDefinition & ServerView;
    expect(rehydrated.headers).toEqual({ Authorization: "Bearer LEAK", "X-Api-Key": "k123" });
  });

  test("migrates a legacy stdio row's env", async () => {
    await insertLegacyMcp("legacy-stdio", {
      transport: "stdio",
      name: "legacy-stdio",
      command: "node",
      env: { API_TOKEN: "tok-legacy" },
    });
    const result = await backfillMcpManifestSecrets();
    expect(result.migrated).toBe(1);
    const row = await getExtensionByName("legacy-stdio");
    const server = firstServer(row!.manifest);
    expect(server.env).toEqual({ API_TOKEN: "" });
    expect(JSON.parse((await getSecret("legacy-stdio", null, "mcp:auth"))!)).toEqual({ API_TOKEN: "tok-legacy" });
  });

  test("is idempotent — a second run migrates nothing", async () => {
    await insertLegacyMcp("legacy-idem", {
      transport: "http",
      name: "legacy-idem",
      url: "https://x/mcp",
      headers: { Authorization: "Bearer ONCE" },
    });
    expect((await backfillMcpManifestSecrets()).migrated).toBe(1);
    const second = await backfillMcpManifestSecrets();
    expect(second.migrated).toBe(0);
  });

  test("leaves an already-redacted MCP row and non-MCP rows untouched", async () => {
    // Already-redacted (blank values) → no plaintext → not migrated.
    await insertLegacyMcp("already-redacted", {
      transport: "http",
      name: "already-redacted",
      url: "https://x/mcp",
      headers: { Authorization: "" },
    });
    // A stdio MCP with no env at all → nothing sensitive.
    await insertLegacyMcp("no-secret", { transport: "stdio", name: "no-secret", command: "node" });

    const result = await backfillMcpManifestSecrets();
    expect(result.migrated).toBe(0);
  });
});
