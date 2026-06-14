/**
 * Admin drift re-approval for bundled extensions.
 *
 * The S6/S9 boot gate in `bundled.ts` disables a NON-critical bundled
 * extension whose on-disk manifest permissions changed in a release
 * ("pending re-approval") — fail-closed by design. Before this module
 * existed there was no sanctioned exit from that state:
 *
 *   - `POST /api/extensions/[id]/reapprove` re-grants from the STORED
 *     manifest (stale by definition when the gate fired), and
 *   - `PUT /api/extensions/[id]/permissions` clamps to that same stale
 *     stored manifest,
 *
 * so a legitimately-widened bundled extension (the web-search
 * zero-setup rollout was the trigger) stayed disabled on every deploy.
 *
 * `reapproveBundledDrift` is the sanctioned heal: it re-grants from the
 * CURRENT ON-DISK manifest (the same loader the boot path uses),
 * clamped to the bundled ceiling (`bundled-ceiling.ts` stays the hard
 * security bound), refreshes the stored manifest + version, and
 * re-enables the row — exactly what makes the next boot's S6/S9 checks
 * pass (db manifest == disk manifest, version equal, tool hash equal).
 *
 * Security invariants (do not relax):
 *   - The grant is `clampToBundledCeiling(name, diskPerms)` — provably
 *     ⊆ ceiling regardless of what the disk manifest declares.
 *   - The lockfile gate still applies: a disk manifest that fails
 *     `verifyManifestAgainstLock` is REFUSED, row untouched. This
 *     endpoint heals GRANT drift, not tampering.
 *   - Idempotent / no-op safe: with no drift it simply refreshes and
 *     re-enables; it can never widen beyond the ceiling.
 *
 * The web route at
 * `web/src/routes/api/extensions/[id]/reapprove-drift/+server.ts` is
 * the (admin-only) HTTP surface; this module is the testable core.
 */

import { join } from "node:path";
import type { ExtensionManifestV2, ExtensionPermissions } from "./types";
import { updateExtension } from "../db/queries/extensions";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "./audit-actions";
import { clampToBundledCeiling } from "./bundled-ceiling";
import { verifyManifestAgainstLock } from "./bundled-lock";
import { loadManifestFresh } from "./loader";
import { getBundledExtensionPath, getProjectRoot } from "./bundled";
import { logger } from "../logger";

const log = logger.child("bundled-drift-reapprove");

/** One granted-permission field that changed — mirrors the
 *  `{field, oldValue, newValue}` diff shape the S9 boot gate writes to
 *  `UPDATE_BLOCKED` audit rows (`detectVersionBumpRequiringReapproval`),
 *  so the admin UI can render both with the same component. */
export interface DriftReapproveDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/** Minimal row shape the heal needs — structural so callers can pass a
 *  full drizzle `Extension` row or a test fixture. */
export interface BundledExtensionRowLike {
  id: string;
  name: string;
  version?: string | null;
  manifest?: unknown;
  grantedPermissions?: unknown;
}

export type DriftReapproveResult =
  | { ok: true; updated: unknown; diffs: DriftReapproveDiff[] }
  | {
      ok: false;
      code: "not-bundled" | "not-found" | "manifest-unreadable" | "lockfile-mismatch";
      message: string;
    };

/**
 * Structural diff of two grant shapes over the union of their permission
 * fields (excluding `grantedAt` — timestamps refresh on every
 * re-approval and would make the no-drift case look like a change).
 */
function diffGrants(
  oldGrant: ExtensionPermissions,
  newGrant: ExtensionPermissions,
): DriftReapproveDiff[] {
  const a = oldGrant as unknown as Record<string, unknown>;
  const b = newGrant as unknown as Record<string, unknown>;
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  fields.delete("grantedAt");
  const diffs: DriftReapproveDiff[] = [];
  for (const field of [...fields].sort()) {
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
      diffs.push({ field, oldValue: a[field], newValue: b[field] });
    }
  }
  return diffs;
}

/**
 * Re-approve a bundled extension's permission drift from its current
 * on-disk manifest. See the module doc for the full contract.
 *
 * Atomic: one `updateExtension` call writes grant + manifest + version
 * + enabled together (single UPDATE), so a crash can never leave the
 * row half-healed.
 */
