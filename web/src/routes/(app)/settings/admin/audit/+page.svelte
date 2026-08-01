<script lang="ts">
	import { goto } from "$app/navigation";
	import { requireAdmin } from "$lib/admin-guard.js";
	import { settingsDefaultRoute } from "$lib/settings-nav.js";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import AuditLogSection from "$lib/components/settings/AuditLogSection.svelte";

	let pageLoading = $state(true);

	$effect(() => {
		(async () => {
			const user = await requireAdmin();
			if (!user) {
				goto(settingsDefaultRoute(false), { replaceState: true });
				return;
			}
			pageLoading = false;
		})();
	});
</script>

{#if pageLoading}
	<SkeletonLoader type="form" />
{:else}
	<AuditLogSection />
{/if}
