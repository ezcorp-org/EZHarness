// ── @ezcorp/sdk entities — managed-namespace storage ─────────────
//
// Pure key-helpers and a thin CRUD wrapper around a `StoreLike`
// interface. The SDK does not import `runtime/storage.ts` here so the
// same module can run host-side (during install/seed/migrate, where
// the host injects its own storage backend) and inside the extension
// subprocess (where the runtime's `Storage` class is the backend).
//
// Reserved namespace:
//   __entity:<type>:<slug>        record body
//   __entity-index:<type>          string[] of slugs (sorted, deduped)
//
// Slug regex is enforced upstream (slug.ts). Type regex matches the
// same shape — see `assertValidType`. Reserved-prefix collisions on
// caller-supplied keys throw before any storage call.
//
// Index semantics:
//   - readIndex() defensively filters non-string entries
//   - writeIndex() sorts + dedupes (stable test snapshots; corruption-tolerant)
//   - All mutations sequence (write record) → (read index) → (write index).
//     Failure between steps leaves the index stale — list_* filters
//     out slugs whose record is missing (locked decision: index is a
//     cache, the record is the source of truth).

import {
  ENTITY_INDEX_PREFIX,
  ENTITY_KEY_PREFIX,
  type EntityRecord,
} from "./types";
import { assertValidSlug, isValidSlug } from "./slug";

// ── Backing store interface ─────────────────────────────────────
//
// Mirrors the shape of `runtime/storage.ts`'s `Storage` class (the
// subset we actually use here) plus what the host's storage-handler
// exposes. Keeping it a structural interface means tests inject a
// plain object and the host injects its handler without going
// through the JSON-RPC channel.

export interface EntityStoreGetResult<T> {
  value: T | null;
  exists: boolean;
}

export interface EntityStoreLike {
  get<T = unknown>(key: string): Promise<EntityStoreGetResult<T>>;
  set<T = unknown>(key: string, value: T): Promise<unknown>;
  delete(key: string): Promise<{ deleted: boolean }>;
}

// ── Key construction ────────────────────────────────────────────

const TYPE_REGEX = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** Same shape as slug — entity types are storage-key segments too. */
export function isValidEntityType(type: unknown): type is string {
  return typeof type === "string" && TYPE_REGEX.test(type);
}

export function assertValidEntityType(
  type: unknown,
): asserts type is string {
  if (!isValidEntityType(type)) {
    throw new Error(
      `Invalid entity type ${JSON.stringify(type)} — must match ${TYPE_REGEX.source}`,
    );
  }
}

export function entityRecordKey(type: string, slug: string): string {
  assertValidEntityType(type);
  assertValidSlug(slug);
  return `${ENTITY_KEY_PREFIX}${type}:${slug}`;
}

export function entityIndexKey(type: string): string {
  assertValidEntityType(type);
  return `${ENTITY_INDEX_PREFIX}${type}`;
}

/**
 * Returns true if `key` lives inside the SDK-managed namespace and
 * therefore must NOT be writable through an extension's general
 * storage permission. Used by the host's storage-handler clamp.
 */
export function isReservedEntityKey(key: unknown): boolean {
  if (typeof key !== "string") return false;
  return (
    key.startsWith(ENTITY_KEY_PREFIX) || key.startsWith(ENTITY_INDEX_PREFIX)
  );
}

/**
 * Throws if a caller-supplied key collides with the managed namespace.
 * Called from settings/storage-handler clamps to reject manifests or
 * tool calls that try to write `__entity:*` directly.
 */
export function assertNotReserved(key: unknown, ctx = "key"): void {
  if (isReservedEntityKey(key)) {
    throw new Error(
      `${ctx} ${JSON.stringify(key)} uses reserved entity namespace — extensions may not write __entity:* or __entity-index:* directly`,
    );
  }
}

// ── Index read/write ────────────────────────────────────────────

export async function readEntityIndex(
  store: EntityStoreLike,
  type: string,
): Promise<string[]> {
  const res = await store.get<unknown>(entityIndexKey(type));
  if (!res.exists || !Array.isArray(res.value)) return [];
  // Defensive: strip non-strings and invalid slugs so a corrupted
  // index can't poison every subsequent call.
  return res.value.filter(isValidSlug);
}

export async function writeEntityIndex(
  store: EntityStoreLike,
  type: string,
  slugs: readonly string[],
): Promise<void> {
  const sorted = Array.from(new Set(slugs.filter(isValidSlug))).sort();
  await store.set(entityIndexKey(type), sorted);
}

// ── CRUD primitives ─────────────────────────────────────────────
//
// Schema validation is intentionally NOT performed here — that's the
// caller's responsibility (the auto-generated tools call assertRecord
// before invoking these). Keeping storage and validation separate
// means the host's installer-side rename + soft-read paths can call
// these directly without paying for a re-validation each time.

export async function readEntityRecord<T = Record<string, unknown>>(
  store: EntityStoreLike,
  type: string,
  slug: string,
): Promise<EntityRecord<T> | null> {
  const res = await store.get<T>(entityRecordKey(type, slug));
  if (!res.exists || res.value === null) return null;
  return { slug, data: res.value };
}

export async function writeEntityRecord<T = Record<string, unknown>>(
  store: EntityStoreLike,
  type: string,
  slug: string,
  data: T,
): Promise<void> {
  await store.set(entityRecordKey(type, slug), data);
  const slugs = await readEntityIndex(store, type);
  if (!slugs.includes(slug)) {
    await writeEntityIndex(store, type, [...slugs, slug]);
  }
}

export async function deleteEntityRecord(
  store: EntityStoreLike,
  type: string,
  slug: string,
): Promise<boolean> {
  const existing = await store.get<unknown>(entityRecordKey(type, slug));
  if (!existing.exists) {
    // Make sure the index is consistent even when the record was
    // already gone (e.g. orphan slug from a half-failed earlier
    // delete). Idempotent.
    const slugs = await readEntityIndex(store, type);
    if (slugs.includes(slug)) {
      await writeEntityIndex(
        store,
        type,
        slugs.filter((s) => s !== slug),
      );
    }
    return false;
  }
  const res = await store.delete(entityRecordKey(type, slug));
  const slugs = await readEntityIndex(store, type);
  await writeEntityIndex(
    store,
    type,
    slugs.filter((s) => s !== slug),
  );
  return res.deleted;
}

/**
 * List records by reading the index then fetching each row. Slugs
 * whose record is missing (index drift) are silently dropped from
 * the returned list — the index will self-heal on the next mutation.
 */
export async function listEntityRecords<T = Record<string, unknown>>(
  store: EntityStoreLike,
  type: string,
): Promise<EntityRecord<T>[]> {
  const slugs = await readEntityIndex(store, type);
  const out: EntityRecord<T>[] = [];
  for (const slug of slugs) {
    const rec = await readEntityRecord<T>(store, type, slug);
    if (rec !== null) out.push(rec);
  }
  return out;
}
