/**
 * Phase 48 Wave 3 — Ez context registry.
 *
 * Pages opt into richer Ez support by mounting `<EzContext>` (a tiny
 * Svelte component that calls `registerContext` on mount, and
 * `deregisterContext` on unmount). The registry is a *pure* in-memory
 * map keyed by the deregister-token symbol — nothing about it depends
 * on Svelte runes or DOM, so it tests cleanly under bun without jsdom.
 *
 * Why a token-symbol instead of a routeId-keyed map: the same routeId
 * can mount twice for a microsecond during fast navigation (the new
 * page mounts before the old page's onDestroy runs). A symbol-keyed
 * map gives every mount its own slot, so the deregister of the
 * previous mount can never accidentally evict the new one.
 *
 * Subscribers get a snapshot via `readSnapshot()` — an *array* of
 * entries, not a map — because the consumer (`buildEzContextPayload`)
 * needs deterministic order and Svelte stores work natively with
 * arrays. `subscribe(fn)` is provided for future reactive uses; the
 * v1 panel reads on demand at send time.
 */
export type FormFieldKind = "string" | "number" | "boolean" | "json";

export interface FormHandler {
  schema: Record<string, FormFieldKind>;
  fill: (values: Record<string, unknown>) => void;
}

export interface ContextEntry {
  routeId: string;
  data: Record<string, unknown>;
  forms: Record<string, FormHandler>;
}

const entries = new Map<symbol, ContextEntry>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) {
    try { fn(); } catch { /* keep going */ }
  }
}

/**
 * Register a context entry. Returns a token symbol that the caller
 * MUST pass to `deregisterContext` on unmount; otherwise the entry
 * leaks across navigations.
 */
export function registerContext(entry: ContextEntry): symbol {
  const token = Symbol(entry.routeId || "ez-context");
  entries.set(token, entry);
  notify();
  return token;
}

/**
 * Deregister a previously-registered entry. No-op if the token is
 * unknown (e.g. double-deregister, or onDestroy fired after the
 * registry was cleared in tests).
 */
export function deregisterContext(token: symbol): void {
  if (entries.delete(token)) notify();
}

/**
 * Read all currently-registered entries. Returns a fresh array so
 * callers can mutate the result without affecting the registry.
 */
export function readSnapshot(): ContextEntry[] {
  return Array.from(entries.values());
}

/**
 * Subscribe to registry changes. The callback fires after every
 * register/deregister. Returns an unsubscribe function. Provided
 * for tests and future reactive consumers; the panel reads on
 * demand at send time so it does not need to subscribe.
 */
export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/**
 * Look up a form handler by formId across all registered entries.
 * Returns undefined when no entry registers that formId — the
 * client-tool dispatcher converts this into an explicit "no
 * handler" error result so the LLM can recover.
 */
export function findFormHandler(formId: string): FormHandler | undefined {
  for (const entry of entries.values()) {
    const h = entry.forms[formId];
    if (h) return h;
  }
  return undefined;
}

/**
 * Test helper — clears every registered entry. Production code
 * never calls this; use deregisterContext with the token instead.
 */
export function __resetForTests(): void {
  entries.clear();
  subscribers.clear();
}
