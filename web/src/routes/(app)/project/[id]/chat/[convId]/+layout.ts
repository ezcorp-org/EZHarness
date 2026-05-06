/**
 * Conversation layout — preloads per-extension settings the chat's tool
 * cards rely on. Tool cards (e.g. the kokoro-tts player) read their
 * extension's resolved settings from the shared `extensionSettings`
 * store synchronously while rendering, so the load has to complete
 * (or at least kick off) before the first card mounts.
 *
 * Walks the enabled-extensions list and fires `loadExtensionSettings`
 * for every extension that declares a `settings` block. Failures are
 * non-fatal — each card has a sane default fallback.
 */

import { loadExtensionSettings } from "$lib/stores/extensionSettings";
import type { LayoutLoad } from "./$types";

interface ExtensionListItem {
  name?: string;
  enabled?: boolean;
  manifest?: { settings?: Record<string, unknown> } | null;
}

export const load: LayoutLoad = async ({ fetch }) => {
  try {
    const res = await fetch("/api/extensions");
    if (res.ok) {
      const data = (await res.json()) as ExtensionListItem[] | { extensions?: ExtensionListItem[] };
      const list: ExtensionListItem[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.extensions)
          ? data.extensions
          : [];
      await Promise.all(
        list
          .filter(
            (e) =>
              e.enabled === true &&
              typeof e.name === "string" &&
              e.manifest?.settings &&
              Object.keys(e.manifest.settings).length > 0,
          )
          .map((e) => loadExtensionSettings(e.name as string).catch(() => undefined)),
      );
    }
  } catch {
    // Non-fatal — tool cards fall back to defaults if their settings aren't preloaded.
  }
  return {};
};
