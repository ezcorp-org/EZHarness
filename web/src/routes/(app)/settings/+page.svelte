<script lang="ts">
	import { goto } from "$app/navigation";
	import { resolveLegacyHash, SETTINGS_DEFAULT_ROUTE } from "$lib/settings-nav.js";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";

	// `/settings` is now a redirect shim: the mega-page was split into
	// sub-routes (see $lib/settings-nav.ts). Legacy `#anchor` deep links
	// are mapped onto their new pages; everything else lands on the
	// default Models & Providers page.
	$effect(() => {
		(async () => {
			const hash = window.location.hash;
			if (!hash) {
				goto(SETTINGS_DEFAULT_ROUTE, { replaceState: true });
				return;
			}
			let isAdmin = false;
			try {
				const res = await fetch("/api/auth/me");
				if (res.ok) {
					const data = await res.json();
					isAdmin = data.user?.role === "admin";
				}
			} catch { /* silent — non-admin fallback */ }
			goto(resolveLegacyHash(hash, isAdmin), { replaceState: true });
		})();
	});
</script>

<SkeletonLoader type="form" />
