/**
 * Per-extension resolved settings cache.
 *
 * Mirrors the project's `*.svelte.ts` rune-store convention. The browser
 * fetches `/api/extensions/<id>/settings` once per chat session (via the
 * conversation layout), keys the resolved blob by extension *name*, and
 * tool cards read it synchronously while rendering.
 *
 * The cache lives module-scope: cards mounted in different conversations
 * share the same resolved values (settings are per-user, not per-chat).
 * Invalidation happens explicitly from the settings detail page after a
 * save or reset.
 */

type ResolvedSettings = Record<string, unknown>;

interface ExtensionLookup {
  id: string;
  name: string;
}

const cache = new Map<string, ResolvedSettings>();
const inflight = new Map<string, Promise<ResolvedSettings>>();

async function resolveExtensionId(extensionName: string): Promise<string | null> {
  const res = await fetch(
    `/api/extensions?name=${encodeURIComponent(extensionName)}`,
  );
  if (!res.ok) return null;
  // Server now filters server-side. The legacy `{extensions:[...]}`
  // shape is still tolerated for older fixtures, but production sends
  // a single-element array (or empty array) when `?name=` is set.
  const data = (await res.json()) as ExtensionLookup[] | { extensions?: ExtensionLookup[] };
  const list = Array.isArray(data) ? data : (data.extensions ?? []);
  const match = list.find((e) => e.name === extensionName);
  return match?.id ?? null;
}

export interface LoadOptions {
  force?: boolean;
}

export async function loadExtensionSettings(
  extensionName: string,
  opts: LoadOptions = {},
): Promise<ResolvedSettings> {
  if (!opts.force) {
    const cached = cache.get(extensionName);
    if (cached) return cached;
    const inFlight = inflight.get(extensionName);
    if (inFlight) return inFlight;
  }
  const promise = (async () => {
    try {
      const id = await resolveExtensionId(extensionName);
      if (!id) {
        cache.set(extensionName, {});
        return {};
      }
      const res = await fetch(`/api/extensions/${id}/settings`);
      if (!res.ok) {
        cache.set(extensionName, {});
        return {};
      }
      const body = (await res.json()) as { resolved?: ResolvedSettings };
      const resolved = body.resolved ?? {};
      cache.set(extensionName, resolved);
      return resolved;
    } catch {
      cache.set(extensionName, {});
      return {};
    } finally {
      inflight.delete(extensionName);
    }
  })();
  inflight.set(extensionName, promise);
  return promise;
}

export function getCachedSettings(
  extensionName: string,
): ResolvedSettings | undefined {
  return cache.get(extensionName);
}

export function invalidateExtensionSettings(extensionName: string): void {
  cache.delete(extensionName);
  inflight.delete(extensionName);
}

export function __resetExtensionSettingsCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
