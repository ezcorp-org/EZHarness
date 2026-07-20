import { and, eq, or, sql, inArray } from "drizzle-orm";
import { getDb, getPglite } from "../connection";
import { extensions, type Extension, type NewExtension } from "../schema";
import type { McpServerDefinition, ExtensionManifestV2, ToolDefinition } from "../../extensions/types";
import { getSecret, setSecret } from "../../extensions/secrets-store";
import { logger } from "../../logger";

const backfillLog = logger.child("db.queries.extensions");

// ── MCP credential isolation ──────────────────────────────────────────────
//
// An MCP server definition legitimately carries transport auth — `headers`
// for http/sse (typically `Authorization` bearer tokens) and `env` for stdio
// (API keys). Persisting those verbatim inside `manifest.mcpServers` leaked
// them: the row (manifest included) is served by GET /api/extensions and many
// other read-scope routes, so ANY authenticated member could exfiltrate the
// credential. This mirrors the exact hole the github-projects PAT backfill
// closed for the broadly-readable `settings` table.
//
// Fix (mirrors the github-projects precedent): the secret VALUES never touch
// the manifest at rest. On install/update we move them into the AAD-bound
// `extension_secrets` store keyed by the extension's stable slug (the FK
// target of `extension_secrets.extension_id`, global scope). The manifest we
// persist keeps only the secret KEYS with blanked values — enough for the edit
// UI to show "which headers exist" without exposing the secret. The real
// values are rehydrated on the server-side connect path via
// `rehydrateMcpServerSecrets`.

/** Secret name for an MCP extension's transport auth blob (http/sse `headers`
 *  or stdio `env`) in the `extension_secrets` store. One JSON blob per
 *  extension, GLOBAL scope (projectId/userId null) — MCP servers are
 *  admin-installed platform-wide, not per-project/per-user. */
const MCP_AUTH_SECRET_NAME = "mcp:auth";

/** The transport's sensitive map: `env` for stdio, `headers` for http/sse.
 *  Returns null when there is nothing sensitive to move. */
function mcpSecretMap(server: McpServerDefinition): Record<string, string> | null {
  const map = server.transport === "stdio" ? server.env : server.headers;
  if (!map || Object.keys(map).length === 0) return null;
  return map;
}

/** Same-shaped map with every value blanked — keeps the KEY set (the edit UI
 *  pre-fills header keys with blank values) while carrying no plaintext. */
function blankValues(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(map)) out[k] = "";
  return out;
}

/**
 * Strip secret VALUES from an MCP server definition, preserving the KEY set.
 * The returned definition is safe to persist in the manifest and to serve to
 * read-scope clients. Non-secret-bearing definitions pass through untouched.
 */
export function redactMcpServer(server: McpServerDefinition): McpServerDefinition {
  if (server.transport === "stdio") {
    if (!server.env || Object.keys(server.env).length === 0) return server;
    return { ...server, env: blankValues(server.env) };
  }
  if (!server.headers || Object.keys(server.headers).length === 0) return server;
  return { ...server, headers: blankValues(server.headers) };
}

/**
 * Redact the MCP transport secrets from an extension ROW's manifest for a
 * read-scope response. Defense-in-depth: new installs already store a redacted
 * manifest at rest, but this also scrubs any legacy row whose manifest still
 * carries plaintext (until a backfill migrates it). Non-MCP rows pass through.
 */
export function redactExtensionSecrets<T extends { manifest: unknown }>(ext: T): T {
  const manifest = ext.manifest as ExtensionManifestV2 | null;
  if (!manifest || manifest.kind !== "mcp" || !manifest.mcpServers?.length) return ext;
  return {
    ...ext,
    manifest: { ...manifest, mcpServers: manifest.mcpServers.map(redactMcpServer) },
  };
}

/** Encrypt + store an MCP extension's transport auth in `extension_secrets`.
 *  No-op when the definition carries nothing sensitive. The extension ROW must
 *  already exist — `extension_secrets.extension_id` is an FK to
 *  `extensions.name` (cascade-deletes with the extension). */
async function persistMcpSecret(extensionName: string, server: McpServerDefinition): Promise<void> {
  const map = mcpSecretMap(server);
  if (!map) return;
  await setSecret(extensionName, null, MCP_AUTH_SECRET_NAME, JSON.stringify(map));
}

/**
 * Rehydrate an MCP server definition's real transport auth from the
 * `extension_secrets` store — the inverse of {@link redactMcpServer}. Call this
 * on the server-side connect path (and the edit-merge path) where the live
 * credential is actually needed; NEVER on a response served to a client.
 *
 * The stored blob overlays the (blanked) manifest map, so keys present only in
 * the manifest survive as blanks and keys in the store win. Missing/corrupt
 * blob → the definition is returned unchanged.
 */
