import { and, eq, or, sql, inArray } from "drizzle-orm";
import { getDb, getPglite } from "../connection";
import type { Database } from "../connection";
import { extensions, type Extension, type NewExtension } from "../schema";
import type {
  McpServerDefinition,
  ExtensionManifestV2,
  ExtensionPermissions,
  ToolDefinition,
} from "../../extensions/types";
import { getSecret, setSecret } from "../../extensions/secrets-store";
import {
  mcpInstallGrant,
  mcpManifestPermissions,
  normalizeMcpManifest,
  withMcpToolCapabilities,
} from "../../extensions/mcp-capabilities";
import {
  applyMcpSecretBlob,
  buildMcpSecretBlob,
  mcpServerHasPlaintextSecret,
  parseMcpSecretBlob,
  redactExtensionSecrets,
  redactMcpServer,
  serializeMcpSecretBlob,
} from "../../extensions/mcp-secret-redaction";
import { logger } from "../../logger";

const backfillLog = logger.child("db.queries.extensions");

// ── MCP credential isolation ──────────────────────────────────────────────
//
// An MCP server definition legitimately carries credentials in FOUR places:
// `headers` for http/sse (typically `Authorization` bearer tokens), `env` for
// stdio (API keys), the URL's query string (`?api_key=…`, a real MCP
// convention) and stdio argv (`--token=…`). Persisting any of those verbatim
// inside `manifest.mcpServers` leaked them: the row (manifest included) is
// served by GET /api/extensions and many other read-scope routes, so ANY
// authenticated member could exfiltrate the credential. This mirrors the exact
// hole the github-projects PAT backfill closed for the broadly-readable
// `settings` table.
//
// Fix (mirrors the github-projects precedent): the secret VALUES never touch
// the manifest at rest. On install/update we move them into the AAD-bound
// `extension_secrets` store keyed by the extension's stable slug (the FK
// target of `extension_secrets.extension_id`, global scope). The manifest we
// persist keeps only the secret KEYS/NAMES with blanked values — enough for
// the edit UI to show "which headers/parameters/flags exist" without exposing
// the secret. The real values are rehydrated on the server-side connect path
// via `rehydrateMcpServerSecrets`.
//
// WHICH bytes are a credential is decided in exactly one place —
// `../../extensions/mcp-secret-redaction.ts` — shared by the at-rest writer,
// the read-response scrubber, the rehydration guard, the boot backfill and the
// audit projection. Read that module's header before changing any of them.

/** Secret name for an MCP extension's credential blob (http/sse `headers`,
 *  stdio `env`, the URL query values and the argv values) in the
 *  `extension_secrets` store. One JSON blob per extension, GLOBAL scope
 *  (projectId/userId null) — MCP servers are admin-installed platform-wide,
 *  not per-project/per-user. */
const MCP_AUTH_SECRET_NAME = "mcp:auth";

// Re-exported so the many existing importers (routes, tests) keep one import
// path while the classifier itself lives beside the other MCP host logic. NEW
// call sites import `../../extensions/mcp-secret-redaction` directly — it is
// pure, so a route that does needs no DB module, and a route unit test can run
// the REAL redaction while it mocks every query away.
export { redactExtensionSecrets, redactMcpServer };

/** Encrypt + store an MCP extension's credentials in `extension_secrets`.
 *  No-op when the definition carries nothing sensitive. The extension ROW must
 *  already exist — `extension_secrets.extension_id` is an FK to
 *  `extensions.name` (cascade-deletes with the extension).
 *
 *  The write REPLACES the blob, which is what install/update need: an admin who
 *  removes a header key must not leave its value behind in the store. The
 *  backfill passes `mergeStored` because it sees the row's manifest, not the
 *  admin's input — a row healed of its `headers`/`env` by an earlier build has
 *  only blanks left there, so a replace would delete the auth map it cannot
 *  rebuild. */
async function persistMcpSecret(
  extensionName: string,
  server: McpServerDefinition,
  opts?: { mergeStored?: boolean },
): Promise<void> {
  const blob = buildMcpSecretBlob(server);
  if (!blob) return;
  let next = blob;
  if (opts?.mergeStored) {
    const stored = await getSecret(extensionName, null, MCP_AUTH_SECRET_NAME);
    const prior = stored === null ? null : parseMcpSecretBlob(stored);
    if (prior) next = { ...prior, ...blob };
  }
  await setSecret(extensionName, null, MCP_AUTH_SECRET_NAME, serializeMcpSecretBlob(next));
}

