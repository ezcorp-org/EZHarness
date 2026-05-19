<!--
  LucideIcon — name-driven dynamic-import wrapper for lucide-svelte.

  Resolves an icon by string name (e.g. `"Volume2"`) and renders its
  component. While the import is pending OR if the name is unknown the
  fallback (HelpCircle) is mounted. Memoized via `lucide-resolver.ts`,
  so repeated <LucideIcon name="…"> for the same name only triggers a
  single dynamic import per process.

  Used by the extension `messageToolbar[]` slot in MessageToolbar.svelte
  so consumers don't have to do the `{#await resolveLucideIcon(name)}`
  dance at every call site.
-->
<script lang="ts">
  import type { Component } from "svelte";
  import { resolveLucideIcon } from "$lib/lucide-resolver.js";

  let {
    name,
    class: className = "",
    strokeWidth = 2,
    size,
  }: {
    /** PascalCase lucide icon name. Unknown names render the fallback. */
    name: string;
    /** Tailwind / utility class applied to the rendered icon. */
    class?: string;
    /** Forwards to the lucide component's `strokeWidth` prop. */
    strokeWidth?: number;
    /** Pixel size for the rendered SVG. lucide-svelte's legacy-mode
     *  Icon.svelte hard-codes `width={size}` / `height={size}` (default
     *  24) AS attributes — Tailwind h-N/w-N classes don't reliably
     *  override those for dynamically-resolved components, so callers
     *  who want a non-24 icon must pass `size` explicitly. */
    size?: number;
  } = $props();

  // Resolved component is null until the dynamic import lands. The
  // wrapper renders nothing in that brief window — toolbar buttons
  // already have an aria-label, so a missing icon for ~one frame is
  // not a screen-reader regression.
  let Resolved = $state<Component | null>(null);

  $effect(() => {
    let cancelled = false;
    void resolveLucideIcon(name).then((component) => {
      if (!cancelled) Resolved = component;
    });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if Resolved}
  {#if size !== undefined}
    <Resolved class={className} {strokeWidth} {size} />
  {:else}
    <Resolved class={className} {strokeWidth} />
  {/if}
{/if}
