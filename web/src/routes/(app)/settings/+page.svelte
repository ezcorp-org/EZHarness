<script lang="ts">
	import { goto } from "$app/navigation";
	import { resolveLegacyHash, settingsDefaultRoute } from "$lib/settings-nav.js";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";

	// `/settings` is now a redirect shim: the mega-page was split into
	// sub-routes (see $lib/settings-nav.ts). Legacy `#anchor` deep links
	// are mapped onto their new pages; everything else lands on the first
	// page the visitor is actually allowed to open.
	$effect(() => {
		(async () => {
			// Role is resolved BEFORE the no-hash branch on purpose. It used to
			// redirect straight to a hardcoded default; now that the default
			// differs by role, doing that would bounce a member off an
			// admin-only page — two navigations to reach the same place.
			let isAdmin = false;
			try {
				const res = await fetch("/api/auth/me");
				if (res.ok) {
					const data = await res.json();
					isAdmin = data.user?.role === "admin";
				}
			} catch { /* silent — non-admin fallback */ }
			const hash = window.location.hash;
			goto(hash ? resolveLegacyHash(hash, isAdmin) : settingsDefaultRoute(isAdmin), {
				replaceState: true,
			});
		})();
	});
</script>

<SkeletonLoader type="form" />
