<script lang="ts">
	import { upsertSetting, type ProviderStatus, testLocalModelConnection, listLocalModels, type LocalModelCheckResult, type LocalModelListEntry } from "$lib/api.js";
	import ProviderSettings from "$lib/components/ProviderSettings.svelte";
	import ProviderIcon from "$lib/components/ProviderIcon.svelte";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import { PROVIDER_META } from "$lib/provider-meta.js";
	import { partitionCustomModels, type CustomModelEntry } from "$lib/settings-models.js";

	let {
		customModels = $bindable(),
		ollamaUrl = $bindable(),
	}: {
		customModels: CustomModelEntry[];
		ollamaUrl: string;
	} = $props();

	let providersExpanded = $state(true);
	let providerStatuses = $state<ProviderStatus[]>([]);

	let ollamaModels = $state<LocalModelListEntry[]>([]);
	let ollamaFetching = $state(false);
	let ollamaError = $state<string | null>(null);
	let ollamaAddingModel = $state<string | null>(null);
	let ollamaTestResults = $state<Record<string, LocalModelCheckResult | "testing">>({});
	let savingOllamaUrl = $state(false);
	let savingCustom = $state(false);

	// Locked decision 6 — ollama entries render ONLY here; the Custom
	// Models registry shows the complementary partition.
	const ollamaCustomModels = $derived(partitionCustomModels(customModels).ollama);
	const ollamaConnected = $derived(ollamaCustomModels.length > 0);

	function getStatusDotColor(p: ProviderStatus): string {
		if (!p.hasKey && !p.oauthConnected) return "bg-gray-500";
		if (p.oauthExpired) return "bg-amber-500";
		return "bg-green-500";
	}

	async function saveOllamaUrl() {
		savingOllamaUrl = true;
		try { await upsertSetting("provider:ollamaUrl", ollamaUrl); }
		finally { savingOllamaUrl = false; }
	}

	async function fetchOllamaModels() {
		const url = ollamaUrl.trim();
		if (!url) return;
		ollamaFetching = true;
		ollamaError = null;
		ollamaModels = [];
		try {
			const result = await listLocalModels(url);
			if (result.error) {
				ollamaError = result.error;
			} else if (result.models.length === 0) {
				ollamaError = "No models found — pull a model with: ollama pull <model>";
			} else {
				ollamaModels = result.models;
			}
		} catch {
			ollamaError = "Failed to connect to Ollama";
		} finally {
			ollamaFetching = false;
		}
	}

	async function addOllamaModel(modelId: string) {
		if (customModels.some((m) => m.modelId === modelId && m.provider === "ollama")) return;
		ollamaAddingModel = modelId;
		const entry = { modelId, provider: "ollama", tier: "balanced" as string, baseUrl: ollamaUrl.trim() };
		customModels = [...customModels, entry];
		savingCustom = true;
		try { await upsertSetting("provider:customModels", customModels); }
		finally { savingCustom = false; ollamaAddingModel = null; }
	}

	async function removeOllamaModel(modelId: string) {
		customModels = customModels.filter((m) => !(m.modelId === modelId && m.provider === "ollama"));
		savingCustom = true;
		try { await upsertSetting("provider:customModels", customModels); }
		finally { savingCustom = false; }
	}

	async function handleTestOllamaModel(modelId: string) {
		ollamaTestResults = { ...ollamaTestResults, [modelId]: "testing" };
		try {
			const result = await testLocalModelConnection(ollamaUrl.trim(), modelId);
			ollamaTestResults = { ...ollamaTestResults, [modelId]: result };
		} catch {
			ollamaTestResults = { ...ollamaTestResults, [modelId]: {
				reachable: false, modelAvailable: null, inferenceOk: null,
				endpointType: null, error: "Connection failed"
			}};
		}
	}
</script>

