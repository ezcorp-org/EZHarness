import { getDb } from "../connection";
import { conversationExtensions } from "../schema";
import { and, eq } from "drizzle-orm";
import { ExtensionRegistry } from "../../extensions/registry";
import { primeConversationOverrideCache } from "../../extensions/permission-engine";
import type { ExtensionPermissions } from "../../extensions/types";

export async function getConversationExtensionIds(conversationId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ extensionId: conversationExtensions.extensionId })
    .from(conversationExtensions)
    .where(eq(conversationExtensions.conversationId, conversationId));
  return rows.map((r: { extensionId: string }) => r.extensionId);
}

/**
 * Phase 4: read the per-conversation effective grant override (if set)
 * for a given (conversation, extension) pair. Returns `null` when no
 * override exists — callers should fall back to the extension's
 * `grantedPermissions` blob.
 *
 * The spawn-assignment handler writes here so a sub-conversation's PDP
 * sees the intersected (parent ∩ child-agent) grants instead of the
 * extension's full installed grants.
 */
export async function getConversationExtensionEffectiveGrants(
  conversationId: string,
  extensionId: string,
): Promise<ExtensionPermissions | null> {
  const rows = await getDb()
    .select({
      effective: conversationExtensions.effectiveGrantedPermissions,
    })
    .from(conversationExtensions)
    .where(
      and(
        eq(conversationExtensions.conversationId, conversationId),
        eq(conversationExtensions.extensionId, extensionId),
      ),
    );
  return rows[0]?.effective ?? null;
}

/**
 * Phase 4 §M7 — return the effective grants the PDP sees for an
 * extension within a given conversation:
 *   1. Per-conversation override on `conversation_extensions`
 *      (written by spawn-assignment when it clipped the parent's
 *      grants by intersecting with the child agent config's manifest).
 *   2. Registry-installed grants (fallback when no override exists).
 *
 * Used by `handleSpawnAssignmentRpc` when computing a CHILD spawn's
 * effective grants: nested spawns must read the parent conversation's
 * already-clipped grants, NOT the extension's full installed grants —
 * otherwise cap inheritance silently widens at every spawn level.
 *
 * The caller passes `registryGrants` so this helper stays testable
 * without a registry singleton; production callers fetch it via
 * `registry.getGrantedPermissions(extensionId)`.
 */
export async function getEffectiveGrantsForConversation(
  conversationId: string,
  extensionId: string,
  registryGrants: ExtensionPermissions | null,
): Promise<ExtensionPermissions> {
  const override = await getConversationExtensionEffectiveGrants(
    conversationId,
    extensionId,
  );
  if (override) return override;
  return registryGrants ?? { grantedAt: {} };
}

export async function addConversationExtensions(
  conversationId: string,
  entries: { extensionId: string; messageId?: string; effectiveGrantedPermissions?: ExtensionPermissions }[],
): Promise<void> {
  if (entries.length === 0) return;
  const db = getDb();
  await db.insert(conversationExtensions)
    .values(entries.map(e => ({
      conversationId,
      extensionId: e.extensionId,
      addedByMessageId: e.messageId,
      ...(e.effectiveGrantedPermissions !== undefined
        ? { effectiveGrantedPermissions: e.effectiveGrantedPermissions }
        : {}),
    })))
    .onConflictDoNothing();
  // Phase 54 SEC-01 — prime the override cache for entries that
  // declare an `effectiveGrantedPermissions`. The PDP's
  // `loadConversationOverride` reads from this cache before the DB
  // query, absorbing PGlite warm-up lag at boot. Auto-wire entries
  // (no override) deliberately skip this — the registry fallback at
  // null is correct for them and the cache stays bounded by
  // (active conversations × extensions with overrides).
  for (const e of entries) {
    if (e.effectiveGrantedPermissions !== undefined) {
      primeConversationOverrideCache(conversationId, e.extensionId, e.effectiveGrantedPermissions);
    }
  }
}

/**
 * Copy the `conversation_extensions` rows from one conversation to
 * another. Used by Phase 2d's `ezcorp/spawn-assignment` so a freshly
 * created sub-conversation inherits the parent's extension set — the
 * spawning extension (and its wired siblings) are automatically
 * observable on the child with no per-spawn opt-in. Idempotent via
 * the existing UNIQUE(conversation_id, extension_id) constraint.
 */
export async function copyConversationExtensions(
  fromConversationId: string,
  toConversationId: string,
): Promise<void> {
  const ids = await getConversationExtensionIds(fromConversationId);
  if (ids.length === 0) return;
  await addConversationExtensions(
    toConversationId,
    ids.map((extensionId) => ({ extensionId })),
  );
}

/**
 * Union of `acceptedAttachmentMimes` across every extension wired into
 * the conversation. Used by the upload route + `/api/models/capabilities`
 * to extend the file picker's allowlist with extension-declared MIMEs.
 *
 * Extensions that aren't loaded into the in-memory registry (e.g. just
 * inserted but the registry hasn't reloaded yet) contribute nothing —
 * they'll start contributing on the next registry reload.
 */
export async function getConversationExtensionMimes(
  conversationId: string,
): Promise<string[]> {
  const ids = await getConversationExtensionIds(conversationId);
  if (ids.length === 0) return [];
  const reg = ExtensionRegistry.getInstance();
  const out = new Set<string>();
  for (const id of ids) {
    const manifest = reg.getManifest(id);
    if (!manifest?.acceptedAttachmentMimes) continue;
    for (const m of manifest.acceptedAttachmentMimes) out.add(m);
  }
  return [...out];
}

/**
 * Like {@link getConversationExtensionMimes} but keyed by extension names
 * — used by the chat composer to grant accept-list slots to extensions
 * the user has *drafted* via `!ext:NAME` mentions but not yet sent (and
 * therefore not yet inserted into `conversation_extensions`). Without
 * this, dragging an .xlsx into a fresh chat that mentions `!ext:excel`
 * would be rejected because the registry sees no wired extensions.
 */
export function getExtensionMimesByNames(names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const unique = [...new Set(names.filter((n) => typeof n === "string" && n.length > 0))];
  if (unique.length === 0) return [];
  const reg = ExtensionRegistry.getInstance();
  const out = new Set<string>();
  for (const name of unique) {
    const manifest = reg.getManifestByName(name);
    if (!manifest?.acceptedAttachmentMimes) continue;
    for (const m of manifest.acceptedAttachmentMimes) out.add(m);
  }
  return [...out];
}
