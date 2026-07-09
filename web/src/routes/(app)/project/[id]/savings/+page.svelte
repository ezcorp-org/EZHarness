<script lang="ts">
	import { page } from "$app/state";
	import { setActiveProjectId } from "$lib/stores.svelte.js";
	import SavingsDashboard from "$lib/components/savings/SavingsDashboard.svelte";
	import { savingsUrl } from "$lib/savings-format";
	import type { PageData } from "./$types";

	const { data }: { data: PageData } = $props();

	// Keep the sidebar/nav in project context (project-settings pattern).
	$effect(() => {
		setActiveProjectId(page.params.id ?? null);
	});

	let projectId = $derived(page.params.id ?? null);
</script>

<svelte:head>
	<title>Project savings · EZCorp</title>
</svelte:head>

<SavingsDashboard
	heading="Project savings"
	endpoint={(days) => savingsUrl(days, projectId)}
	initial={data.savings}
	initialRange={data.rangeDays}
/>
