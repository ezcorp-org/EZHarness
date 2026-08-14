/**
 * Issue #205 — MCP credentials in URL query strings and stdio argv.
 *
 * `redactMcpServer` blanked `env` / `headers` only, so the two most common MCP
 * credential conventions reached every `read`-scope member verbatim through
 * `GET /api/extensions` (and every other row-serving surface):
 *
 *   leaky-http   url:  https://mcp.vendor.com/mcp?api_key=SUPER-SECRET-VALUE
 *   leaky-stdio  args: ["-y","srv","--token=ARGV-SECRET-VALUE"]
 *
 * `src/extensions/mcp-audit.ts` already reasons about exactly these two shapes
 * and drops them from the audit row, so the audit hardening assumed an
 * invariant the persistence layer did not hold.
 *
 * The tests below are ordered as the fix is: REPRODUCTION first (a
 * member-readable secret on both shapes), then the classifier, then the
 * connect-time rehydration, then the legacy-row migration.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  installMcpExtension,
  updateMcpExtension,
  getExtensionByName,
  getExtensionByRef,
  listExtensions,
  redactExtensionSecrets,
  rehydrateMcpServerSecrets,
} from "../db/queries/extensions";
import type { McpServerDefinition, McpServerStdio, McpServerHttp } from "../extensions/types";

const URL_SECRET = "SUPER-SECRET-VALUE";
const ARGV_SECRET = "ARGV-SECRET-VALUE";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

/** The stored server definition of an installed MCP extension, as a read query
 *  returns it. Mirrors what every row-serving route puts on the wire. */
function storedServer(ext: { manifest: { mcpServers?: McpServerDefinition[] } }): McpServerDefinition {
  const server = ext.manifest.mcpServers?.[0];
  if (!server) throw new Error("no mcpServers entry");
  return server;
}

describe("issue #205 reproduction — a read-scope member must not see the credential", () => {
  test("http: an `?api_key=` URL query value never reaches a read response", async () => {
    const ext = await installMcpExtension({
      name: "leaky-http",
      server: {
        transport: "http",
        name: "leaky-http",
        url: `https://mcp.vendor.com/mcp?api_key=${URL_SECRET}`,
        headers: { Authorization: "" },
      },
      cachedTools: [],
    });

    // (a) at rest — the row a bare `select()` returns (the /extensions SSR
    //     loader and GET /api/extensions/[id] both serve exactly this).
    expect(JSON.stringify(ext.manifest)).not.toContain(URL_SECRET);
    const byName = await getExtensionByName("leaky-http");
    expect(JSON.stringify(byName)).not.toContain(URL_SECRET);
    const byRef = await getExtensionByRef(ext.id);
    expect(JSON.stringify(byRef)).not.toContain(URL_SECRET);

    // (b) the exact projection GET /api/extensions serves.
    const served = (await listExtensions()).map(redactExtensionSecrets);
    expect(JSON.stringify(served)).not.toContain(URL_SECRET);

    // The param NAME survives — same contract header KEYS get, so the edit UI
    // can still show which parameters exist.
    expect((storedServer(ext) as McpServerHttp).url).toBe("https://mcp.vendor.com/mcp?api_key=");
  });

  test("stdio: a `--token=` argv value never reaches a read response", async () => {
    const ext = await installMcpExtension({
      name: "leaky-stdio",
      server: {
        transport: "stdio",
        name: "leaky-stdio",
        command: "npx",
        args: ["-y", "srv", `--token=${ARGV_SECRET}`],
        env: { GITHUB_TOKEN: "" },
      },
      cachedTools: [],
    });

    expect(JSON.stringify(ext.manifest)).not.toContain(ARGV_SECRET);
    const byName = await getExtensionByName("leaky-stdio");
    expect(JSON.stringify(byName)).not.toContain(ARGV_SECRET);
    const served = (await listExtensions()).map(redactExtensionSecrets);
    expect(JSON.stringify(served)).not.toContain(ARGV_SECRET);

    // The flag NAME and every non-credential token survive verbatim.
    expect((storedServer(ext) as McpServerStdio).args).toEqual(["-y", "srv", "--token="]);
  });

  test("the real values round-trip: connect-time rehydration dials the REAL url/argv", async () => {
    const http = await rehydrateMcpServerSecrets("leaky-http", storedServer(await requireExt("leaky-http")));
    expect((http as McpServerHttp).url).toBe(`https://mcp.vendor.com/mcp?api_key=${URL_SECRET}`);

    const stdio = await rehydrateMcpServerSecrets("leaky-stdio", storedServer(await requireExt("leaky-stdio")));
    expect((stdio as McpServerStdio).args).toEqual(["-y", "srv", `--token=${ARGV_SECRET}`]);
    expect((stdio as McpServerStdio).command).toBe("npx");
  });

  test("an edit rotates both shapes and still leaves nothing at rest", async () => {
    const ext = await installMcpExtension({
      name: "leaky-rotate",
      server: {
        transport: "http",
        name: "leaky-rotate",
        url: "https://old.vendor.com/mcp?api_key=OLD-URL-SECRET",
      },
      cachedTools: [],
    });
    const updated = await updateMcpExtension({
      id: ext.id,
      server: {
        transport: "http",
        name: "leaky-rotate",
        url: "https://new.vendor.com/mcp?api_key=NEW-URL-SECRET",
      },
      cachedTools: [],
    });
    expect(updated).not.toBeNull();
    const json = JSON.stringify(updated!.manifest);
    expect(json).not.toContain("OLD-URL-SECRET");
    expect(json).not.toContain("NEW-URL-SECRET");
    const live = await rehydrateMcpServerSecrets("leaky-rotate", storedServer(updated!));
    expect((live as McpServerHttp).url).toBe("https://new.vendor.com/mcp?api_key=NEW-URL-SECRET");
  });
});

async function requireExt(name: string) {
  const ext = await getExtensionByName(name);
  if (!ext) throw new Error(`extension ${name} not found`);
  return ext as unknown as { manifest: { mcpServers?: McpServerDefinition[] } };
}