<SettingsSection id="providers" title="Providers" collapsible bind:open={providersExpanded}>
	{#snippet headerExtra()}
		{#each providerStatuses as p}
			<span class="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
				<span class="h-2 w-2 rounded-full {getStatusDotColor(p)}"></span>
				{PROVIDER_META[p.provider]?.name ?? p.provider}
			</span>
		{/each}
		<span class="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
			<span class="h-2 w-2 rounded-full {ollamaConnected ? 'bg-green-500' : 'bg-gray-500'}"></span>
			Ollama
		</span>
	{/snippet}

	<p class="mb-4 text-xs text-[var(--color-text-secondary)]">Manage your API keys and subscriptions for each LLM provider.</p>
	<ProviderSettings bind:statuses={providerStatuses} />

	<!-- Ollama (Local) -->
	<div class="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
		<div class="flex items-center gap-4">
			<ProviderIcon provider="ollama" size="lg" />
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span class="text-sm font-medium text-[var(--color-text-primary)]">Ollama (Local)</span>
					{#if ollamaConnected}
						<span class="inline-flex items-center gap-1 text-xs">
							<span class="h-2 w-2 rounded-full bg-green-500"></span>
							<span class="text-green-400">{ollamaCustomModels.length} model{ollamaCustomModels.length !== 1 ? 's' : ''}</span>
						</span>
					{:else}
						<span class="inline-flex items-center gap-1 text-xs">
							<span class="h-2 w-2 rounded-full bg-gray-500"></span>
							<span class="text-[var(--color-text-muted)]">Not configured</span>
						</span>
					{/if}
				</div>

				<!-- URL config -->
				<div class="mt-2">
					<label for="settings-ollama-base-url" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Base URL</label>
					<div class="flex items-center gap-2">
						<input
							id="settings-ollama-base-url"
							type="text"
							bind:value={ollamaUrl}
							placeholder="e.g. http://localhost:11434"
							class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
						/>
						<button
							onclick={saveOllamaUrl}
							disabled={savingOllamaUrl}
							class="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50 transition-colors"
						>
							{savingOllamaUrl ? "Saving..." : "Save URL"}
						</button>
						<button
							onclick={fetchOllamaModels}
							disabled={ollamaFetching || !ollamaUrl.trim()}
							class="rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50 transition-colors"
						>
							{ollamaFetching ? "Fetching..." : "Fetch Models"}
						</button>
					</div>
				</div>

				{#if ollamaError}
					<p class="mt-1.5 text-xs text-red-400">{ollamaError}</p>
					{#if ollamaError.includes("not reachable")}
						<p class="mt-1 text-xs text-[var(--color-text-muted)]">If running in Docker, set <code class="bg-[var(--color-surface-tertiary)] px-1 rounded">OLLAMA_HOST=0.0.0.0</code> on the host and use <code class="bg-[var(--color-surface-tertiary)] px-1 rounded">http://host.docker.internal:11434</code> as the URL.</p>
					{/if}
				{/if}

				<!-- Discovered models (not yet added) -->
				{#if ollamaModels.length > 0}
					<div class="mt-2">
						<p class="mb-1 text-xs text-[var(--color-text-secondary)]">Available models:</p>
						<div class="space-y-1">
							{#each ollamaModels as m}
								{@const alreadyAdded = ollamaCustomModels.some((cm) => cm.modelId === m.id)}
								<div class="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5">
									<span class="flex-1 text-xs text-[var(--color-text-primary)] truncate">{m.name ?? m.id}</span>
									{#if alreadyAdded}
										<span class="text-xs text-green-400">Added</span>
									{:else}
										<button
											onclick={() => addOllamaModel(m.id)}
											disabled={ollamaAddingModel === m.id}
											class="rounded-md bg-purple-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50 transition-colors"
										>
											{ollamaAddingModel === m.id ? "Adding..." : "Add"}
										</button>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Active Ollama models -->
				{#if ollamaCustomModels.length > 0}
					<div class="mt-3 border-t border-[var(--color-border)] pt-3">
						<p class="mb-1 text-xs text-[var(--color-text-secondary)]">Active models:</p>
						<div class="space-y-1">
							{#each ollamaCustomModels as cm}
								<div class="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5">
									<span class="flex-1 text-xs text-[var(--color-text-primary)] truncate">{cm.modelId}</span>
									<button
										onclick={() => handleTestOllamaModel(cm.modelId)}
										disabled={ollamaTestResults[cm.modelId] === "testing"}
										class="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
									>
										{ollamaTestResults[cm.modelId] === "testing" ? "Testing..." : "Test"}
									</button>
									{#if ollamaTestResults[cm.modelId] && ollamaTestResults[cm.modelId] !== "testing"}
										{@const r = ollamaTestResults[cm.modelId] as LocalModelCheckResult}
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
									<button
										onclick={() => removeOllamaModel(cm.modelId)}
										class="text-xs text-red-400 hover:text-red-300 transition-colors"
									>
										Remove
									</button>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
</SettingsSection>
