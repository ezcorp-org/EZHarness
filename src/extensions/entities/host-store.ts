// ── host-side EntityStoreLike adapter ────────────────────────────
//
// Phase 3: bridges the SDK's pure-function `EntityStoreLike` interface
// (packages/@ezcorp/sdk/src/entities/storage.ts) to the host's
// `extension_storage` table. The same SDK tool handlers run in two
// places:
//
//   - inside an extension subprocess (reverse-RPC to `ezcorp/storage`),
//     using whatever `EntityStoreLike` the runtime wires up; and
//   - inside the host process at install/seed/migrate time AND at every
//     SDK-served tool dispatch (the registry's intercept path that
//     short-circuits the subprocess for entity tools).
//
// In the host path we don't have a subprocess; we call directly into
// `src/db/queries/extension-storage.ts`. The adapter built here is
// purely about adapting return shapes — no encryption (entity records
// are user-visible; encryption would block the auto-table UI), no
// rate-limiter (the host-served path is for the user's own UI/LLM, not
// a hostile subprocess), and no quota check (entity records share the
// extension's existing storage quota, enforced at `setStorageValue`
// time only for the subprocess-driven `set` action — the auto-table is
// trusted host code).
//
// Scope routing: an entity declaration's `scope` ("user" | "project" |
// "conversation") maps onto the existing storage `scope` enum. Each
// adapter is bound to a `{scope, scopeId}` pair so the SDK handler
// doesn't need to know whether it's looking at user-scoped or
// conversation-scoped data — the same key reads/writes the right row.
//
// Hot-path caveat: each adapter is constructed per dispatch (cheap;
// just closes over four IDs). Don't try to cache them across calls —
// the (extensionId, scope, scopeId) tuple varies per call and the
// cache invalidation would cost more than the construction.

import type {
  EntityStoreGetResult,
  EntityStoreLike,
} from "@ezcorp/sdk/entities";
import {
  deleteStorageValue,
  getStorageValue,
  setStorageValue,
} from "../../db/queries/extension-storage";

type StorageScope = "global" | "conversation" | "user";

/**
 * Constructor inputs for the host-side store adapter.
 *
 *   - `extensionId` — DB row id of the owning extension.
 *   - `scope` — entity scope from the declaration. Mirrors the SDK's
 *     `EntityScope` ("user" | "project" | "conversation"); "project"
 *     currently maps onto the conversation row because the host
 *     doesn't yet expose a project-scoped storage tier (see the
 *     scope-mapping notes inline). The mapping is centralized here so
 *     the rest of the code reads a single shape.
 *   - `scopeId` — for user scope, the user id; for conversation scope,
 *     the conversationId. For "user" entities the host installer
 *     passes the installing user's id; for tool dispatches the
 *     tool-executor passes the acting user's id.
 */
export interface HostEntityStoreOptions {
  extensionId: string;
  scope: "user" | "project" | "conversation";
  scopeId: string | null;
}

function mapScope(
  scope: HostEntityStoreOptions["scope"],
): StorageScope {
  switch (scope) {
    case "user":
      return "user";
    case "conversation":
      return "conversation";
    case "project":
      // v1 doesn't ship a project-scoped storage tier. We map onto
      // conversation rows so existing infra (per-conversation isolation)
      // applies. The SDK schema reserves "project" so a future tier can
      // land without an SDK breaking change.
      return "conversation";
  }
}

/**
 * Build a `EntityStoreLike` bound to a single extension + scope. Every
 * read/write/delete routes through `extension_storage` queries with
 * the bound IDs, returning the shape the SDK's storage helpers expect.
 *
 * The adapter does NOT enforce reserved-key namespace clamps — that's
 * the SDK's `assertNotReserved` job, invoked by the auto-generated
 * tools BEFORE they reach the adapter. The host's outer
 * `storage-handler.ts` clamp (rejecting `__*` from subprocess RPCs)
 * still applies to anything other than the SDK-served path.
 */
export function createHostEntityStore(
  opts: HostEntityStoreOptions,
): EntityStoreLike {
  const storageScope = mapScope(opts.scope);
  const { extensionId, scopeId } = opts;

  return {
    async get<T = unknown>(key: string): Promise<EntityStoreGetResult<T>> {
      const row = await getStorageValue(
        extensionId,
        storageScope,
        scopeId,
        key,
      );
      if (!row) return { value: null, exists: false };
      // The host-served path never writes encrypted entity records —
      // the auto-table UI needs to read them as plain JSON. If we
      // somehow read an encrypted row (manual DB tampering), surface
      // a `null` rather than leaking ciphertext: the soft-read path
      // will then attach a SCHEMA_DRIFT warning when callers try to
      // validate the missing record.
      if (row.encrypted) {
        return { value: null, exists: false };
      }
      return { value: row.value as T, exists: true };
    },

    async set<T = unknown>(key: string, value: T): Promise<unknown> {
      const serialized = JSON.stringify(value);
      const sizeBytes = Buffer.byteLength(serialized, "utf-8");
      await setStorageValue(
        extensionId,
        storageScope,
        scopeId,
        key,
        value,
        false /* not encrypted — entities are user-visible */,
        sizeBytes,
        undefined /* no TTL — entity records are durable */,
      );
      return { ok: true, sizeBytes };
    },

    async delete(key: string): Promise<{ deleted: boolean }> {
      const deleted = await deleteStorageValue(
        extensionId,
        storageScope,
        scopeId,
        key,
      );
      return { deleted };
    },
  };
}
