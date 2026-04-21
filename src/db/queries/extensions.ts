import { eq, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { extensions, type Extension, type NewExtension } from "../schema";
import type { McpServerDefinition, ExtensionManifestV2, ToolDefinition } from "../../extensions/types";

// Jsonb columns on `extensions` — serialize explicitly with an ::jsonb cast
// so the insert path is stable across drivers (PGlite uses drizzle's default
// `JSON.stringify` mapper, bun-sql has it monkey-patched to identity in
// connection.ts). Passing JSON text with a cast bypasses both mappers and
// lets Postgres parse the value directly — no "[object Object]" binding and
// no jsonb-string-scalar double-encoding.
function serializeJsonbFields<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = { ...data };
  if ("manifest" in out && out.manifest !== undefined && typeof out.manifest !== "string") {
    out.manifest = sql`${JSON.stringify(out.manifest)}::jsonb`;
  }
  if ("grantedPermissions" in out && out.grantedPermissions !== undefined && typeof out.grantedPermissions !== "string") {
    out.grantedPermissions = sql`${JSON.stringify(out.grantedPermissions)}::jsonb`;
  }
  return out as T;
}

export async function getExtension(id: string): Promise<Extension | null> {
  const rows = await getDb()
    .select()
    .from(extensions)
    .where(eq(extensions.id, id));
  return rows[0] ?? null;
}

export async function getExtensionByName(name: string): Promise<Extension | null> {
  const rows = await getDb()
    .select()
    .from(extensions)
    .where(eq(extensions.name, name));
  return rows[0] ?? null;
}

export async function listExtensions(enabledOnly?: boolean): Promise<Extension[]> {
  if (enabledOnly) {
    return getDb()
      .select()
      .from(extensions)
      .where(eq(extensions.enabled, true));
  }
  return getDb().select().from(extensions);
}

export async function createExtension(data: NewExtension): Promise<Extension> {
  const rows = await getDb()
    .insert(extensions)
    .values(serializeJsonbFields(data))
    .returning();
  return rows[0]!;
}

export async function updateExtension(
  id: string,
  data: Partial<Omit<NewExtension, "id">>,
): Promise<Extension | null> {
  const rows = await getDb()
    .update(extensions)
    .set({ ...serializeJsonbFields(data), updatedAt: sql`NOW()` })
    .where(eq(extensions.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteExtension(id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(extensions)
    .where(eq(extensions.id, id))
    .returning({ id: extensions.id });
  return rows.length > 0;
}

export async function incrementFailures(id: string): Promise<number> {
  const rows = await getDb()
    .update(extensions)
    .set({
      consecutiveFailures: sql`consecutive_failures + 1`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(extensions.id, id))
    .returning({ consecutiveFailures: extensions.consecutiveFailures });
  return rows[0]?.consecutiveFailures ?? 0;
}

export async function resetFailures(id: string): Promise<void> {
  await getDb()
    .update(extensions)
    .set({
      consecutiveFailures: 0,
      updatedAt: sql`NOW()`,
    })
    .where(eq(extensions.id, id));
}

export async function disableExtension(id: string): Promise<void> {
  await getDb()
    .update(extensions)
    .set({
      enabled: false,
      updatedAt: sql`NOW()`,
    })
    .where(eq(extensions.id, id));
}

/**
 * Create a new MCP-kind extension row. Caller is responsible for validating
 * connectivity and passing the live `tools/list` response as `cachedTools`
 * — those are stored in `manifest.tools` for boot-time registry hydration.
 */
export async function installMcpExtension(input: {
  name: string;
  description?: string;
  version?: string;
  authorName?: string;
  server: McpServerDefinition;
  cachedTools: ToolDefinition[];
}): Promise<Extension> {
  const manifest: ExtensionManifestV2 = {
    schemaVersion: 2,
    name: input.name,
    version: input.version ?? "0.0.0",
    description: input.description ?? "",
    author: { name: input.authorName ?? "local" },
    kind: "mcp",
    mcpServers: [input.server],
    tools: input.cachedTools,
    permissions: {},
  };
  return createExtension({
    name: input.name,
    version: manifest.version,
    description: manifest.description,
    manifest,
    source: `mcp:${input.server.transport}`,
    installPath: null,
    enabled: true,
    grantedPermissions: { grantedAt: {} },
    checksumVerified: false,
    consecutiveFailures: 0,
  } as NewExtension);
}
