<script lang="ts">
	import { store, setTaskSnapshot, type TaskSnapshot } from "$lib/stores.svelte.js";
	import { agentColor } from "$lib/agent-color.js";

	let {
		open,
		anchor,
		conversationId,
		taskId,
		onclose,
	}: {
		open: boolean;
		anchor?: HTMLElement;
		conversationId: string;
		taskId: string;
		onclose: () => void;
	} = $props();

	let search = $state("");
	let loading = $state(false);
	let panelEl = $state<HTMLElement | null>(null);
	let searchInputEl = $state<HTMLInputElement | null>(null);

	// Focus the search input when the picker opens
	$effect(() => {
		if (open && searchInputEl) {
			requestAnimationFrame(() => searchInputEl?.focus());
		}
	});

	// Position the picker fixed over everything, anchored to the "+" button.
	let posStyle = $state("position:fixed;top:-9999px;left:-9999px");
	$effect(() => {
		if (!open || !anchor) return;
		// Read rect after the DOM has settled
		requestAnimationFrame(() => {
			if (!anchor) return;
			const rect = anchor.getBoundingClientRect();
			posStyle = `position:fixed;right:${Math.round(window.innerWidth - rect.right)}px;bottom:${Math.round(window.innerHeight - rect.top + 4)}px`;
		});
	});

	let configs = $derived(store.agentConfigs);

	let teams = $derived(
		configs.filter((c) => {
			const refs = c.references;
			return Array.isArray(refs?.members) && refs.members.length > 0;
		})
	);

	let agents = $derived(
		configs.filter((c) => {
			const refs = c.references;
			return !Array.isArray(refs?.members) || refs.members.length === 0;
		})
	);

	let query = $derived(search.toLowerCase().trim());

	let filteredTeams = $derived(
		query ? teams.filter((c) => c.name.toLowerCase().includes(query)) : teams
	);

	let filteredAgents = $derived(
		query ? agents.filter((c) => c.name.toLowerCase().includes(query)) : agents
	);

	let hasResults = $derived(filteredTeams.length > 0 || filteredAgents.length > 0);

	async function assign(agentConfigId: string) {
		loading = true;
		try {
			const res = await fetch(
				`/api/conversations/${conversationId}/tasks/${taskId}/assign`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ agentConfigId }),
				}
			);
			if (res.ok) {
				const data = await res.json();
				if (data.snapshot) {
					setTaskSnapshot(data.snapshot as TaskSnapshot);
				}
				onclose();
			}
		} finally {
			loading = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.stopPropagation();
			onclose();
		}
	}

	function handleClickOutside(e: MouseEvent) {
		if (panelEl && !panelEl.contains(e.target as Node)) {
			onclose();
		}
	}

	$effect(() => {
		if (!open) return;
		// Reset search when opening
		search = "";
		document.addEventListener("mousedown", handleClickOutside, true);
		document.addEventListener("keydown", handleKeydown, true);
		return () => {
			document.removeEventListener("mousedown", handleClickOutside, true);
			document.removeEventListener("keydown", handleKeydown, true);
		};
	});
</script>

{#if open}
	<div
		bind:this={panelEl}
		class="z-50 w-56 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] shadow-xl"
		style={posStyle}
	>
		<!-- Search -->
		<div class="border-b border-[var(--color-border)] p-1.5">
				<input
				bind:this={searchInputEl}
				type="text"
				bind:value={search}
				placeholder="Search agents..."
				class="w-full rounded-md bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:ring-1 focus:ring-blue-500/50"
			/>
		</div>

		<div class="max-h-60 overflow-y-auto">
			{#if !hasResults}
				<div class="px-3 py-4 text-center text-[10px] text-[var(--color-text-muted)]">
					No agents found
				</div>
			{/if}

			<!-- Teams section -->
			{#if filteredTeams.length > 0}
				<div class="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
					Teams
				</div>
				{#each filteredTeams as config (config.id)}
					{@const color = agentColor(config.name)}
					<button
						type="button"
						disabled={loading}
						onclick={() => assign(config.id)}
						class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-secondary)] disabled:opacity-50"
					>
						<span class="h-1.5 w-1.5 shrink-0 rounded-full" style:background-color={color}></span>
						<span class="flex-1 truncate text-[var(--color-text-primary)]">{config.name}</span>
						<span class="shrink-0 rounded-full border border-indigo-500/30 bg-indigo-500/20 px-1 py-0.5 text-[8px] font-medium text-indigo-300">
							team
						</span>
					</button>
				{/each}
			{/if}

			<!-- Agents section -->
			{#if filteredAgents.length > 0}
				<div class="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
					Agents
				</div>
				{#each filteredAgents as config (config.id)}
					{@const color = agentColor(config.name)}
					<button
						type="button"
						disabled={loading}
						onclick={() => assign(config.id)}
						class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-secondary)] disabled:opacity-50"
					>
						<span class="h-1.5 w-1.5 shrink-0 rounded-full" style:background-color={color}></span>
						<span class="flex-1 truncate text-[var(--color-text-primary)]">{config.name}</span>
					</button>
				{/each}
			{/if}
		</div>
	</div>
{/if}
