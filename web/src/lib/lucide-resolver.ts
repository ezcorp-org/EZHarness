/**
 * Pure helper for resolving lucide-svelte icon components by name.
 *
 * Extension `messageToolbar[]` contributions name an icon as a string
 * (e.g. `"Volume2"`, `"Sparkles"`). The host needs to translate that
 * into a renderable component without baking every possible icon into
 * the bundle. We do that with a per-process memoized dynamic import.
 *
 * Why a dedicated module:
 *   - Memoization: the dynamic `import()` call returns a fresh Promise
 *     on every invocation. Without a cache the same icon for two rows
 *     in the same conversation would issue two parallel network
 *     requests and two parallel module evaluations.
 *   - Fallback: lucide ships hundreds of icons but extensions can ship
 *     typos. Returning the existing `HelpCircle` (already in the host
 *     bundle as a stable visual fallback) means a typo never crashes
 *     the toolbar — the user just sees a question-mark icon and can
 *     report it to the extension author.
 *   - Testability: keep all the dynamic-import wiring behind a single
 *     pure function so unit tests can mock the loader.
 *
 * The companion <LucideIcon> component (resolver-aware Svelte wrapper)
 * means consumers don't have to repeat the `{#await}` dance at every
 * call site.
 */

import type { Component } from "svelte";

/**
 * Default fallback icon component. Picked because it's an existing
 * lucide name (so the loader path is identical) and visually suggests
 * "I don't know what this is" — exactly the right signal when an
 * extension names an icon that doesn't exist.
 */
export const FALLBACK_ICON_NAME = "HelpCircle";

/**
 * Lucide names use PascalCase (e.g. `Volume2`, `ArrowUpRight`); the
 * file under `lucide-svelte/icons/` is kebab-case (`volume-2`,
 * `arrow-up-right`). This converter handles both purely-alpha names
 * and names that interleave digits (`Volume2` -> `volume-2`).
 */
export function pascalToKebab(name: string): string {
  return name
    // ABc => A-Bc
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    // aB / a2 => a-B / a-2
    .replace(/([a-zA-Z])(\d)/g, "$1-$2")
    // 2A => 2-A
    .replace(/(\d)([A-Z])/g, "$1-$2")
    // aB => a-B
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Lucide icon names are restricted to a safe charset. We refuse
 * anything else to keep the dynamic-import path away from
 * directory-traversal-shaped strings.
 */
export function isSafeIconName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name);
}

type IconLoader = (kebabName: string) => Promise<{ default: Component }>;

/**
 * Default loader.
 *
 * The bare specifier `lucide-svelte/icons/<name>` only resolves at
 * runtime when Vite's static analyser sees the literal import string
 * at build time. A runtime-built template literal (with or without
 * `@vite-ignore`) won't work in the browser — the bare path doesn't
 * exist as a fetchable URL. We tried `import.meta.glob` against
 * `/node_modules/lucide-svelte/dist/icons/*.svelte` and it appears to
 * silently emit an empty map under some Vite + Svelte plugin versions
 * — the symptom is a blank toolbar button (the import promise rejects
 * with `lucide icon not in glob map`, the resolver falls back to
 * HelpCircle, the HelpCircle import has the same problem, and the
 * resolved component stays null).
 *
 * Bulletproof approach: an explicit static-import map. Each value is a
 * literal `import("lucide-svelte/icons/<kebab>")` call that Vite can
 * trace to the package's `exports["./icons/*"]` entry and emit as its
 * own code-split chunk. The bundle still grows per-icon-actually-used
 * (not all 1500+ lucide icons), but every key in the map is reachable
 * at runtime.
 *
 * Adding new icons: extensions that name a `messageToolbar.icon` not
 * in this map will fall back to `HelpCircle` — a visible "this icon
 * isn't shipped" signal. Add the new entry here when an extension
 * author lands a PR that needs it. Keys are PascalCase (the manifest
 * shape); values resolve the kebab-case file. `pascalToKebab` is NOT
 * used here because the import path must be a literal.
 */
