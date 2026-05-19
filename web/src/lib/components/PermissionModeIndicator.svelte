<script lang="ts">
	import { onMount } from "svelte";
	import {
		type PermissionMode,
		PERMISSION_MODES,
		DEFAULT_PERMISSION_MODE,
		modeToColor,
		modeToLabel,
		modeToDescription,
	} from "$lib/permission-mode.js";

	let { projectId, conversationId, onmodechange }: { projectId: string; conversationId?: string; onmodechange?: (mode: PermissionMode) => void } = $props();

	let currentMode = $state<PermissionMode>(DEFAULT_PERMISSION_MODE);
	let dropdownOpen = $state(false);
	let buttonEl: HTMLButtonElement | undefined = $state();

	onMount(() => {
		fetch(`/api/projects/${projectId}/tool-permission-mode`)
			.then(r => r.ok ? r.json() : null)
			.then(d => { if (d?.mode) { currentMode = d.mode; onmodechange?.(d.mode); } })
			.catch(() => {});
	});

	function selectMode(mode: PermissionMode) {
		currentMode = mode;
		dropdownOpen = false;
		onmodechange?.(mode);
		fetch(`/api/projects/${projectId}/tool-permission-mode`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode, conversationId }),
		}).catch(() => {});
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") dropdownOpen = false;
	}
</script>

<svelte:window onkeydown={dropdownOpen ? handleKeydown : undefined} />

<div class="relative">
	<button
		bind:this={buttonEl}
		onclick={() => (dropdownOpen = !dropdownOpen)}
		class="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors {dropdownOpen ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : ''}"
		aria-label="Permission mode: {modeToLabel(currentMode)}"
	>
		<span class="inline-block h-2 w-2 rounded-full {modeToColor(currentMode)}"></span>
		<span>{modeToLabel(currentMode)}</span>
	</button>

	{#if dropdownOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="fixed inset-0 z-40" onclick={() => (dropdownOpen = false)} onkeydown={() => {}}></div>
		<div class="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg overflow-hidden">
			{#each PERMISSION_MODES as mode}
				<button
					onclick={() => selectMode(mode)}
					class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-tertiary)] transition-colors {mode === currentMode ? 'bg-[var(--color-surface-tertiary)]/50' : ''}"
				>
					<span class="inline-block h-2 w-2 shrink-0 rounded-full {modeToColor(mode)}"></span>
					<div>
						<span class="font-medium text-[var(--color-text-primary)]">{modeToLabel(mode)}</span>
						<p class="text-[var(--color-text-muted)] mt-0.5">{modeToDescription(mode)}</p>
					</div>
				</button>
			{/each}
		</div>
	{/if}
</div>
