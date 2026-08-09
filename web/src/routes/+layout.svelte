<script lang="ts">
	import "../app.css";
	import { onMount } from "svelte";
	import UpdateBanner from "$lib/components/UpdateBanner.svelte";
	import DevBadge from "$lib/components/DevBadge.svelte";
	import { installFaviconBadge } from "$lib/favicon-badge.js";

	let { children } = $props();

	onMount(() => {
		// Hydration marker (issue #145). app.html ships `data-hydrated="false"`
		// in the SSR payload; this is the first line of the first onMount the
		// client app runs, so the flip to "true" cannot happen before the app
		// is genuinely interactive. e2e navigations gate on it, which is what
		// stops a `fill()` from landing on a pre-hydration DOM node and being
		// silently discarded when hydration re-creates the component.
		document.documentElement.setAttribute('data-hydrated', 'true');

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
<DevBadge />
{@render children()}
