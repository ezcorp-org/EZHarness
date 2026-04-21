<script lang="ts">
	import { store, refreshSettings } from "$lib/stores.svelte.js";
	import { upsertSetting, deleteSetting } from "$lib/api.js";
	import { inputClass } from "$lib/styles.js";

	let entries = $state<[string, string][]>([]);
	let saving = $state(false);
	let newKey = $state("");
	let newValue = $state("");

	// Sync from store
	$effect(() => {
		entries = Object.entries(store.settings).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
	});

	async function saveSetting(key: string, value: string) {
		saving = true;
		try {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch {
				parsed = value;
			}
			await upsertSetting(key, parsed);
			refreshSettings();
		} finally {
			saving = false;
		}
	}

	async function removeSetting(key: string) {
		await deleteSetting(key);
		refreshSettings();
	}

	async function addSetting() {
		if (!newKey.trim()) return;
		await saveSetting(newKey.trim(), newValue);
		newKey = "";
		newValue = "";
	}

</script>

<div class="space-y-4">
	{#each entries as entry}
		<div class="flex items-center gap-2">
			<span class="w-1/3 truncate text-sm font-medium text-[var(--color-text-secondary)]">{entry[0]}</span>
			<input
				type="text"
				bind:value={entry[1]}
				class="{inputClass} flex-1"
			/>
			<button
				onclick={() => saveSetting(entry[0], entry[1])}
				disabled={saving}
				class="shrink-0 rounded-md bg-[var(--color-surface-tertiary)] px-3 py-2 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
			>
				Save
			</button>
			<button
				onclick={() => removeSetting(entry[0])}
				class="shrink-0 rounded-md px-2 py-2 text-[var(--color-text-muted)] hover:text-red-400"
			>
				&times;
			</button>
		</div>
	{/each}

	<div class="flex items-end gap-2 border-t border-[var(--color-border)] pt-4">
		<div class="w-1/3">
			<label for="new-key" class="mb-1 block text-xs text-[var(--color-text-muted)]">Key</label>
			<input id="new-key" type="text" bind:value={newKey} class={inputClass} placeholder="default_provider" />
		</div>
		<div class="flex-1">
			<label for="new-value" class="mb-1 block text-xs text-[var(--color-text-muted)]">Value</label>
			<input id="new-value" type="text" bind:value={newValue} class={inputClass} placeholder="anthropic" />
		</div>
		<button
			onclick={addSetting}
			class="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
		>
			Add
		</button>
	</div>
</div>