export async function rehydrateMcpServerSecrets(
  extensionName: string,
  server: McpServerDefinition,
): Promise<McpServerDefinition> {
  // Fetching the stored secret hits the secret store / DB. On a live
  // production connect the DB is always up; when it is NOT (unit tests that
  // construct a registry with no DB, or a transient outage) getSecret throws
  // "Database not initialized …". Degrade gracefully: skip rehydration and
  // return the passed (already value-blanked) definition rather than crash the
  // whole connect path. This is not a security relaxation — the redacted
  // manifest still carries no plaintext; a failed fetch just means no
  // rehydration this call. The happy path (real secret present) is unchanged.
  let stored: string | null;
  try {
    stored = await getSecret(extensionName, null, MCP_AUTH_SECRET_NAME);
  } catch (err) {
    backfillLog.debug("MCP secret rehydration skipped — secret store unavailable", {
      extension: extensionName,
      error: String(err).split("\n")[0],
    });
    return server;
  }
  if (!stored) return server;
  let map: Record<string, string>;
  try {
    map = JSON.parse(stored) as Record<string, string>;
  } catch {
    return server;
  }
  if (server.transport === "stdio") {
    return { ...server, env: { ...(server.env ?? {}), ...map } };
  }
  return { ...server, headers: { ...(server.headers ?? {}), ...map } };
}

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

/** True when an MCP definition still carries a NON-blank secret value at rest
 *  (a redacted definition keeps the keys but blanks the values). */
function hasPlaintextMcpSecret(server: McpServerDefinition): boolean {
  const map = server.transport === "stdio" ? server.env : server.headers;
  if (!map) return false;
  return Object.values(map).some((v) => typeof v === "string" && v.length > 0);
}

/**
 * db-audit (mcp-secrets): one-shot backfill for rows installed BEFORE MCP
 * transport auth moved to the encrypted store. New installs/updates already
 * redact-at-rest, and every read path scrubs legacy rows defensively, but the
 * plaintext still sits in `extensions.manifest` jsonb until migrated. This
 * moves each legacy secret into `extension_secrets` and rewrites the manifest
 * to its blanked form — idempotent (a blanked row has no plaintext, so a
 * re-run skips it) and fail-safe (a bad row warns by name and never bricks
 * boot). Mirrors `backfillGithubProjectsApiTokens`.
 */
export async function backfillMcpManifestSecrets(
  // Accepts the migrate `db` handle OR getDb(); both are drizzle instances.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor: any = getDb(),
): Promise<{ migrated: number; scanned: number }> {
  const rows = (await executor
    .select({ id: extensions.id, name: extensions.name, manifest: extensions.manifest })
    .from(extensions)) as Array<{ id: string; name: string; manifest: unknown }>;

  let migrated = 0;
  let scanned = 0;
  for (const row of rows) {
    const manifest = row.manifest as ExtensionManifestV2 | null;
    if (!manifest || manifest.kind !== "mcp" || !manifest.mcpServers?.length) continue;
    scanned += 1;
    const server = manifest.mcpServers[0];
    if (!server || !hasPlaintextMcpSecret(server)) continue;
    try {
      // Encrypt+store the real values FIRST, so a crash after this point leaves
      // the (still-plaintext) manifest recoverable on the next boot's re-run.
      await persistMcpSecret(row.name, server);
      const redacted: ExtensionManifestV2 = {
        ...manifest,
        mcpServers: manifest.mcpServers.map(redactMcpServer),
      };
      await executor
        .update(extensions)
        .set(serializeJsonbFields({ manifest: redacted }))
        .where(eq(extensions.id, row.id));
      migrated += 1;
    } catch (err) {
      // Never brick boot — name the extension (never the secret value).
      backfillLog.warn("legacy MCP manifest secret could not be migrated", {
        extension: row.name,
        error: String(err).split("\n")[0],
      });
    }
  }
  return { migrated, scanned };
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
  // Transport auth (headers/env) NEVER lands in the manifest at rest — persist
  // a value-blanked definition and move the real secret into extension_secrets
  // (below, after the row exists so its FK target is present).
  const manifest: ExtensionManifestV2 = {
    schemaVersion: 2,
    name: input.name,
    version: input.version ?? "0.0.0",
    description: input.description ?? "",
    author: { name: input.authorName ?? "local" },
    kind: "mcp",
    mcpServers: [redactMcpServer(input.server)],
    tools: input.cachedTools,
    permissions: {},
  };
  const created = await createExtension({
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
  await persistMcpSecret(created.name, input.server);
  return created;
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
    // Value-blanked at rest; the real headers/env are re-encrypted below.
    mcpServers: [redactMcpServer(input.server)],
    tools: input.cachedTools,
  };

  const updated = await updateExtension(input.id, {
    description: manifest.description,
    manifest,
    source: `mcp:${input.server.transport}`,
  });
  if (updated) await persistMcpSecret(existing.name, input.server);
  return updated;
}
