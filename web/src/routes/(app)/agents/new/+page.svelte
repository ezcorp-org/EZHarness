<script lang="ts">
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { createAgentConfig, fetchAgentConfigs, type AgentConfig } from "$lib/api.js";
	import { refreshAgentConfigs } from "$lib/stores.svelte.js";
	import AgentConfigForm from "$lib/components/AgentConfigForm.svelte";
	import TeamBuilderForm from "$lib/components/TeamBuilderForm.svelte";
	import MetaAgentChat from "$lib/components/MetaAgentChat.svelte";
	import AgentPrefillBanner from "$lib/components/ez/AgentPrefillBanner.svelte";
	import { getDraft, consumeDraft } from "$lib/ez/api.js";
	import { onMount } from "svelte";

	type Tab = "describe" | "configure";
	type Mode = "chat" | "review";

	let activeTab = $state<Tab>("describe");
	let mode = $state<Mode>("chat");
	let generatedConfig = $state<Record<string, unknown> | null>(null);
	let existingConfigs = $state<AgentConfig[]>([]);

	let submitting = $state(false);
	let errorMsg = $state("");

	// Ez prefill state — populated by `?prefill=<draftId>` or `fill_form`.
	let prefillData = $state<Record<string, unknown> | null>(null);
	/** Re-mount key so AgentConfigForm picks up new `initial` props. */
	let prefillKey = $state(0);
	let bannerState = $state<"hidden" | "active" | "expired">("hidden");
	let consumedDraftId = $state<string | null>(null);

	let isTeamMode = $derived(page.url.searchParams.get("type") === "team");

	onMount(async () => {
		try { existingConfigs = await fetchAgentConfigs(); } catch { /* non-fatal */ }
	});

	// Hydrate from `?prefill=<draftId>` on mount and on draft id change.
	let lastFetchedPrefill = "";
	$effect(() => {
		const id = page.url.searchParams.get("prefill");
		if (!id || id === lastFetchedPrefill) return;
		lastFetchedPrefill = id;
		consumedDraftId = id;
		void hydrateFromDraft(id);
	});

	async function hydrateFromDraft(id: string) {
		try {
			const draft = await getDraft(id);
			if (!draft || draft.consumed || isExpired(draft.expiresAt)) {
				bannerState = "expired";
				return;
			}
			prefillData = { ...(draft.payload ?? {}) };
			prefillKey++;
			// The prefilled form lives under the Configure tab; auto-flip
			// so the user lands on the populated form immediately.
			activeTab = "configure";
			bannerState = "active";
		} catch {
			bannerState = "expired";
		}
	}

	function isExpired(expiresAt: string | Date | null | undefined): boolean {
		if (!expiresAt) return false;
		const t = typeof expiresAt === "string" ? Date.parse(expiresAt) : new Date(expiresAt).getTime();
		return Number.isFinite(t) && t < Date.now();
	}

	function dismissBanner() { bannerState = "hidden"; }

	function handleConfigGenerated(config: Record<string, unknown>) {
		generatedConfig = config;
		mode = "review";
	}

	function handleBackToChat() {
		mode = "chat";
	}

	async function handleSubmit(data: Record<string, unknown>) {
		submitting = true;
		errorMsg = "";
		try {
			await createAgentConfig(data as Parameters<typeof createAgentConfig>[0]);
			if (consumedDraftId) {
				try { await consumeDraft(consumedDraftId); } catch { /* swallow */ }
			}
			refreshAgentConfigs();
			goto("/agents");
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to create agent";
		} finally {
			submitting = false;
		}
	}

</script>

<div class="space-y-6">
	<div>
		<a href="/agents" class="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
			>&larr; Back to Agents</a
		>
	</div>

	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		{#if bannerState === "active"}
			<AgentPrefillBanner state="active" ondismiss={dismissBanner} />
		{:else if bannerState === "expired"}
			<AgentPrefillBanner state="expired" ondismiss={dismissBanner} />
		{/if}

		{#if isTeamMode}
			<div class="mb-6">
				<h2 class="text-2xl font-bold text-[var(--color-text-primary)]">New Team</h2>
			</div>
			<TeamBuilderForm agentConfigs={existingConfigs} onsubmit={handleSubmit} {submitting} />
		{:else}
			<div class="mb-6 flex items-center justify-between">
				<h2 class="text-2xl font-bold text-[var(--color-text-primary)]">
					{mode === "review" ? "Review Agent" : "New Agent"}
				</h2>

				{#if mode === "chat"}
					<div class="flex rounded-lg border border-[var(--color-border)] p-0.5">
						<button
							onclick={() => (activeTab = "describe")}
							class="rounded-md px-4 py-1.5 text-sm font-medium transition-colors {activeTab === 'describe'
								? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]'
								: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
						>
							Describe
						</button>
						<button
							onclick={() => (activeTab = "configure")}
							class="rounded-md px-4 py-1.5 text-sm font-medium transition-colors {activeTab === 'configure'
								? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]'
								: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
						>
							Configure
						</button>
					</div>
				{/if}
			</div>

			{#if mode === "review"}
				<div class="mb-4 rounded-md border border-blue-700 bg-blue-900/30 px-4 py-3 text-sm text-blue-300">
					Agent created from your description — review and edit before saving.
				</div>
				<AgentConfigForm initial={generatedConfig ?? {}} onsubmit={handleSubmit} {submitting} />
				<button onclick={handleBackToChat} class="mt-3 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
					&larr; Back to conversation
				</button>
			{:else if activeTab === "describe"}
				<div class="h-[calc(100vh-220px)] min-h-[500px] w-full">
					<MetaAgentChat onconfig={handleConfigGenerated} />
				</div>
			{:else}
				{#key prefillKey}
					<AgentConfigForm initial={prefillData ?? {}} onsubmit={handleSubmit} {submitting} />
				{/key}
			{/if}
		{/if}

		{#if errorMsg}
			<p class="mt-3 text-sm text-red-400">{errorMsg}</p>
		{/if}
	</div>
</div>
