/**
 * CI-fix regression (db-audit/ci): `rehydrateMcpServerSecrets` must degrade —
 * not crash — when the secret store / DB is unavailable.
 *
 * DEFECT: registry.getMcpClient() calls rehydrateMcpServerSecrets() on the
 * connect path. That helper called getSecret() → getDb(), which THROWS
 * "Database not initialized — call initDb() first" when no DB is wired. Any
 * existing test (or transient production outage) that constructs an
 * ExtensionRegistry with no DB then had the whole connect path crash.
 *
 * FIX: wrap ONLY the getSecret() fetch in try/catch — on error, log at debug
 * and return the passed (already value-BLANKED) definition unchanged. No
 * security relaxation: the redacted manifest carries no plaintext, so a failed
 * fetch just means no rehydration this call. The happy path (real secret
 * present) still overlays the stored values.
 *
 * The secret store is mocked here so the fallback branch is hermetic (no DB
 * required, no dependence on global init state). `../extensions/secrets-store`
 * is snapshotted by mock-cleanup, and restoreModuleMocks() re-registers the
 * real module in afterAll so the stub never leaks into other test files.
 */
import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Drives the mocked getSecret's behaviour per test.
let secretMode: "throw" | "value" | "missing" = "throw";

mock.module("../extensions/secrets-store", () => ({
  getSecret: async (): Promise<string | null> => {
    if (secretMode === "throw") {
      // Exactly what getDb() throws when initDb() was never called.
      throw new Error("Database not initialized — call initDb() first");
    }
    if (secretMode === "value") {
      return JSON.stringify({ Authorization: "Bearer REHYDRATED", "X-Api-Key": "k123" });
    }
    return null;
  },
  // extensions.ts also imports setSecret from this module; keep it exported so
  // the (unmocked) install/update helpers stay loadable.
  setSecret: async (): Promise<void> => {},
}));

// Import the SUT AFTER the mock is registered so it binds the mocked getSecret.
import { rehydrateMcpServerSecrets } from "../db/queries/extensions";
import type { McpServerDefinition } from "../extensions/types";

afterAll(() => restoreModuleMocks());

describe("rehydrateMcpServerSecrets — DB/secret-store resilience", () => {
  test("secret store unavailable (getSecret throws) → server returned UNCHANGED", async () => {
    secretMode = "throw";
    const server: McpServerDefinition = {
      transport: "http",
      name: "resilient-http",
      url: "https://x/mcp",
      headers: { Authorization: "" }, // blanked-at-rest value
    };
    const result = await rehydrateMcpServerSecrets("resilient-http", server);
    // No throw; identical content (headers still blank — no rehydration).
    expect(result).toEqual(server);
    expect((result as { headers: Record<string, string> }).headers).toEqual({ Authorization: "" });
  });

  test("stdio: secret store unavailable → env stays blanked, no crash", async () => {
    secretMode = "throw";
    const server: McpServerDefinition = {
      transport: "stdio",
      name: "resilient-stdio",
      command: "node",
      args: ["srv.js"],
      env: { API_KEY: "" },
    };
    const result = await rehydrateMcpServerSecrets("resilient-stdio", server);
    expect(result).toEqual(server);
    expect((result as { env: Record<string, string> }).env).toEqual({ API_KEY: "" });
  });

  test("real secret present → values are rehydrated (happy path still works)", async () => {
    secretMode = "value";
    const server: McpServerDefinition = {
      transport: "http",
      name: "rehydrates",
      url: "https://x/mcp",
      headers: { Authorization: "", "X-Api-Key": "" },
    };
    const result = await rehydrateMcpServerSecrets("rehydrates", server);
    expect((result as { headers: Record<string, string> }).headers).toEqual({
      Authorization: "Bearer REHYDRATED",
      "X-Api-Key": "k123",
    });
  });

  test("no stored blob (getSecret returns null) → server returned unchanged", async () => {
    secretMode = "missing";
    const server: McpServerDefinition = {
      transport: "http",
      name: "no-blob",
      url: "https://x/mcp",
      headers: { Authorization: "" },
    };
    const result = await rehydrateMcpServerSecrets("no-blob", server);
    expect(result).toEqual(server);
  });
});
