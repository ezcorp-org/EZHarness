/**
 * v1.3 release-readiness — server-side extension-row fixture for integration
 * tests.
 *
 * Mirrors the seeding pattern from `perm-expiry-sweep.integration.test.ts`'s
 * private `seedExtension()` helper (the connection-layer identity-jsonb
 * mapper trick — `sql\`${JSON.stringify(...)}::jsonb\`` — so the jsonb
 * column lands as proper jsonb, not a stringified JSON literal), but
 * exposed as a shared utility plus a thin wrapper that returns the row
 * id alongside small affordance helpers (`forceExpire`, `getGrants`,
 * `clear`) the cap-expiry + reapprove tests need.
 *
 * Callers must:
 *   1. `mockDbConnection()` at module top (so `getDb()` returns the test PGlite).
 *   2. `await setupTestDb()` in a `beforeAll`/`beforeEach` hook.
 *   3. Drive any cross-row deletions in their own `beforeEach` (this helper
 *      does NOT wipe the table — that's the caller's contract).
 */

import { sql, eq } from "drizzle-orm";
import { extensions } from "../../db/schema";
import { getDb } from "../../db/connection";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
} from "../../extensions/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TestExtensionInput {
  id: string;
  name: string;
  /**
   * Full manifest. If `manifest.permissions` is omitted, the row's
   * `grantedPermissions` falls back to {} (matches the schema default).
   * Setting `manifest.acceptsCallerCaps: true` opts the extension OUT of
   * the cross-ext intersection-by-default (HIGH 3 flip).
   */
  manifest?: Partial<ExtensionManifestV2>;
  /**
   * The CURRENT effective grant. Defaults to `{ grantedAt: {} }` (no
   * grants). Pass a populated shape with a stale `grantedAt[<cap>]` to
   * simulate a post-sweep "expired" state.
   */
  grantedPermissions?: ExtensionPermissions;
  /**
   * The user's install-time NARROWED choice. `null` (default) = legacy
   * row, reapprove falls back to clamping against the manifest. Non-null
   * = HIGH 2 column populated, reapprove restores this exact set.
   */
  installedPermissions?: ExtensionPermissions | null;
  /** Bundled extensions get a second-stage clamp against `BUNDLED_CEILING`. */
  isBundled?: boolean;
  enabled?: boolean;
}

export interface TestExtensionRow {
  id: string;
  /** Force-expire a capability — sets `grantedAt[<capability>]` to 91d ago. */
  forceExpire(capability: string): Promise<void>;
  /** Read back the current `grantedPermissions` snapshot. */
  getGrants(): Promise<ExtensionPermissions | null>;
  /** Read back the row's `installedPermissions` column (HIGH 2). */
  getInstalled(): Promise<ExtensionPermissions | null>;
  /** Cascade-delete the row (caller-driven cleanup; helper is no-op-friendly). */
  clear(): Promise<void>;
}

/**
 * Insert a synthetic extension row + return affordance helpers.
 *
 * Idempotent on `clear()` — the `extensions.id` PK is honored, and the
 * downstream FK cascades (`tool_calls`, `extension_storage`, ...) drop
 * dependents on delete. Callers that share an id across tests should
 * call `clear()` in `afterEach` (or wipe the whole table via raw SQL
 * before insert — both patterns work).
 */
export async function makeTestExtension(
  input: TestExtensionInput,
): Promise<TestExtensionRow> {
  const db = getDb();

  const manifest: ExtensionManifestV2 = {
    schemaVersion: 3,
    name: input.name,
    version: "1.0.0",
    description: "test fixture",
    author: { name: "tester" },
    entrypoint: "./index.ts",
    tools: [],
    permissions: {},
    ...((input.manifest ?? {}) as Partial<ExtensionManifestV2>),
  };

  const grantedPermissions: ExtensionPermissions = input.grantedPermissions ?? {
    grantedAt: {},
  };

  // jsonb columns: mirror the connection-layer identity-jsonb trick so
  // values land as proper jsonb (not a stringified JSON literal). The
  // existing `perm-expiry-sweep.integration.test.ts:118` uses the same
  // sql template; we copy it verbatim so behavior is identical.
  await db.insert(extensions).values({
    id: input.id,
    name: input.name,
    version: manifest.version ?? "1.0.0",
    description: manifest.description ?? "",
    manifest: sql`${JSON.stringify(manifest)}::jsonb`,
    source: "test:fixture",
    installPath: null,
    enabled: input.enabled ?? true,
    grantedPermissions: sql`${JSON.stringify(grantedPermissions)}::jsonb`,
    installedPermissions:
      input.installedPermissions === undefined ||
      input.installedPermissions === null
        ? null
        : (sql`${JSON.stringify(input.installedPermissions)}::jsonb` as unknown as ExtensionPermissions),
    checksumVerified: false,
    isBundled: input.isBundled ?? false,
    consecutiveFailures: 0,
  });

  return {
    id: input.id,
    async forceExpire(capability: string): Promise<void> {
      const rows = await db
        .select()
        .from(extensions)
        .where(eq(extensions.id, input.id));
      const row = rows[0];
      if (!row) throw new Error(`Extension ${input.id} not found`);
      const current = (row.grantedPermissions ?? {}) as ExtensionPermissions;
      const nextGrantedAt: Record<string, number> = {
        ...(current.grantedAt ?? {}),
        [capability]: Date.now() - 91 * DAY_MS,
      };
      const next: ExtensionPermissions = {
        ...current,
        grantedAt: nextGrantedAt,
      };
      await db
        .update(extensions)
        .set({
          grantedPermissions: sql`${JSON.stringify(next)}::jsonb` as unknown as ExtensionPermissions,
        })
        .where(eq(extensions.id, input.id));
    },
    async getGrants(): Promise<ExtensionPermissions | null> {
      const rows = await db
        .select()
        .from(extensions)
        .where(eq(extensions.id, input.id));
      return (rows[0]?.grantedPermissions ?? null) as ExtensionPermissions | null;
    },
    async getInstalled(): Promise<ExtensionPermissions | null> {
      const rows = await db
        .select()
        .from(extensions)
        .where(eq(extensions.id, input.id));
      return (rows[0]?.installedPermissions ?? null) as ExtensionPermissions | null;
    },
    async clear(): Promise<void> {
      await db.delete(extensions).where(eq(extensions.id, input.id));
    },
  };
}
