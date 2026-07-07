<script lang="ts">
	import { upsertSetting, testLocalModelConnection, listLocalModels, type LocalModelCheckResult, type LocalModelListEntry } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import { PROVIDER_META } from "$lib/provider-meta.js";
	import { partitionCustomModels, hasModelId, type CustomModelEntry } from "$lib/settings-models.js";

	let { customModels = $bindable() }: { customModels: CustomModelEntry[] } = $props();

	// Locked decision 6 — ollama-provider entries are managed in the
	// Ollama provider card; this registry renders the rest so no model
	// id appears twice on the merged /settings/models page.
	const registryModels = $derived(partitionCustomModels(customModels).registry);
	const hiddenOllamaCount = $derived(customModels.length - registryModels.length);

	const TIERS = ["fast", "balanced", "powerful"] as const;
	const PROVIDERS = ["anthropic", "openai", "google", "openrouter", "ollama"] as const;

	let savingCustom = $state(false);
	let newModelId = $state("");
	let newModelProvider = $state("anthropic");
	let newModelTier = $state("balanced");
	let newModelBaseUrl = $state("");
	let localTestResults = $state<Record<string, LocalModelCheckResult | "testing">>({});

	// Model discovery
	let discoveredModels = $state<LocalModelListEntry[]>([]);
	let discoveringModels = $state(false);
	let discoveryError = $state<string | null>(null);

	const isLocalProvider = $derived(newModelProvider === "ollama" || newModelBaseUrl.trim().length > 0);

	async function discoverModels() {
		const url = newModelBaseUrl.trim();
		if (!url) return;
		discoveringModels = true;
		discoveryError = null;
		discoveredModels = [];
		newModelId = "";
		try {
			const result = await listLocalModels(url);
			if (result.error) {
				discoveryError = result.error;
			} else if (result.models.length === 0) {
				discoveryError = "No models found on this endpoint";
			} else {
				discoveredModels = result.models;
				newModelId = result.models[0]!.id;
			}
		} catch {
			discoveryError = "Failed to connect to endpoint";
		} finally {
			discoveringModels = false;
		}
	}

	async function addCustomModel() {
		const id = newModelId.trim();
		if (!id) return;
		if (hasModelId(customModels, id)) return;
		const entry: CustomModelEntry = { modelId: id, provider: newModelProvider, tier: newModelTier };
		const url = newModelBaseUrl.trim();
		if (url) entry.baseUrl = url;
		customModels = [...customModels, entry];
		newModelId = "";
		newModelBaseUrl = "";
		discoveredModels = [];
		discoveryError = null;
		savingCustom = true;
		try { await upsertSetting("provider:customModels", customModels); }
		finally { savingCustom = false; }
	}

	async function handleTestLocalModel(modelId: string, baseUrl: string) {
		localTestResults = { ...localTestResults, [modelId]: "testing" };
		try {
			const result = await testLocalModelConnection(baseUrl, modelId);
			localTestResults = { ...localTestResults, [modelId]: result };
		} catch {
			localTestResults = { ...localTestResults, [modelId]: {
				reachable: false, modelAvailable: null, inferenceOk: null,
				endpointType: null, error: "Connection failed"
			}};
		}
	}

	async function removeCustomModel(modelId: string) {
		customModels = customModels.filter((m) => m.modelId !== modelId);
		savingCustom = true;
		try { await upsertSetting("provider:customModels", customModels); }
		finally { savingCustom = false; }
	}
</script>

<SettingsSection
	id="custom-models"
	title="Custom Models"
	tooltip="Register model IDs that aren't in the built-in registry. You must specify which provider serves the model and which tier it belongs to. Custom models appear alongside built-in models in the model selector and follow the same routing rules."
	description="Add model IDs not in the default registry."
