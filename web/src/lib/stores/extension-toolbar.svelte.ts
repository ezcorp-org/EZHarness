/**
 * Per-conversation cache of extension `messageToolbar[]` contributions.
 *
 * Every assistant + user row in a conversation needs the same list of
 * toolbar contributions, so we fetch once per conversation and reuse
 * the result. Without this every ChatMessage instance would issue its
 * own GET request — n rows × 1 fetch each, doubling on every turn the
 * user sends.
 *
 * The store mirrors the project's existing `*.svelte.ts` convention
 * (see `inline-tool-store.svelte.ts`, `toast.svelte.ts`): a class with
 * `$state` fields, a singleton instance exported at the bottom.
 *
 * Cache shape:
 *   - `items`: conversationId -> resolved contributions (or null while
 *     a fetch is in flight). Empty array on success-no-extensions.
 *   - `inflight`: conversationId -> Promise so concurrent ensure() calls
 *     dedupe.
 *
 * On error the cache stores an empty array so the UI degrades to "no
 * extension actions" instead of throwing into the chat row.
 */

import type { ExtensionToolbarItem } from "$lib/chat/extension-toolbar-action.js";
import { userFetch } from "$lib/utils/fetch-policy.js";

class ExtensionToolbarStore {
  /** conversationId -> resolved items, or null if not yet loaded. */
  items = $state<Record<string, ExtensionToolbarItem[] | null>>({});

  private inflight = new Map<string, Promise<ExtensionToolbarItem[]>>();

  /**
   * Ensure the contributions for a conversation are loaded. Returns
   * the same Promise for concurrent calls so the GET is dispatched at
   * most once per conversation.
   */
  ensure(conversationId: string): Promise<ExtensionToolbarItem[]> {
    if (!conversationId) return Promise.resolve([]);
    const existing = this.items[conversationId];
    if (existing != null) return Promise.resolve(existing);
    const inflight = this.inflight.get(conversationId);
    if (inflight) return inflight;
    const p = this.fetchItems(conversationId).finally(() => {
      this.inflight.delete(conversationId);
    });
    this.inflight.set(conversationId, p);
    return p;
  }

  /** Synchronous read. Returns the cached array or an empty array. */
  get(conversationId: string): ExtensionToolbarItem[] {
    return this.items[conversationId] ?? [];
  }

  /** Test-only: clear the cache between tests. */
  reset(): void {
    this.items = {};
    this.inflight.clear();
  }

  private async fetchItems(conversationId: string): Promise<ExtensionToolbarItem[]> {
    try {
      const res = await userFetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/extension-toolbar`,
      );
      if (!res.ok) {
        this.items = { ...this.items, [conversationId]: [] };
        return [];
      }
      const data = (await res.json()) as { items?: unknown };
      const list = Array.isArray(data?.items) ? (data.items as ExtensionToolbarItem[]) : [];
      this.items = { ...this.items, [conversationId]: list };
      return list;
    } catch {
      this.items = { ...this.items, [conversationId]: [] };
      return [];
    }
  }
}

export const extensionToolbarStore = new ExtensionToolbarStore();