// `lucide-svelte` ships icons as Svelte 4 legacy components; their
// declared type doesn't match Svelte 5's `Component` runes type that
// our resolver public interface uses. The cast here is the standard
// svelte-4-into-runes-mode interop: legacy components mount fine in
// runes-mode call sites, only the type signatures diverge. Limited
// scope, no runtime impact.
type LucideModule = { default: Component };

const STATIC_ICON_LOADERS: Record<string, () => Promise<LucideModule>> = {
  // Always include the fallback so `loadFallback()` works even if the
  // platform extensions request only icons not in this map.
  HelpCircle: () =>
    import("lucide-svelte/icons/help-circle") as unknown as Promise<LucideModule>,

  // ── Bundled extensions ──────────────────────────────────────────
  // kokoro-tts: speaker icon contributed via messageToolbar[].
  Volume2: () =>
    import("lucide-svelte/icons/volume-2") as unknown as Promise<LucideModule>,
};

const defaultLoader: IconLoader = async (kebabName) => {
  // Static map is keyed by PascalCase. Convert the kebab name back —
  // we round-trip here because resolveLucideIcon() already converted
  // to kebab via pascalToKebab() before calling the loader.
  const pascalKey = kebabToPascalForLookup(kebabName);
  const loader = STATIC_ICON_LOADERS[pascalKey];
  if (!loader) {
    throw new Error(`lucide icon not in static map: ${kebabName} (add it to STATIC_ICON_LOADERS)`);
  }
  const mod = await loader();
  return mod;
};

/**
 * Reverse of `pascalToKebab` — used ONLY by the default loader to look
 * up entries in `STATIC_ICON_LOADERS` (which is keyed by PascalCase to
 * match the manifest shape). Not exported; the kebab→pascal conversion
 * here doesn't need to be bidirectional in general (lucide icon names
 * have a known shape: alpha runs, optional digit suffix).
 */
function kebabToPascalForLookup(kebab: string): string {
  return kebab
    .split("-")
    .map((part) =>
      part.length === 0
        ? ""
        : /^\d+$/.test(part)
          ? part
          : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
}

const resolveCache = new Map<string, Promise<Component>>();

let activeLoader: IconLoader = defaultLoader;
let fallbackPromise: Promise<Component> | null = null;

/**
 * Test seam: swap out the icon loader. Tests can pass a stub that
 * returns synthetic Svelte components so they don't pay the real
 * `import()` cost. Resets the cache so the new loader is consulted.
 */
export function __setIconLoader(loader: IconLoader | null): void {
  activeLoader = loader ?? defaultLoader;
  resolveCache.clear();
  fallbackPromise = null;
}

/**
 * Resolve an icon name to its Svelte component.
 *
 *   - Memoized: subsequent lookups reuse the in-flight or resolved
 *     Promise.
 *   - Fallback: if the name is unsafe or the import 404s, returns the
 *     `HelpCircle` icon (also memoized).
 *   - Pure: every effect (caching, fallback loading) is deterministic
 *     given the loader and name. Tests mock by swapping the loader
 *     via `__setIconLoader`.
 */
export function resolveLucideIcon(name: string): Promise<Component> {
  const safe = isSafeIconName(name);
  const key = safe ? name : FALLBACK_ICON_NAME;
  const cached = resolveCache.get(key);
  if (cached) return cached;

  if (!safe) {
    return loadFallback();
  }

  const loadPromise = activeLoader(pascalToKebab(name))
    .then((mod) => mod.default)
    .catch(() => loadFallback());

  resolveCache.set(key, loadPromise);
  return loadPromise;
}

function loadFallback(): Promise<Component> {
  if (fallbackPromise) return fallbackPromise;
  fallbackPromise = activeLoader(pascalToKebab(FALLBACK_ICON_NAME))
    .then((mod) => mod.default)
    .catch(() => {
      // If even the fallback fails (loader stub misconfigured), expose
      // a tiny synthetic component so consumers always have something
      // to mount. Real users hit this only if lucide-svelte is missing
      // entirely, which is a build-time error elsewhere.
      const stub = (() => null) as unknown as Component;
      return stub;
    });
  return fallbackPromise;
}

/** Test-only: reset cache between tests without changing the loader. */
export function __resetIconCache(): void {
  resolveCache.clear();
  fallbackPromise = null;
}
