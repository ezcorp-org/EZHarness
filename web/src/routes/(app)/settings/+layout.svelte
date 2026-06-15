<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { SETTINGS_NAV, activeNavId } from "$lib/settings-nav.js";
	import { filterSettings } from "$lib/settings-search.js";

	let { children } = $props();

	type CurrentUser = { id: string; email: string; name: string; role: "admin" | "member" };
	let currentUser = $state<CurrentUser | null>(null);
	let navQuery = $state("");

	// onMount, not $effect: a one-shot load whose result feeds derived
	// state only — wrapping it in $effect is the self-retrigger footgun
	// called out in locked decision 4.
	onMount(async () => {
		try {
			const res = await fetch("/api/auth/me");
			if (res.ok) {
				const data = await res.json();
				currentUser = data.user;
			}
		} catch { /* silent */ }
	});

	const isAdmin = $derived(currentUser?.role === "admin");
	// Client-side filter over the static registry (locked decision 3);
	// admin gating folded into filterSettings.
	const navItems = $derived(filterSettings(navQuery, SETTINGS_NAV, isAdmin));
	const activeId = $derived(activeNavId(page.url.pathname));

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key !== "Enter") return;
		event.preventDefault();
		// Enter navigates to the top match (registry order breaks ties).
		const top = navItems[0];
		if (top) goto(top.href);
	}
</script>

<div class="mx-auto max-w-5xl">
	<h1 class="mb-4 text-2xl font-bold text-[var(--color-text-primary)]">Settings</h1>
	<div class="md:flex md:items-start md:gap-8">
		<div class="mb-4 md:mb-0 md:w-48 md:shrink-0">
			<label for="settings-nav-search" class="sr-only">Search settings</label>
			<input
				id="settings-nav-search"
				type="search"
				bind:value={navQuery}
				onkeydown={onSearchKeydown}
				placeholder="Search settings..."
				data-testid="settings-nav-search"
				autocomplete="off"
				aria-controls="settings-nav-list"
				class="mb-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
			<nav
				id="settings-nav-list"
				aria-label="Settings sections"
				data-testid="settings-nav"
				class="-mx-1 flex gap-1 overflow-x-auto px-1 pb-2 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0"
			>
				{#each navItems as item}
				<a
					href={item.href}
					aria-current={activeId === item.id ? "page" : undefined}
					data-testid="settings-nav-{item.id}"
					class="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors {item.child ? 'md:ml-3' : ''} {activeId === item.id
						? 'bg-[var(--color-surface-tertiary)] font-medium text-[var(--color-text-primary)]'
						: 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text-primary)]'}"
				>
						{item.label}
						{#if item.adminOnly}
							<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">admin</span>
						{/if}
					</a>
				{:else}
					<p class="px-3 py-2 text-sm text-[var(--color-text-muted)]" data-testid="settings-nav-empty">No matching settings.</p>
				{/each}
			</nav>
		</div>
		<div class="min-w-0 flex-1 space-y-6">
			{@render children()}
		</div>
	</div>
</div>
