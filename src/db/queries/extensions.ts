import { and, eq, or, sql, inArray } from "drizzle-orm";
import { getDb, getPglite } from "../connection";
import { extensions, type Extension, type NewExtension } from "../schema";
import type { McpServerDefinition, ExtensionManifestV2, ToolDefinition } from "../../extensions/types";

// Jsonb columns on `extensions` need DRIVER-SPECIFIC serialization:
//
//   - PGlite: drizzle's default `JSON.stringify` jsonb mapper is active.
//     Passing JSON text with an explicit `::jsonb` cast bypasses it and
//     lets Postgres parse the value directly — stable, no "[object Object]"
//     binding.
//   - bun-sql (external Postgres): drizzle's jsonb mapper is monkey-patched
//     to IDENTITY in connection.ts because Bun.sql serializes JS OBJECTS to
//     jsonb correctly on its own. The `${JSON.stringify(x)}::jsonb` cast
//     BYPASSES that identity mapper and binds the JSON *text* as a param,
//     which Bun.sql stores as a jsonb STRING scalar ({"x":1} → "{\"x\":1}")
//     — the exact double-encoding the monkey-patch + boot-repair exist to
//     prevent. On a RUNTIME write (e.g. reapprove-drift or a capability-
//     override grant) that string isn't repaired until the next boot, so
//     `granted.search` reads back `undefined` and the capability looks
//     disabled. So on bun-sql we pass the PLAIN OBJECT and let the driver
//     serialize it; only PGlite gets the explicit text+cast.
function serializeJsonbFields<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = { ...data };
  // `getPglite()` is non-null ⟺ PGlite; null ⟺ bun-sql (external Postgres).
  const onPglite = getPglite() !== null;
  const enc = (v: unknown): unknown => (onPglite ? sql`${JSON.stringify(v)}::jsonb` : v);
  if ("manifest" in out && out.manifest !== undefined && typeof out.manifest !== "string") {
    out.manifest = enc(out.manifest);
  }
  if ("grantedPermissions" in out && out.grantedPermissions !== undefined && typeof out.grantedPermissions !== "string") {
    out.grantedPermissions = enc(out.grantedPermissions);
  }
  // v1.3 security review HIGH 2 — `installed_permissions` is jsonb and
  // nullable. Match the granted_permissions serialization pattern; null
  // passes through to the driver verbatim.
  if (
    "installedPermissions" in out
    && out.installedPermissions !== undefined
    && out.installedPermissions !== null
    && typeof out.installedPermissions !== "string"
  ) {
    out.installedPermissions = enc(out.installedPermissions);
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

/**
 * Batch-fetch extensions by name. Returns a Map<name, extension> for O(1) lookup.
 * Missing names are simply absent from the map (no throw). Empty input → empty map.
 *
 * Single round-trip via `IN (...)` — replaces N concurrent `getExtensionByName(name)`
 * calls in mention-wiring (wireMentionedExtensions).
 */
export async function getExtensionsByNames(names: string[]): Promise<Map<string, Extension>> {
  const out = new Map<string, Extension>();
  if (names.length === 0) return out;
  const unique = [...new Set(names)];
  const rows = await getDb()
    .select()
    .from(extensions)
    .where(inArray(extensions.name, unique));
  for (const row of rows) out.set(row.name, row);
  return out;
}

/**
 * Owner-scoped lookup for the "modify my extension" flow. Mirrors the
 * `ez_drafts` `getDraft(id,userId)` opacity contract: returns the row
 * ONLY when it is owned by `userId`, an admin has flipped `modifiable`
 * true, AND it is not a bundled extension. A miss/not-owned/flag-off/
 * bundled row are all indistinguishable (null) so the caller can never
 * probe ownership of another user's extension. `nameOrId` accepts
 * either the id (web route) or the manifest name (in-chat RPC).
 */
export async function getUserModifiableExtension(
  nameOrId: string,
  userId: string,
): Promise<Extension | null> {
  const rows = await getDb()
    .select()
    .from(extensions)
    .where(
      and(
        or(eq(extensions.id, nameOrId), eq(extensions.name, nameOrId)),
        eq(extensions.creatorUserId, userId),
        eq(extensions.modifiable, true),
        eq(extensions.isBundled, false),
      ),
    );
  return rows[0] ?? null;
}

/**
 * Admin-only mutation: flip the `modifiable` gate. The route layer
 * enforces `requireRole(locals,"admin")`; this is the bare write.
 */
export async function setExtensionModifiable(
  id: string,
  modifiable: boolean,
): Promise<Extension | null> {
  const rows = await getDb()
    .update(extensions)
    .set({ modifiable, updatedAt: sql`NOW()` })
    .where(eq(extensions.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function listExtensions(
  enabledOnlyOrOpts?: boolean | { enabledOnly?: boolean; bundled?: boolean },
): Promise<Extension[]> {
  // Back-compat: prior signature was `listExtensions(enabledOnly?: boolean)`.
  // Phase 52 added the bundled filter for the Library tabs split — same
  // single-arg shape, but admit an options object so call sites can compose
  // bundled+enabled filters without overloading the boolean position.
  const opts = typeof enabledOnlyOrOpts === "boolean"
    ? { enabledOnly: enabledOnlyOrOpts }
    : (enabledOnlyOrOpts ?? {});

  const conds = [];
  if (opts.enabledOnly) conds.push(eq(extensions.enabled, true));
  if (opts.bundled !== undefined) conds.push(eq(extensions.isBundled, opts.bundled));

  const q = getDb().select().from(extensions);
  if (conds.length === 0) return q;
  if (conds.length === 1) return q.where(conds[0]!);
  return q.where(and(...conds));
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

/**
 * Re-point an existing MCP extension at a new server config and refresh its
 * cached tool list (edit-after-install). Preserves the extension's identity
 * (name, version, author, permissions) — only the connection (`mcpServers`),
 * the `tools` snapshot, the optional `description`, and the `source` slug
 * change. Returns the updated extension, or `null` if the id is missing or
 * the extension is not an MCP extension.
 *
 * The caller is responsible for having already verified connectivity +
 * pulled `cachedTools` from the *new* config (the install path does the same
 * with a throwaway client) and for reloading the registry afterwards.
 */
export async function updateMcpExtension(input: {
  id: string;
  description?: string;
  server: McpServerDefinition;
  cachedTools: ToolDefinition[];
}): Promise<Extension | null> {
  const existing = await getExtension(input.id);
  if (!existing) return null;
  const prevManifest = existing.manifest as ExtensionManifestV2;
  if (prevManifest.kind !== "mcp") return null;

  const manifest: ExtensionManifestV2 = {
    ...prevManifest,
    description: input.description ?? prevManifest.description,
    mcpServers: [input.server],
    tools: input.cachedTools,
  };

  return updateExtension(input.id, {
    description: manifest.description,
    manifest,
    source: `mcp:${input.server.transport}`,
  });
}