/**
 * Rehydrate an MCP server definition's real credentials from the
 * `extension_secrets` store — the inverse of {@link redactMcpServer}. Call this
 * on the server-side connect path (and the edit-merge path) where the live
 * credential is actually needed; NEVER on a response served to a client.
 *
 * The stored `auth` map overlays the (blanked) manifest map, so keys present
 * only in the manifest survive as blanks and keys in the store win. The URL /
 * command / argv substitutions are each guarded by `applyMcpSecretBlob` —
 * a stored value is used only when redacting it reproduces what is at rest.
 * Missing/corrupt blob → the definition is returned unchanged.
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
  const blob = parseMcpSecretBlob(stored);
  if (!blob) return server;
  return applyMcpSecretBlob(server, blob);
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
export function serializeJsonbFields<T extends Record<string, unknown>>(data: T): T {
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

/**
 * db-audit (mcp-secrets): one-shot backfill for rows installed BEFORE MCP
 * credentials moved to the encrypted store. New installs/updates already
 * redact-at-rest, and every read path scrubs legacy rows defensively, but the
 * plaintext still sits in `extensions.manifest` jsonb until migrated. This
 * moves each legacy secret into `extension_secrets` and rewrites the manifest
 * to its blanked form — idempotent (`mcpServerHasPlaintextSecret` is literally
 * "would redacting this change anything", so a migrated row is skipped and no
 * second definition of "already clean" can drift from the redactor) and
 * fail-safe (a bad row warns by name and never bricks boot). Mirrors
 * `backfillGithubProjectsApiTokens`.
 *
 * Issue #205 widened what it migrates: a row whose URL query or argv carries a
 * credential is now in scope, so a row already healed of its `headers`/`env`
 * by an earlier build is picked up again for its `url`/`args`. That re-run is
 * safe — `setSecret` overwrites the blob with one built from the row's own
 * current plaintext, which still contains the auth map.
 */
