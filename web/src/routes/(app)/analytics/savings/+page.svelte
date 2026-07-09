<script lang="ts">
	import SavingsDashboard from "$lib/components/savings/SavingsDashboard.svelte";
	import { savingsUrl } from "$lib/savings-format";
	import type { PageData } from "./$types";

	const { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Savings · EZCorp</title>
</svelte:head>

<SavingsDashboard
	heading="Savings"
	endpoint={(days) => savingsUrl(days)}
	initial={data.savings}
	initialRange={data.rangeDays}
/>
