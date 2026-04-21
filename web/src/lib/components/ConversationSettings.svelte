<script lang="ts">
	import { fetchSettings, upsertSetting, type Conversation } from "$lib/api.js";
	import SwipeDrawer from "./SwipeDrawer.svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";

	let {
		conversation,
		projectId,
		open = false,
		onclose,
		onsave,
	}: {
		conversation: Conversation;
		projectId: string;
		open: boolean;
		onclose: () => void;
		onsave: (systemPrompt: string) => void;
	} = $props();

	let systemPrompt = $state("");
	let saving = $state(false);

	// Prompt preview state
	let activeLevel = $state<string>("none");
	let previewPrompt = $state<string>("");
	let loadingPreview = $state(false);

	// Sync local prompt with conversation prop
	$effect(() => {
		if (open) {
			systemPrompt = conversation.systemPrompt ?? "";
			loadPromptPreview();
		}
	});

	async function loadPromptPreview() {
		loadingPreview = true;
		try {
			const settings = await fetchSettings();
			const projectKey = `project:${projectId}:systemPrompt`;
			const globalKey = "global:systemPrompt";

			const convPrompt = conversation.systemPrompt;
			const projectPrompt = settings[projectKey] as string | undefined;
			const globalPrompt = settings[globalKey] as string | undefined;

			if (convPrompt) {
				activeLevel = "conversation-level";
				previewPrompt = convPrompt;
			} else if (projectPrompt) {
				activeLevel = "project-level";
				previewPrompt = projectPrompt;
			} else if (globalPrompt) {
				activeLevel = "global";
				previewPrompt = globalPrompt;
			} else {
				activeLevel = "none";
				previewPrompt = "";
			}
		} catch {
			activeLevel = "error";
			previewPrompt = "Failed to load prompt preview";
		}
		loadingPreview = false;
	}

	async function handleSave() {
		saving = true;
		try {
			onsave(systemPrompt);
		} finally {
			saving = false;
		}
	}

</script>

<SwipeDrawer {open} side="right" width="w-full md:max-w-md" {onclose} ariaLabel="Conversation settings">
	<div class="flex h-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-xl">
		<!-- Header -->
		<div class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
			<h2 class="text-sm font-semibold text-[var(--color-text-primary)]">Conversation Settings</h2>
			<button
				onclick={onclose}
				class="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>

		<!-- Content -->
		<div class="flex-1 overflow-y-auto p-4 space-y-6">
			<!-- Conversation Instructions -->
			<div>
				<label for="conv-prompt" class="flex items-center gap-2 text-xs font-medium text-[var(--color-text-secondary)] mb-1">
					Conversation Instructions
					<InfoTooltip text="A system prompt specific to this conversation. This is the highest priority level and overrides both project-level and global instructions. Only this conversation is affected." />
				</label>
				{#if conversation.agentConfigId}
					<p class="text-[11px] text-[var(--color-text-muted)] mb-2">
						System prompt is managed by the agent persona and cannot be edited here.
					</p>
					<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/50 px-3 py-2 text-sm text-[var(--color-text-secondary)] whitespace-pre-wrap max-h-48 overflow-y-auto">
						{conversation.systemPrompt ?? "(none)"}
					</div>
					<p class="mt-1 text-[10px] text-[var(--color-text-muted)]">
						Managed by agent persona — edit via the agent config.
					</p>
				{:else}
					<p class="text-[11px] text-[var(--color-text-muted)] mb-2">
						Custom system prompt for this conversation. Overrides project and global instructions.
					</p>
					<textarea
						id="conv-prompt"
						bind:value={systemPrompt}
						rows={6}
						class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none resize-y"
						placeholder="e.g. You are a helpful coding assistant..."
					></textarea>
					<button
						onclick={handleSave}
						disabled={saving}
						class="mt-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
					>
						{saving ? "Saving..." : "Save"}
					</button>
				{/if}
			</div>

			<!-- Active System Prompt Preview -->
			<div>
				<div class="flex items-center gap-2 mb-1">
					<span class="text-xs font-medium text-[var(--color-text-secondary)] flex items-center gap-2">Active System Prompt <InfoTooltip text="Shows which system prompt the AI is actually using for this conversation. The priority order is: conversation-level > project-level > global. If none are set, no system prompt is applied." /></span>
					{#if loadingPreview}
						<span class="text-[10px] text-[var(--color-text-muted)]">Loading...</span>
					{:else if activeLevel === "none"}
						<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">No system prompt set</span>
					{:else}
						<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-blue-400">
							Using: {activeLevel}
						</span>
					{/if}
				</div>
				<p class="text-[11px] text-[var(--color-text-muted)] mb-2">
					Read-only preview of what the AI actually sees.
				</p>
				{#if previewPrompt}
					<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/50 px-3 py-2 text-sm text-[var(--color-text-secondary)] whitespace-pre-wrap max-h-48 overflow-y-auto">
						{previewPrompt}
					</div>
				{:else if !loadingPreview}
					<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/50 px-3 py-2 text-sm text-[var(--color-text-muted)] italic">
						No system prompt configured at any level.
					</div>
				{/if}
			</div>
		</div>
	</div>
</SwipeDrawer>
