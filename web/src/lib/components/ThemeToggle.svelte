<script lang="ts">
	import { store } from "$lib/stores.svelte.js";
	import { setTheme } from "$lib/theme.js";

	function toggle() {
		const isDark = document.documentElement.classList.contains("dark");
		const newMode = isDark ? "light" : "dark";
		store.theme = newMode;
		setTheme(newMode);
	}

	let isDark = $derived(store.theme === "dark" || (store.theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches));
</script>

<button
	onclick={toggle}
	class="flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
	aria-label="Toggle theme"
	title="Toggle theme"
	style="min-width: 44px; min-height: 44px;"
>
	{#if isDark}
		<!-- Sun icon (click to go light) -->
		<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
			<circle cx="12" cy="12" r="5" />
			<path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
		</svg>
	{:else}
		<!-- Moon icon (click to go dark) -->
		<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
			<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
		</svg>
	{/if}
</button>
