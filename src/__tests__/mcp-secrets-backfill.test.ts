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
import { getSecret, setSecret } from "../extensions/secrets-store";
import { getDb } from "../db/connection";
import { migrate } from "../db/migrate";
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
    // Issue #205 wrapped the payload in a versioned envelope so the same blob
    // can also carry the URL/argv carriers; `auth` is the transport-auth map.
    const stored = await getSecret("legacy-http", null, "mcp:auth");
    expect(JSON.parse(stored!)).toEqual({
      v: 2,
      auth: { Authorization: "Bearer LEAK", "X-Api-Key": "k123" },
    });
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
    expect(JSON.parse((await getSecret("legacy-stdio", null, "mcp:auth"))!)).toEqual({
      v: 2,
      auth: { API_TOKEN: "tok-legacy" },
    });
  });

  // ── Issue #205: the two carriers the first version of this backfill missed ──

  test("migrates a legacy URL-QUERY secret and keeps the host", async () => {
    await insertLegacyMcp("legacy-url-query", {
      transport: "http",
      name: "legacy-url-query",
      url: "https://mcp.vendor.com/mcp?api_key=URL-LEAK&t=9",
    });
    expect((await backfillMcpManifestSecrets()).migrated).toBe(1);

    const row = await getExtensionByName("legacy-url-query");
    const server = firstServer(row!.manifest) as McpServerDefinition & { url: string };
    expect(server.url).toBe("https://mcp.vendor.com/mcp?api_key=&t=");
    expect(JSON.stringify(row!.manifest)).not.toContain("URL-LEAK");

    const rehydrated = (await rehydrateMcpServerSecrets("legacy-url-query", server)) as
      McpServerDefinition & { url: string };
    expect(rehydrated.url).toBe("https://mcp.vendor.com/mcp?api_key=URL-LEAK&t=9");
  });

  test("migrates a legacy ARGV secret and keeps every non-credential token", async () => {
    await insertLegacyMcp("legacy-argv", {
      transport: "stdio",
      name: "legacy-argv",
      command: "npx",
      args: ["-y", "srv", "--token=ARGV-LEAK", "--api-key", "PAIR-LEAK"],
    });
    expect((await backfillMcpManifestSecrets()).migrated).toBe(1);

    const row = await getExtensionByName("legacy-argv");
    const server = firstServer(row!.manifest) as McpServerDefinition & { args?: string[] };
    expect(server.args).toEqual(["-y", "srv", "--token=", "--api-key", ""]);
    const json = JSON.stringify(row!.manifest);
    expect(json).not.toContain("ARGV-LEAK");
    expect(json).not.toContain("PAIR-LEAK");

    const rehydrated = (await rehydrateMcpServerSecrets("legacy-argv", server)) as
      McpServerDefinition & { args?: string[] };
    expect(rehydrated.args).toEqual(["-y", "srv", "--token=ARGV-LEAK", "--api-key", "PAIR-LEAK"]);
  });

  test("a row healed by an EARLIER build keeps its stored auth when the url is migrated", async () => {
    // The dangerous composition: this row's `headers` were already moved to the
    // store by the pre-#205 backfill, so its manifest holds only blanks there —
    // but its URL still leaks. Rebuilding the blob from the manifest alone would
    // carry no `auth` and REPLACE the stored one, destroying a credential this
    // pass cannot reconstruct. The backfill therefore merges.
    await insertLegacyMcp("half-healed", {
      transport: "http",
      name: "half-healed",
      url: "https://h/mcp?api_key=STILL-LEAKING",
      headers: { Authorization: "" },
    });
    // Pre-#205 blobs are a BARE auth map with no envelope.
    await setSecret("half-healed", null, "mcp:auth", JSON.stringify({ Authorization: "Bearer KEEP-ME" }));

    expect((await backfillMcpManifestSecrets()).migrated).toBe(1);

    const row = await getExtensionByName("half-healed");
    const server = firstServer(row!.manifest);
    expect(JSON.stringify(row!.manifest)).not.toContain("STILL-LEAKING");
    const rehydrated = (await rehydrateMcpServerSecrets("half-healed", server)) as
      McpServerDefinition & ServerView & { url: string };
    expect(rehydrated.headers).toEqual({ Authorization: "Bearer KEEP-ME" });
    expect(rehydrated.url).toBe("https://h/mcp?api_key=STILL-LEAKING");
  });

  test("is idempotent across the NEW carriers too", async () => {
    await insertLegacyMcp("legacy-idem-205", {
      transport: "stdio",
      name: "legacy-idem-205",
      command: "npx",
      args: ["--token=ONCE"],
      env: { K: "v" },
    });
    expect((await backfillMcpManifestSecrets()).migrated).toBe(1);
    expect((await backfillMcpManifestSecrets()).migrated).toBe(0);
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

  test("migrate() actually RUNS this backfill (the wiring, not just the function)", async () => {
    // Every other test in this file calls `backfillMcpManifestSecrets()`
    // directly, so deleting its `await` in `migrate.ts` reds nothing — the
    // line stays *covered*, because every DB test runs `migrate()`, while
    // nothing asserts the behaviour. This drives the REAL `migrate()` instead.
    //
    // Seeded AFTER `setupTestDb()` because the table has to exist first;
    // `migrate()` is idempotent, so the second pass is the one that sees the
    // row. (The sibling capability backfill's wiring is asserted the same way
    // in `db-migration-postgres.test.ts`, which needs no live secret store.)
    await insertLegacyMcp("wired-http", {
      transport: "http",
      name: "wired-http",
      url: "https://x/mcp",
      headers: { Authorization: "Bearer WIRED-LEAK" },
    });

    await migrate(getDb());

    const row = await getExtensionByName("wired-http");
    // The KEY survives (the edit form pre-fills header names); the VALUE is
    // blanked and the real token moved to the AAD-bound store.
    expect(firstServer(row!.manifest).headers).toEqual({ Authorization: "" });
    expect(JSON.stringify(row!.manifest)).not.toContain("WIRED-LEAK");
    expect(await getSecret("wired-http", null, "mcp:auth")).toContain("WIRED-LEAK");
  });
});
