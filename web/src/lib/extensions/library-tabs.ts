/**
 * Phase 52.1 — Library tabs persistence.
 *
 * Tiny helper module that owns the localStorage round-trip for the
 * `/extensions` page tab state. Pulled out of the page so a unit test
 * can verify the round-trip without mounting the whole 950-line page
 * component, and so any future surface that needs the same key (e.g.
 * a deep-link pre-selecting the tab) doesn't duplicate the literal.
 *
 * The key — `ezcorp.extensions.activeTab` — is namespaced with the
 * `ezcorp.` prefix used by the rest of the per-page localStorage state
 * (see `web/src/lib/scroll-restore.ts`, `web/src/lib/draft-store.ts`).
 *
 * SSR-safety: the read function returns the default ("installed") on
 * the server (where `localStorage` is undefined). The write function
 * is a no-op on the server. Both swallow `QuotaExceededError` and bad
 * JSON — a client whose storage is broken still gets a working tab,
 * it just doesn't persist.
 */

export const ACTIVE_TAB_STORAGE_KEY = "ezcorp.extensions.activeTab";

export type LibraryTab = "builtins" | "installed";

const VALID: ReadonlyArray<LibraryTab> = ["builtins", "installed"] as const;

function isLibraryTab(value: unknown): value is LibraryTab {
  return typeof value === "string" && (VALID as readonly string[]).includes(value);
}

/**
 * Read the persisted active tab. Returns "installed" on:
 *  - SSR (no `localStorage`)
 *  - missing key
 *  - any value that isn't one of the two known tabs (defends against
 *    a future tab being added/removed without a migration).
 */
export function readActiveTab(): LibraryTab {
  try {
    if (typeof localStorage === "undefined") return "installed";
    const raw = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (raw === null) return "installed";
    return isLibraryTab(raw) ? raw : "installed";
  } catch {
    // Throwing-getter localStorage (sandboxed iframes), SecurityError
    // on getItem, or a hostile localStorage replacement — all silently
    // fall back to the default tab.
    return "installed";
  }
}

/**
 * Persist the active tab. Silently no-ops on SSR or when the storage
 * write fails (quota exceeded, third-party-cookie blocking in iframe,
 * etc.) — the in-memory state still works for the rest of the session.
 */
export function writeActiveTab(tab: LibraryTab): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
  } catch {
    // Storage full / disabled / throwing-getter — fall through. UI
    // still works in-session.
  }
}
