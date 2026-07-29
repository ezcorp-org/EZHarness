<!--
  HubNavSection — the sidebar's collapsible "Hub" entry.

  Renders the Hub index link plus a disclosure caret. Expanding the caret
  lazily loads the Hub page listing (`/api/hub/pages`) and lists EVERY page
  ALPHABETICALLY — the same `sortHubPagesByTitle` ordering the Hub tab bar
  uses, so the two never drift. It STARTS COLLAPSED: the listing fetch only
  fires the first time the user opens it (and only once — subsequent toggles
  reuse the cached list).

  Mounted by BOTH sidebar surfaces in `(app)/+layout.svelte`: the desktop
  command column and the mobile drawer. The drawer passes `onnavigate` so a
  page click also closes the drawer; on desktop it is omitted (a no-op).
-->
<script lang="ts">
	import { sortHubPagesByTitle, type HubPageListing } from "$lib/hub";
	import LucideIcon from "$lib/components/LucideIcon.svelte";

	let {
		hubBase,
		currentPath,
		active = false,
		onnavigate,
	}: {
		/** Route prefix for the Hub index + its child pages — "/hub" (global)
		 *  or "/project/<id>/hub" (in a project). */
		hubBase: string;
		/** The current pathname — drives the active highlight on each page row. */
		currentPath: string;
		/** True when the current route is anywhere under the Hub (highlights the
		 *  "Hub" index row even while collapsed). */
		active?: boolean;
		/** Invoked after a link click — the mobile drawer uses it to close itself. */
		onnavigate?: () => void;
	} = $props();

	// Collapsed by default (the feature's core requirement). Toggling reveals
	// the ABC-sorted page list.
	let expanded = $state(false);
	let loaded = $state(false);
	let loading = $state(false);
	let pages = $state<HubPageListing[]>([]);

	async function loadPages() {
		// Lazy + once: never refetch after the first successful/failed load, and
		// never fire two concurrent loads from rapid toggling.
		if (loaded || loading) return;
		loading = true;
		try {
			const res = await fetch("/api/hub/pages");
			if (res.ok) {
				const data = (await res.json()) as { pages?: HubPageListing[] };
				pages = sortHubPagesByTitle(data.pages ?? []);
			}
		} catch {
			// Degrade silently — the Hub index link still navigates.
		} finally {
			loaded = true;
			loading = false;
		}
	}

	function toggle() {
		expanded = !expanded;
		if (expanded) void loadPages();
	}

	function pageHref(id: string): string {
		return `${hubBase}/${encodeURIComponent(id)}`;
	}

	function isPageActive(id: string): boolean {
		return currentPath === pageHref(id);
	}
</script>

<div data-testid="hub-nav-section">
	<!-- Index row: caret toggles the dropdown; the label links to the hub index. -->
	<div class="deck-row" aria-current={active ? "page" : undefined}>
		<button
			type="button"
			class="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[var(--color-text-muted)] transition-transform duration-150 hover:text-[var(--color-text-primary)] {expanded
				? 'rotate-90'
				: ''}"
			aria-expanded={expanded}
			aria-controls="hub-nav-pages"
			aria-label={expanded ? "Collapse Hub pages" : "Expand Hub pages"}
			data-testid="hub-nav-toggle"
			onclick={toggle}
		>
			<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		</button>
		<a
			href={hubBase}
			class="min-w-0 flex-1 truncate"
			data-testid="hub-nav-link"
			onclick={() => onnavigate?.()}
		>
			Hub
		</a>
	</div>

	{#if expanded}
		<ul id="hub-nav-pages" class="mt-0.5 flex flex-col gap-0.5" data-testid="hub-nav-pages">
			{#if loading}
				<li
					class="px-2.5 py-1 pl-8 text-xs text-[var(--color-text-muted)]"
					data-testid="hub-nav-loading"
				>
					Loading…
				</li>
			{:else if pages.length === 0}
				<li
					class="px-2.5 py-1 pl-8 text-xs text-[var(--color-text-muted)]"
					data-testid="hub-nav-empty"
				>
					No Hub pages yet
				</li>
			{:else}
				{#each pages as p (p.id)}
					<a
						href={pageHref(p.id)}
						class="deck-row"
						style="padding-left: 1.75rem;"
						data-testid="hub-nav-page"
						data-page-id={p.id}
						aria-current={isPageActive(p.id) ? "page" : undefined}
						onclick={() => onnavigate?.()}
					>
						{#if p.icon}
							<LucideIcon name={p.icon} size={13} class="shrink-0" />
						{/if}
						<span class="truncate">{p.title}</span>
					</a>
				{/each}
			{/if}
		</ul>
	{/if}
</div>
