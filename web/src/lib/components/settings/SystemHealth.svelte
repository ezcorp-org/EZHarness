<script lang="ts">
	import { onMount } from "svelte";
	import { statusColor, statusLabel, type SubsystemStatus } from "$lib/system-health-logic";

	interface HealthDetail {
		status: "healthy" | "degraded";
		db: { status: "up" | "down" };
		embeddings: { status: "ready" | "not_initialized" };
		providers: Record<string, { status: "configured" | "not_configured" }>;
	}

	let health = $state<HealthDetail | null>(null);
	let loading = $state(true);
	let error = $state(false);

	async function fetchHealth() {
		try {
			const res = await fetch("/api/health?detail=true");
			if (res.status === 401) {
				error = true;
				return;
			}
			if (res.ok) {
				health = await res.json();
			}
		} catch {
			error = true;
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchHealth();
		const interval = setInterval(fetchHealth, 30000);
		return () => clearInterval(interval);
	});
</script>

{#if loading}
	<p class="text-sm text-[var(--color-text-secondary)]">Loading health status...</p>
{:else if error}
	<p class="text-sm text-[var(--color-text-secondary)]">Unable to load health status.</p>
{:else if health}
	<div class="space-y-3">
		<!-- Overall -->
		<div class="flex items-center gap-2">
			<span class="h-2.5 w-2.5 rounded-full {health.status === 'healthy' ? 'bg-green-500' : 'bg-red-500'}"></span>
			<span class="text-sm font-medium text-[var(--color-text-primary)] capitalize">{health.status}</span>
		</div>

		<!-- Database -->
		<div class="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
			<span class="text-sm text-[var(--color-text-secondary)]">Database</span>
			<div class="flex items-center gap-2">
				<span class="h-2 w-2 rounded-full {statusColor(health.db.status)}"></span>
				<span class="text-xs text-[var(--color-text-muted)] capitalize">{statusLabel(health.db.status)}</span>
			</div>
		</div>

		<!-- Embeddings -->
		<div class="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
			<span class="text-sm text-[var(--color-text-secondary)]">Embeddings</span>
			<div class="flex items-center gap-2">
				<span class="h-2 w-2 rounded-full {statusColor(health.embeddings.status)}"></span>
				<span class="text-xs text-[var(--color-text-muted)] capitalize">{statusLabel(health.embeddings.status)}</span>
			</div>
		</div>

		<!-- Providers -->
		{#if health.providers && Object.keys(health.providers).length > 0}
			{#each Object.entries(health.providers) as [name, info]}
				<div class="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
					<span class="text-sm text-[var(--color-text-secondary)] capitalize">{name}</span>
					<div class="flex items-center gap-2">
						<span class="h-2 w-2 rounded-full {statusColor(info.status)}"></span>
						<span class="text-xs text-[var(--color-text-muted)] capitalize">{statusLabel(info.status)}</span>
					</div>
				</div>
			{/each}
		{/if}
	</div>
{/if}
