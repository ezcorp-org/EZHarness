<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { store, setActiveProjectId, refreshProjects } from "$lib/stores.svelte.js";
	import { createConversation, fetchModes, type Mode } from "$lib/api.js";
	import ChatInput from "$lib/components/ChatInput.svelte";
	import ProjectPicker from "$lib/components/ProjectPicker.svelte";
	import ModelSelector from "$lib/components/ModelSelector.svelte";
	import ThinkingLevelSelector from "$lib/components/ThinkingLevelSelector.svelte";
	import ModeSelector from "$lib/components/ModeSelector.svelte";
	import favicon from "$lib/assets/favicon.svg";
	import { restoreLastModel, persistLastModel } from "$lib/last-model.js";

	let selectedModel = $state<{ provider: string; model: string } | null>(null);
	let thinkingLevel = $state<string>("medium");
	let modelSupportsReasoning = $state(false);
	let selectedMode = $state<Mode | null>(null);
	let availableModes = $state<Mode[]>([]);
	let nudge = $state<string | null>(null);

	let projectId = $derived(
		store.activeProjectId && store.activeProjectId !== "global" ? store.activeProjectId : undefined,
	);

	onMount(() => {
		const preload = restoreLastModel(typeof localStorage !== "undefined" ? localStorage : null);
		if (preload) selectedModel = preload;

		refreshProjects();
		fetchModes().then((m) => { availableModes = m; }).catch(() => {});

		// Auto-pick a real project only for first-time visitors (no saved selection).
		// An explicit "global" choice by the user is respected — Global is a valid
		// chat target (cross-project / org-wide conversations).
		const saved = typeof localStorage !== "undefined" ? localStorage.getItem("activeProjectId") : null;
		if (saved === null) {
			fetch("/api/projects")
				.then((r) => (r.ok ? r.json() : []))
				.then((projects: Array<{ id: string }>) => {
					const first = projects.find((p) => p.id !== "global");
					if (localStorage.getItem("activeProjectId") === null && first) {
						setActiveProjectId(first.id);
					}
				})
				.catch(() => {});
		}
	});

	function handleModelChange(provider: string, model: string) {
		selectedModel = { provider, model };
		persistLastModel(typeof localStorage !== "undefined" ? localStorage : null, { provider, model });
	}

	function handleAutoselect(provider: string, model: string) {
		if (!selectedModel) handleModelChange(provider, model);
	}

	function handleReasoningChange(supports: boolean) {
		modelSupportsReasoning = supports;
	}

	async function handleSubmit(content: string) {
		if (!content.trim()) return;
		nudge = null;
		const projectForChat = store.activeProjectId || "global";
		try {
			const conv = await createConversation({ projectId: projectForChat });
			goto(`/project/${projectForChat}/chat/${conv.id}?initial=${encodeURIComponent(content)}`);
		} catch (err) {
			nudge = "Failed to start a new chat. Try again.";
			console.error(err);
		}
	}

	function handlePickerChange(ids: string[]) {
		if (ids.length === 0) return;
		setActiveProjectId(ids[0]!);
		nudge = null;
	}

	let pickerSelection = $derived(store.activeProjectId ? [store.activeProjectId] : ["global"]);
</script>

<main class="landing">
	<a href="/project/global/chat" class="wordmark-top" aria-label="Go to Global chat">
		<img src={favicon} alt="" class="wordmark-icon" />
		<span>EZCorp</span>
	</a>

	<div class="center-col">
		<div class="brand">
			<img src={favicon} alt="" class="brand-icon" />
			<h1 class="brand-text">EZCorp</h1>
		</div>
		<div class="composer">
			<ChatInput
				onsubmit={handleSubmit}
				onstop={() => {}}
				streaming={false}
				autofocus={true}
				{selectedModel}
				onmodelchange={handleModelChange}
				onautoselect={handleAutoselect}
				{thinkingLevel}
				onthinkinglevelchange={(level) => { thinkingLevel = level; }}
				{modelSupportsReasoning}
				onreasoningchange={handleReasoningChange}
				{projectId}
				toolbarPosition="hidden"
			/>
			<div class="controls-row" data-testid="landing-controls">
				<div class="control">
					<span class="control-label">Project</span>
					<ProjectPicker
						selectedIds={pickerSelection}
						onchange={handlePickerChange}
						single
					/>
				</div>
				<div class="control">
					<span class="control-label">Model</span>
					<ModelSelector
						selected={selectedModel}
						onselect={handleModelChange}
						onreasoningchange={handleReasoningChange}
						onautoselect={handleAutoselect}
					/>
				</div>
				{#if modelSupportsReasoning}
					<div class="control">
						<span class="control-label">Thinking</span>
						<ThinkingLevelSelector
							selected={thinkingLevel as any}
							onselect={(level) => { thinkingLevel = level; }}
						/>
					</div>
				{/if}
				<div class="control">
					<span class="control-label">Mode</span>
					<ModeSelector
						selected={selectedMode}
						modes={availableModes}
						onselect={(m) => { selectedMode = m; }}
					/>
				</div>
			</div>
			{#if nudge}
				<div class="nudge" role="status" data-testid="landing-nudge">{nudge}</div>
			{/if}
		</div>
	</div>
</main>

<style>
	.landing {
		position: relative;
		min-height: 100vh;
		width: 100%;
		background: var(--color-surface);
		color: var(--color-text-primary);
	}
	.wordmark-top {
		position: absolute;
		top: 1rem;
		left: 1.25rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 600;
		color: var(--color-text-primary);
		text-decoration: none;
		transition: opacity 150ms ease;
	}
	.wordmark-top:hover {
		opacity: 0.75;
	}
	.wordmark-icon {
		width: 20px;
		height: 20px;
	}
	.center-col {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1.5rem;
		padding: 2rem 1rem;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.brand-icon {
		width: 56px;
		height: 56px;
	}
	.brand-text {
		margin: 0;
		font-size: 3rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--color-text-primary);
		line-height: 1;
	}
	.composer {
		width: 100%;
		max-width: 720px;
		min-width: 0;
	}
	.controls-row {
		margin-top: 0.75rem;
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: center;
		gap: 0.75rem 1rem;
	}
	.control {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.control-label {
		font-size: 10px;
		line-height: 1;
		margin-bottom: 2px;
		color: var(--color-text-muted);
	}
	.nudge {
		margin-top: 0.75rem;
		text-align: center;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}
</style>