export async function backfillMcpManifestSecrets(
  // Accepts the migrate `db` handle OR getDb(); both are drizzle instances,
  // and `Database` is the shared alias for exactly that (../connection.ts).
  executor: Database = getDb(),
): Promise<{ migrated: number; scanned: number }> {
  const rows = (await executor
    .select({ id: extensions.id, name: extensions.name, manifest: extensions.manifest })
    .from(extensions)) as Array<{ id: string; name: string; manifest: unknown }>;

  let migrated = 0;
  let scanned = 0;
  for (const row of rows) {
    const manifest = row.manifest as ExtensionManifestV2 | null;
    if (manifest?.kind !== "mcp" || !manifest.mcpServers?.length) continue;
    scanned += 1;
    const server = manifest.mcpServers[0];
    if (!server || !mcpServerHasPlaintextSecret(server)) continue;
    try {
      // Encrypt+store the real values FIRST, so a crash after this point leaves
      // the (still-plaintext) manifest recoverable on the next boot's re-run.
      await persistMcpSecret(row.name, server, { mergeStored: true });
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
 * Resolve a `/extensions/<ref>` REFERENCE to its row. `ref` is either the
 * extension id (the library's link shape, `+page.svelte`) OR the manifest
 * name — the shape `installAuthoredDraft` mints for both the author page's
 * `redirectUrl` and the `install_draft` card's "Open extension" button. Id
 * lookup alone made that post-install deep-link render "Extension not found".
 *
 * Ambiguity is REAL, not theoretical: a manifest name only has to satisfy
 * `^[a-z0-9][a-z0-9-_.]{0,63}$`, which a `crypto.randomUUID()` string
 * satisfies — so a later install can name itself byte-identically to an
 * existing row's id and an `or(...)` match returns TWO rows. Id ALWAYS wins,
 * so an installed extension can never be shadowed at its own URL by a
 * squatting name. Both columns are UNIQUE, so the id branch resolves at most
 * one row and the name branch at most one.
 *
 * Read-only and parameterized (drizzle `eq`) — `ref` is user-controlled but
 * never interpolated, and names are already enumerable via `GET /api/extensions`,
 * so this widens no read surface. Destructive/admin handlers (PATCH/DELETE)
 * deliberately keep using `getExtension` — a destructive op should key on the
 * primary key only, never on a user-chosen name that could collide with an id.
 */
export async function getExtensionByRef(ref: string): Promise<Extension | null> {
  if (!ref) return null;
  const rows = (await getDb()
    .select()
    .from(extensions)
    .where(or(eq(extensions.id, ref), eq(extensions.name, ref)))) as Extension[];
  return rows.find((r) => r.id === ref) ?? rows[0] ?? null;
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
  const rows = (await getDb()
    .select()
    .from(extensions)
    .where(
      and(
        or(eq(extensions.id, nameOrId), eq(extensions.name, nameOrId)),
        eq(extensions.creatorUserId, userId),
        eq(extensions.modifiable, true),
        eq(extensions.isBundled, false),
      ),
    )) as Extension[];
  // Same id-wins tiebreak as `getExtensionByRef`, and for the same reason:
  // a manifest name only has to match /^[a-z0-9][a-z0-9-_.]{0,63}$/, which a
  // `crypto.randomUUID()` string satisfies, so `or(id, name)` can match two
  // rows. Narrower here (both must be owned by the caller, modifiable and
  // non-bundled) but the consequence is worse — this feeds `modify_extension`,
  // so picking the wrong row reopens and re-installs over the wrong extension.
  return rows.find((r) => r.id === nameOrId) ?? rows[0] ?? null;
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
 *
 * The synthesized manifest DECLARES the hosts the server definition names
 * (`mcpManifestPermissions`) and stamps that declaration onto every cached
 * tool (`withMcpToolCapabilities`). Both matter:
 *
 *   • the per-tool declaration is what the PDP turns into the needed-cap set
 *     at dispatch (`tool-executor/executor.ts`); without it every MCP tool
 *     call authorized against an EMPTY needed set and was allowed
 *     unconditionally;
 *   • the manifest-level declaration is the CEILING
 *     `clampExtensionPermissions` intersects an admin's submitted grant
 *     against, so without it no `network` host could ever be granted — and
 *     `mcp-proxy.ts` re-authorizes every stdio CONNECT against exactly that
 *     grant.
 *
 * The install-time grant is recorded as BOTH `grantedPermissions` and
 * `installedPermissions`, the same pairing `activateExtension` writes, so the
 * reapprove flow clamps against the consent collected here.
 */
export async function installMcpExtension(input: {
  name: string;
  description?: string;
  version?: string;
  authorName?: string;
  server: McpServerDefinition;
  cachedTools: ToolDefinition[];
  /** Admin who installed the row. Optional so existing callers are
   *  unaffected; the install route threads the acting user through so the
   *  audit trail and the owner-scoped surfaces have a subject. */
  creatorUserId?: string | null;
}): Promise<Extension> {
  // Transport auth (headers/env) NEVER lands in the manifest at rest — persist
  // a value-blanked definition and move the real secret into extension_secrets
  // (below, after the row exists so its FK target is present).
  const permissions = mcpManifestPermissions(input.server);
  const manifest: ExtensionManifestV2 = {
    schemaVersion: 2,
    name: input.name,
    version: input.version ?? "0.0.0",
    description: input.description ?? "",
    author: { name: input.authorName ?? "local" },
    kind: "mcp",
    mcpServers: [redactMcpServer(input.server)],
    tools: withMcpToolCapabilities(input.cachedTools, permissions),
    permissions,
  };
  const granted = mcpInstallGrant(input.server);
  const created = await createExtension({
    name: input.name,
    version: manifest.version,
    description: manifest.description,
    manifest,
    source: `mcp:${input.server.transport}`,
    installPath: null,
    enabled: true,
    grantedPermissions: granted,
    installedPermissions: granted,
    creatorUserId: input.creatorUserId ?? null,
    checksumVerified: false,
    consecutiveFailures: 0,
  } as NewExtension);
  await persistMcpSecret(created.name, input.server);
  return created;
}

/**
 * Re-point an existing MCP extension at a new server config and refresh its
 * cached tool list (edit-after-install). Preserves the extension's identity
 * (name, version, author) — the connection (`mcpServers`), the `tools`
 * snapshot, the optional `description`, the `source` slug and the derived
 * network CEILING change. Returns the updated extension, or `null` if the id
 * is missing or the extension is not an MCP extension.
 *
 * The caller is responsible for having already verified connectivity +
 * pulled `cachedTools` from the *new* config (the install path does the same
 * with a throwaway client) and for reloading the registry afterwards.
 *
 * Grant handling: the GRANT is re-issued ONLY when the derived ceiling
 * actually changed (the admin re-pointed the server at a different host, or
 * the row is a legacy one that declared no ceiling at all). That edit is an
 * admin-gated, connectivity-verified re-confirmation of the connection, so
 * treating it as install-equivalent consent is consistent with
 * `installMcpExtension`. A description-only edit leaves the grant alone,
 * which is what preserves a deliberate admin revocation.
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

  const permissions = mcpManifestPermissions(input.server);
  const manifest: ExtensionManifestV2 = {
    ...prevManifest,
    description: input.description ?? prevManifest.description,
    // Value-blanked at rest; the real headers/env are re-encrypted below.
    mcpServers: [redactMcpServer(input.server)],
    tools: withMcpToolCapabilities(input.cachedTools, permissions),
    permissions,
  };

  const ceilingChanged =
    JSON.stringify(prevManifest.permissions?.network ?? null) !==
    JSON.stringify(permissions.network);
  const regrant = ceilingChanged ? mcpInstallGrant(input.server) : null;

  const updated = await updateExtension(input.id, {
    description: manifest.description,
    manifest,
    source: `mcp:${input.server.transport}`,
    ...(regrant !== null
      ? { grantedPermissions: regrant, installedPermissions: regrant }
      : {}),
  });
  if (updated) await persistMcpSecret(existing.name, input.server);
  return updated;
}

/**
 * db-audit (mcp-capabilities): one-shot backfill for MCP rows installed
 * BEFORE the manifest declared what the server reaches.
 *
 * Those rows carry `permissions: {}` and tools with no `capabilities`, which
 * made the PDP inert for every one of their tool calls and made their
 * `network` grant unreachable through the manifest-bounded clamp. The
 * registry normalizes on read so a stale row is never *enforced* wrongly, but
 * the row at rest still drives surfaces that read the DB directly — the
 * extension detail page renders its network checkbox row from
 * `ext.manifest.permissions.network`, and the reapprove flow clamps against
 * `installed_permissions`.
 *
 * This writes the derived ceiling into the manifest and issues the matching
 * grant.
 *
 * ── WHAT THIS WIDENS (read before deciding the migration is safe) ──────
 *
 * The DECLARED config is unchanged — every host comes from the row's own
 * stored server definition. ENFORCED behaviour is NOT unchanged, and the
 * difference matters:
 *
 *   • stdio egress WIDENS. `mcp-proxy.ts` re-authorizes every CONNECT against
 *     `grantedPermissions`, which was `{grantedAt:{}}` for a legacy row — so
 *     ALL stdio egress was denied. After this backfill, a server started as
 *     `npx -y mcp-remote https://c.example.com/mcp` can reach
 *     `c.example.com`. That is the intended repair, not an accident: the
 *     admin typed that host into the command line, and pre-PR the deny was a
 *     DEAD END — the manifest declared no ceiling, so the clamp dropped every
 *     submitted host and no admin action could ever allow it. The grant is
 *     recorded in `installedPermissions` and revocable from the existing
 *     permissions surface.
 *   • DISPATCH tightens. Legacy MCP tools authorized against an empty needed
 *     set and were allowed unconditionally; they now require the `mcpInvoke`
 *     sentinel (and any declared host), which this backfill grants. Leaving
 *     the grant empty would brick every legacy MCP tool on the first boot
 *     after this change.
 *
 * Net: one capability the operator had already configured becomes reachable,
 * and one that was ungoverned becomes revocable.
 *
 * Idempotent (a row that already declares its ceiling is skipped) and
 * fail-safe (a bad row warns by name and never bricks boot). A row this pass
 * MISSES — breaker-open boot, or an UPDATE that threw — fails CLOSED at
 * dispatch and is reported by `registry.loadFromDb`; see the note there.
 * Mirrors `backfillMcpManifestSecrets`, which runs beside it in `migrate.ts`.
 */
export async function backfillMcpManifestCapabilities(
  executor: Database = getDb(),
): Promise<{ migrated: number; scanned: number }> {
  // DELIBERATE FULL SCAN — do not add `WHERE manifest->>'kind' = 'mcp'`.
  //
  // It looks free (measured: ~70 ms at 300 rows, all of it inside
  // `withPostgresMigrateLock`) and it is symmetric with the JS filter below,
  // which also requires `kind === "mcp"`. It is still wrong, because of
  // ORDERING on external Postgres:
  //
  //   `initDb` runs `withPostgresMigrateLock(() => migrate(_db))` and only
  //   THEN `repairDoubleEncodedJsonb` (`db/connection.ts`). So while this
  //   backfill runs, a row written before the jsonb double-encoding fix is
  //   still a jsonb STRING scalar, and `manifest->>'kind'` on a scalar is
  //   NULL — verified against PGlite:
  //     jsonb_typeof → "string", manifest->>'kind' → null,
  //     so `WHERE manifest->>'kind' = 'mcp'` returns that row's id NOT AT ALL.
  //   Drizzle still parses the value back into an object for the JS filter,
  //   so the predicate would skip precisely the corrupted legacy rows that
  //   most need healing — and only on external Postgres, where it is hardest
  //   to notice. They would self-heal on the SECOND boot (after the repair),
  //   leaving one boot in which every MCP tool call denies.
  //
  // The same argument applies to `backfillMcpManifestSecrets` above; both
  // scan, and they stay symmetric.
  const rows = (await executor
    .select({
      id: extensions.id,
      name: extensions.name,
      manifest: extensions.manifest,
      grantedPermissions: extensions.grantedPermissions,
      installedPermissions: extensions.installedPermissions,
    })
    .from(extensions)) as Array<{
    id: string;
    name: string;
    manifest: unknown;
    grantedPermissions: ExtensionPermissions | null;
    installedPermissions: ExtensionPermissions | null;
  }>;

  let migrated = 0;
  let scanned = 0;
  for (const row of rows) {
    const manifest = row.manifest as ExtensionManifestV2 | null;
    if (manifest?.kind !== "mcp" || !manifest.mcpServers?.length) continue;
    scanned += 1;
    // Already declared — nothing to heal. Keeps the pass idempotent across
    // reboots and leaves a hand-narrowed ceiling untouched. Both keys are
    // checked because a row healed by an earlier build declares `network` but
    // not the sentinel.
    // Single-line condition on purpose: a multi-line `if (...)` leaves a
    // `) {` continuation line that bun's sourcemap fills with a phantom,
    // never-hit DA record the patch-coverage gate cannot clear.
    const declared = manifest.permissions ?? {};
    if (declared.network !== undefined && declared.mcpInvoke !== undefined) continue;
    try {
      const normalized = normalizeMcpManifest(manifest);
      const hosts = normalized.permissions.network ?? [];
      const prior = row.grantedPermissions ?? { grantedAt: {} };
      const now = Date.now();
      // Merge rather than replace: a per-conversation narrowing or a future
      // field must not be dropped by a backfill that only knows about these
      // two keys. The sentinel is granted for EVERY healed row — it is the
      // capability a hostless stdio server's revocation rides on, so a row
      // that gets only `network` would still dispatch ungated.
      const granted: ExtensionPermissions = {
        ...prior,
        mcpInvoke: true,
        ...(hosts.length > 0 ? { network: hosts } : {}),
        grantedAt: {
          ...prior.grantedAt,
          mcpInvoke: now,
          ...(hosts.length > 0 ? { network: now } : {}),
        },
      };
      await executor
        .update(extensions)
        .set(
          serializeJsonbFields({
            manifest: normalized,
            grantedPermissions: granted,
            installedPermissions: row.installedPermissions ?? granted,
          }),
        )
        .where(eq(extensions.id, row.id));
      migrated += 1;
    } catch (err) {
      // Never brick boot — name the extension, never the server definition.
      backfillLog.warn("legacy MCP manifest capabilities could not be derived", {
        extension: row.name,
        error: String(err).split("\n")[0],
      });
    }
  }
  return { migrated, scanned };
}
