<script lang="ts">
	import { fetchModes, deleteMode as apiDeleteMode, type Mode } from "$lib/api.js";
	import ModeFormModal from "$lib/components/ModeFormModal.svelte";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";

	let allModes = $state<Mode[]>([]);
	let editingMode = $state<Mode | null>(null);
	let showModeModal = $state(false);
	let modeViewMode = $state(false);

	async function loadModesList() {
		try { allModes = await fetchModes(); } catch { /* non-fatal */ }
	}

	function openCreateMode() {
		editingMode = null;
		modeViewMode = false;
		showModeModal = true;
	}

	function openViewMode(mode: Mode) {
		editingMode = mode;
		modeViewMode = true;
		showModeModal = true;
	}

	async function handleModeSaved() {
		showModeModal = false;
		editingMode = null;
		modeViewMode = false;
		await loadModesList();
	}

	async function handleDeleteMode(id: string) {
		if (!confirm("Delete this custom mode?")) return;
		try {
			await apiDeleteMode(id);
			await loadModesList();
		} catch (e: any) {
			alert(e.message || "Failed to delete mode");
		}
	}

	$effect(() => {
		loadModesList();
	});
</script>

<SettingsSection
	id="modes"
	title="Custom Modes"
	description="Behavioral presets that modify system prompt, tool availability, and model preferences per conversation."
>
	{#snippet actions()}
		<button
			onclick={openCreateMode}
			class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
		>
			Create Mode
		</button>
	{/snippet}

	{#if allModes.length === 0}
		<p class="text-xs text-[var(--color-text-muted)]">No modes yet. Create one or modes will be seeded on restart.</p>
	{:else}
		<div class="space-y-2">
			{#each allModes as mode}
				<div class="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 hover:border-[var(--color-accent)] transition-colors">
					<button
						type="button"
						onclick={() => openViewMode(mode)}
						class="flex flex-1 items-center gap-3 min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded"
						aria-label={`View ${mode.name} mode`}
					>
						<span class="text-lg">{mode.icon ?? ''}</span>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-[var(--color-text-primary)]">{mode.name}</span>
								{#if mode.builtin}
									<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">built-in</span>
								{/if}
								<!-- Built-in modes (e.g. Ez) still rely on toolRestriction for filtering;
								     keep the legacy badge for them. User-authored modes now express
								     restrictions via attached extensions instead. -->
								{#if mode.builtin && mode.toolRestriction !== "all"}
									<span class="rounded bg-amber-900/30 px-1.5 py-0.5 text-[10px] text-amber-400">{mode.toolRestriction === "read-only" ? "read-only" : "no tools"}</span>
								{/if}
								{#if (mode.extensionIds?.length ?? 0) > 0}
									<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
										{mode.extensionIds!.length} extension{mode.extensionIds!.length === 1 ? '' : 's'}
									</span>
								{/if}
							</div>
							<p class="text-xs text-[var(--color-text-secondary)] truncate">{mode.description}</p>
						</div>
					</button>
					{#if !mode.builtin}
						<button onclick={(e) => { e.stopPropagation(); handleDeleteMode(mode.id); }} class="text-xs text-red-400 hover:text-red-300 transition-colors">Delete</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</SettingsSection>

<ModeFormModal
	open={showModeModal}
	editMode={editingMode}
	viewMode={modeViewMode}
	onclose={() => { showModeModal = false; editingMode = null; modeViewMode = false; }}
	onsaved={handleModeSaved}
/>
