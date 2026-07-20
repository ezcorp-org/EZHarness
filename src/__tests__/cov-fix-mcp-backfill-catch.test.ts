/**
 * Patch-coverage fix (db-audit/cov): the FAILURE branch of
 * `backfillMcpManifestSecrets` — the `catch (err) { backfillLog.warn(...) }`
 * (src/db/queries/extensions.ts:225,227) that keeps a bad legacy row from
 * bricking boot.
 *
 * The happy path (migrate/rehydrate/idempotent) lives in
 * mcp-secrets-backfill.test.ts, which never drives the catch. Here we force
 * `setSecret` to throw for a legacy MCP row so `persistMcpSecret` rejects
 * INSIDE the per-row try, then assert the backfill:
 *   (a) does NOT throw,
 *   (b) does NOT count the failing row as migrated, and
 *   (c) leaves the row's plaintext manifest intact (the update after
 *       persistMcpSecret never runs, so nothing is blanked).
 *
 * `../extensions/secrets-store` is snapshotted by helpers/mock-cleanup.ts, so
 * restoreModuleMocks() in afterAll re-registers the real module and the
 * throwing stub never leaks into subsequent test files.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();

// Force the credential move to fail: persistMcpSecret → setSecret throws, so
// the backfill's per-row try/catch is the only thing standing between a bad row
// and a bricked boot.
mock.module("../extensions/secrets-store", () => ({
  setSecret: async (): Promise<void> => {
    throw new Error("secret store unavailable");
  },
  getSecret: async (): Promise<string | null> => null,
}));

import {
  createExtension,
  getExtensionByName,
  backfillMcpManifestSecrets,
} from "../db/queries/extensions";
import type { McpServerDefinition } from "../extensions/types";
import type { NewExtension } from "../db/schema";

/** Property-access view over a stored server def (the union hides headers/env). */
type ServerView = { headers?: Record<string, string>; env?: Record<string, string> };
function firstServer(manifest: unknown): McpServerDefinition & ServerView {
  return (manifest as { mcpServers: (McpServerDefinition & ServerView)[] }).mcpServers[0]!;
}

/** Insert a pre-fix "legacy" row: manifest carries the PLAINTEXT MCP secret
 *  verbatim (createExtension persists the manifest as-is). */
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

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("backfillMcpManifestSecrets — a row that fails to migrate is warned, not fatal", () => {
  beforeEach(async () => await setupTestDb());

  test("setSecret throwing on a legacy row: no throw, not migrated, manifest left intact", async () => {
    await insertLegacyMcp("legacy-fail", {
      transport: "http",
      name: "legacy-fail",
      url: "https://x/mcp",
      headers: { Authorization: "Bearer SECRET", "X-Api-Key": "k123" },
    });

    // (a) The bad row is caught + warned, never re-thrown — boot survives.
    const result = await backfillMcpManifestSecrets();

    // (b) The failing row is NOT counted as migrated (it WAS scanned).
    expect(result.migrated).toBe(0);
    expect(result.scanned).toBe(1);

    // (c) The manifest is left exactly as-is: the update that would blank the
    // values runs only AFTER persistMcpSecret succeeds, so the plaintext
    // survives for the next boot's re-run to retry.
    const row = await getExtensionByName("legacy-fail");
    const server = firstServer(row!.manifest);
    expect(server.headers).toEqual({ Authorization: "Bearer SECRET", "X-Api-Key": "k123" });
    expect(JSON.stringify(row!.manifest)).toContain("Bearer SECRET");
  });

  test("a mix: the failing row is skipped while a clean non-secret row is untouched", async () => {
    // Legacy row with a plaintext secret whose setSecret will throw.
    await insertLegacyMcp("mix-fail", {
      transport: "stdio",
      name: "mix-fail",
      command: "node",
      env: { API_TOKEN: "tok-legacy" },
    });
    // A redacted MCP row (blank value) carries no plaintext → never enters the
    // try, so it is neither migrated nor affected by the failure above.
    await insertLegacyMcp("mix-clean", {
      transport: "http",
      name: "mix-clean",
      url: "https://x/mcp",
      headers: { Authorization: "" },
    });

    const result = await backfillMcpManifestSecrets();

    // Both are MCP rows (scanned=2); only the secret-bearing one hit the failing
    // try, and it did not migrate. Nothing migrated overall.
    expect(result.scanned).toBe(2);
    expect(result.migrated).toBe(0);

    // The failing row keeps its plaintext env.
    const failed = await getExtensionByName("mix-fail");
    expect(firstServer(failed!.manifest).env).toEqual({ API_TOKEN: "tok-legacy" });
  });
});
