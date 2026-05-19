<script lang="ts">
	import "../app.css";
	import { onMount } from "svelte";
	import UpdateBanner from "$lib/components/UpdateBanner.svelte";
	import { installFaviconBadge } from "$lib/favicon-badge.js";

	let { children } = $props();

	onMount(() => {
		const splash = document.getElementById('splash');
		if (splash) {
			splash.style.opacity = '0';
			setTimeout(() => splash.remove(), 300);
		}

		// Keeps the unread-count favicon/title badge applied, and re-applies
		// the SSR "DEV " title prefix that SvelteKit strips on client
		// navigation (this supersedes the old dev-only title observer).
		return installFaviconBadge();
	});
</script>

<UpdateBanner />
{@render children()}