export async function reapproveBundledDrift(
  ext: BundledExtensionRowLike,
  actorUserId: string,
): Promise<DriftReapproveResult> {
  const bundledPath = getBundledExtensionPath(ext.name);
  if (!bundledPath) {
    return {
      ok: false,
      code: "not-bundled",
      message: `'${ext.name}' is not a bundled extension — drift re-approval only applies to bundled extensions`,
    };
  }

  // Same loader the boot path uses — the on-disk manifest is the
  // source of truth for bundled extensions.
  let diskManifest: ExtensionManifestV2;
  try {
    diskManifest = await loadManifestFresh(join(getProjectRoot(), bundledPath));
  } catch (e) {
    return {
      ok: false,
      code: "manifest-unreadable",
      message: `Could not load on-disk manifest for '${ext.name}': ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Lockfile gate — reuse the boot path's verification helper. A
  // mismatch means either a maintainer forgot to regenerate
  // manifest.lock.json or the file was tampered with; either way this
  // endpoint refuses (it heals grant drift, not tampering).
  const lockResult = await verifyManifestAgainstLock(ext.name, diskManifest);
  if (!lockResult.ok) {
    log.warn("Drift re-approval refused — manifest fails lockfile check", {
      name: ext.name,
      extensionId: ext.id,
      reason: lockResult.reason,
      expected: lockResult.expected,
      actual: lockResult.actual,
    });
    return {
      ok: false,
      code: "lockfile-mismatch",
      message: `On-disk manifest for '${ext.name}' fails the manifest.lock.json check (${lockResult.reason}) — refusing to re-grant. Regenerate the lockfile if this is a legitimate release, or investigate tampering.`,
    };
  }

  // Build the requested grant from the DISK manifest's declared
  // permissions with fresh grantedAt stamps (the admin is re-consenting
  // to the whole set now — mirrors the fresh-install grant shape).
  // `intersectPermissions` (via clampToBundledCeiling) only retains
  // grantedAt keys whose permission survived the intersection.
  const rawPerms = (diskManifest.permissions ?? {}) as ExtensionPermissions;
  const now = Date.now();
  const stampedGrantedAt: Record<string, number> = {};
  for (const key of Object.keys(rawPerms)) {
    if (key !== "grantedAt") stampedGrantedAt[key] = now;
  }
  const requested: ExtensionPermissions = { ...rawPerms, grantedAt: stampedGrantedAt };

  // Ceiling clamp — the hard security bound. A disk manifest declaring
  // anything beyond `bundled-ceiling.ts` gets that excess silently
  // dropped (the ceiling table is the code-review-time artifact a
  // compromised manifest cannot self-match).
  const { effective: clamped, clamped: wasClamped } = clampToBundledCeiling(
    ext.name,
    requested,
  );

  const priorGrant = (ext.grantedPermissions ?? { grantedAt: {} }) as ExtensionPermissions;
  const diffs = diffGrants(priorGrant, clamped);

  const oldVersion =
    ext.version ?? (ext.manifest as ExtensionManifestV2 | undefined)?.version;

  const updated = await updateExtension(ext.id, {
    grantedPermissions: clamped,
    manifest: diskManifest,
    version: diskManifest.version,
    // Sync the denormalized description column from disk too. The UI +
    // extension list read the top-level `description` column, NOT the
    // manifest jsonb — without this, a re-approval that pulls a new
    // on-disk description leaves the row showing the old one forever
    // (same denormalization gap fixed in the boot-refresh path).
    description: diskManifest.description ?? "",
    enabled: true,
  });
  if (!updated) {
    return {
      ok: false,
      code: "not-found",
      message: `Extension '${ext.id}' no longer exists`,
    };
  }

  log.info("Bundled extension drift re-approved by admin", {
    name: ext.name,
    extensionId: ext.id,
    actor: actorUserId,
    oldVersion,
    newVersion: diskManifest.version,
    ceilingClamped: wasClamped,
    diffs,
  });

  // Deliberate admin consent event → audit trail. Written even when
  // diffs are empty (a no-drift refresh/re-enable is still an explicit
  // admin action worth a forensic row).
  try {
    const meta: ExtensionAuditMetadata = {
      permission: "drift-reapprove",
      oldValue: priorGrant,
      newValue: clamped,
      actor: actorUserId,
      extensionName: ext.name,
      reason:
        `drift-reapproved: admin re-granted from the on-disk manifest ` +
        `(${oldVersion ?? "?"} → ${diskManifest.version}); grant clamped to the bundled ceiling`,
      diffs,
      ceilingClamped: wasClamped,
    };
    await insertAuditEntry(
      actorUserId,
      EXT_AUDIT_ACTIONS.BUNDLED_DRIFT_REAPPROVED,
      ext.id,
      meta,
    );
  } catch {
    /* audit write failure is non-fatal — the info log is the primary signal */
  }

  return { ok: true, updated, diffs };
}