>
	{#if hiddenOllamaCount > 0}
		<p class="mb-3 text-xs text-[var(--color-text-muted)]" data-testid="ollama-managed-note">
			{hiddenOllamaCount} Ollama model{hiddenOllamaCount === 1 ? " is" : "s are"} managed in the Ollama provider card above.
		</p>
	{/if}

	{#if registryModels.length > 0}
		<div class="mb-4 space-y-2">
			{#each registryModels as cm}
				<div class="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
					<span class="flex-1 text-sm text-[var(--color-text-primary)] truncate">{cm.modelId}</span>
					<span class="text-xs text-[var(--color-text-secondary)]">{cm.provider}</span>
					<span class="text-xs text-[var(--color-text-muted)]">{cm.tier}</span>
					{#if cm.baseUrl}
						<span class="text-xs text-[var(--color-text-muted)] truncate max-w-[200px]" title={cm.baseUrl}>{cm.baseUrl}</span>
						<button
							onclick={() => handleTestLocalModel(cm.modelId, cm.baseUrl!)}
							disabled={localTestResults[cm.modelId] === "testing"}
							class="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
						>
							{localTestResults[cm.modelId] === "testing" ? "Testing..." : "Test"}
						</button>
						{#if localTestResults[cm.modelId] && localTestResults[cm.modelId] !== "testing"}
							{@const r = localTestResults[cm.modelId] as LocalModelCheckResult}
							<span class="flex items-center gap-1 text-xs">
								<span title="Reachable" class={r.reachable ? "text-green-400" : "text-red-400"}>{r.reachable ? "✓" : "✗"}</span>
								{#if r.modelAvailable !== null}
									<span title="Model available" class={r.modelAvailable ? "text-green-400" : "text-red-400"}>{r.modelAvailable ? "✓" : "✗"}</span>
								{/if}
								{#if r.inferenceOk !== null}
									<span title="Inference OK" class={r.inferenceOk ? "text-green-400" : "text-red-400"}>{r.inferenceOk ? "✓" : "✗"}</span>
								{/if}
								{#if r.latencyMs !== undefined}
									<span class="text-[var(--color-text-muted)]">{r.latencyMs}ms</span>
								{/if}
							</span>
						{/if}
					{/if}
					<button
						onclick={() => removeCustomModel(cm.modelId)}
						class="text-xs text-red-400 hover:text-red-300 transition-colors"
					>
						Remove
					</button>
				</div>
			{/each}
		</div>
	{/if}

	<div class="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] items-end gap-2">
		<div>
			<label for="settings-new-model-provider" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Provider</label>
			<select
				id="settings-new-model-provider"
				bind:value={newModelProvider}
				aria-label="Model provider"
				onchange={() => { discoveredModels = []; discoveryError = null; newModelId = ""; if (newModelProvider === "ollama" && !newModelBaseUrl) newModelBaseUrl = "http://localhost:11434"; }}
				class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
			>
				{#each PROVIDERS as p}
					<option value={p}>{PROVIDER_META[p]?.name ?? p}</option>
				{/each}
			</select>
		</div>
		<div>
			<label for="settings-new-model-tier" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Tier</label>
			<select
				id="settings-new-model-tier"
				bind:value={newModelTier}
				aria-label="Model tier"
				class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
			>
				{#each TIERS as t}
					<option value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
				{/each}
			</select>
		</div>
		{#if !isLocalProvider}
			<div class="md:col-span-1"></div>
		{/if}
	</div>

	{#if isLocalProvider}
		<div class="mt-2 grid grid-cols-1 md:grid-cols-[1fr_auto] items-end gap-2">
			<div>
				<label for="settings-new-model-base-url-discovery" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Base URL</label>
				<input
					id="settings-new-model-base-url-discovery"
					type="text"
					bind:value={newModelBaseUrl}
					placeholder="e.g. http://localhost:11434"
					onchange={() => { discoveredModels = []; discoveryError = null; newModelId = ""; }}
					class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
				/>
			</div>
			<button
				onclick={discoverModels}
				disabled={discoveringModels || !newModelBaseUrl.trim()}
				class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
			>
				{discoveringModels ? "Fetching..." : "Fetch Models"}
			</button>
		</div>

		{#if discoveryError}
			<p class="mt-1 text-xs text-red-400">{discoveryError}</p>
		{/if}

		{#if discoveredModels.length > 0}
			<div class="mt-2 grid grid-cols-1 md:grid-cols-[1fr_auto] items-end gap-2">
				<div>
					<label for="settings-new-model-discovered" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Model</label>
					<select
						id="settings-new-model-discovered"
						bind:value={newModelId}
						aria-label="Discovered model"
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
					>
						{#each discoveredModels as m}
							<option value={m.id}>{m.name ?? m.id}</option>
						{/each}
					</select>
				</div>
				<button
					onclick={addCustomModel}
					disabled={savingCustom || !newModelId.trim()}
					class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
				>
					Add
				</button>
			</div>
		{/if}
	{:else}
		<div class="mt-2 grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] items-end gap-2">
			<div>
				<label for="settings-new-model-id" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Model ID</label>
				<input
					id="settings-new-model-id"
					type="text"
					bind:value={newModelId}
					placeholder="e.g. gpt-4-turbo-preview"
					class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
				/>
			</div>
			<div>
				<label for="settings-new-model-base-url" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Base URL (optional)</label>
				<input
					id="settings-new-model-base-url"
					type="text"
					bind:value={newModelBaseUrl}
					placeholder="e.g. http://localhost:11434"
					class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
				/>
			</div>
			<button
				onclick={addCustomModel}
				disabled={savingCustom || !newModelId.trim()}
				class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
			>
				Add
			</button>
		</div>
	{/if}
</SettingsSection>
