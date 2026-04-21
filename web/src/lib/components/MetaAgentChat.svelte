<script lang="ts">
	import { onMount } from "svelte";
	import ChatInput from "./ChatInput.svelte";
	import { fetchModes, type Mode } from "$lib/api.js";
	import { restoreLastModel, persistLastModel } from "$lib/last-model";

	type Message = { role: "user" | "assistant"; content: string };

	let {
		onconfig,
	}: {
		onconfig: (config: Record<string, unknown>) => void;
	} = $props();

	let messages = $state<Message[]>([]);
	let loading = $state(false);
	let errorMsg = $state("");

	let selectedModel = $state<{ provider: string; model: string } | null>(null);
	let thinkingLevel = $state<string>(
		typeof localStorage !== "undefined" ? (localStorage.getItem("ezcorp-thinking-level") ?? "medium") : "medium",
	);
	let modelSupportsReasoning = $state(false);
	let availableModes = $state<Mode[]>([]);
	let selectedMode = $state<Mode | null>(null);

	$effect(() => {
		if (messages.length === 0) {
			messages = [
				{
					role: "assistant",
					content:
						"Hi! I'll help you create an agent persona. To start, what should this agent be called, and what's its main purpose?",
				},
			];
		}
	});

	onMount(() => {
		if (typeof localStorage !== "undefined") {
			const last = restoreLastModel(localStorage);
			if (last) selectedModel = last;
		}
		fetchModes().then((m) => { availableModes = m; }).catch(() => {});
	});

	async function sendMessage(content: string) {
		const trimmed = content.trim();
		if (!trimmed || loading) return;
		errorMsg = "";

		messages = [...messages, { role: "user", content: trimmed }];
		loading = true;

		try {
			const res = await fetch("/api/agent-configs/generate", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					messages: messages.map((m) => ({ role: m.role, content: m.content })),
					provider: selectedModel?.provider,
					model: selectedModel?.model,
					thinkingLevel: modelSupportsReasoning ? thinkingLevel : undefined,
					modeId: selectedMode?.id,
				}),
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: "Request failed" }));
				throw new Error((err as { error?: string }).error ?? `${res.status} ${res.statusText}`);
			}

			const data = (await res.json()) as { text: string; config: Record<string, unknown> | null };
			messages = [...messages, { role: "assistant", content: data.text }];

			if (data.config) {
				onconfig(data.config);
			}
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to get response";
			messages = messages.slice(0, -1);
		} finally {
			loading = false;
		}
	}

	function handleModelChange(provider: string, model: string) {
		selectedModel = { provider, model };
		if (typeof localStorage !== "undefined") {
			persistLastModel(localStorage, { provider, model });
		}
	}

	function handleModelAutoSelect(provider: string, model: string) {
		if (selectedModel) return;
		selectedModel = { provider, model };
	}

	function handleThinkingLevelChange(level: string) {
		thinkingLevel = level;
		if (typeof localStorage !== "undefined") {
			localStorage.setItem("ezcorp-thinking-level", level);
		}
	}

	function handleReasoningChange(reasoning: boolean) {
		modelSupportsReasoning = reasoning;
	}

	function handleModeChange(mode: Mode | null) {
		selectedMode = mode;
		if (mode?.preferredThinkingLevel && modelSupportsReasoning) {
			thinkingLevel = mode.preferredThinkingLevel;
			if (typeof localStorage !== "undefined") {
				localStorage.setItem("ezcorp-thinking-level", mode.preferredThinkingLevel);
			}
		}
	}
</script>

<div class="flex h-full flex-col">
	<!-- Message list -->
	<div class="flex-1 space-y-3 overflow-y-auto px-2 py-3">
		{#each messages as msg}
			<div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
				<div
					class="max-w-[85%] rounded-lg px-4 py-2.5 text-sm {msg.role === 'user'
						? 'bg-blue-600 text-white'
						: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]'}"
				>
					{msg.content}
				</div>
			</div>
		{/each}
		{#if loading}
			<div class="flex justify-start">
				<div class="rounded-lg bg-[var(--color-surface-tertiary)] px-4 py-2.5 text-sm text-[var(--color-text-secondary)]">Thinking...</div>
			</div>
		{/if}
	</div>

	{#if errorMsg}
		<p class="mb-2 text-sm text-red-400">{errorMsg}</p>
	{/if}

	<ChatInput
		onsubmit={sendMessage}
		onstop={() => {}}
		streaming={false}
		{selectedModel}
		onmodelchange={handleModelChange}
		onautoselect={handleModelAutoSelect}
		{thinkingLevel}
		onthinkinglevelchange={handleThinkingLevelChange}
		{modelSupportsReasoning}
		onreasoningchange={handleReasoningChange}
		{selectedMode}
		modes={availableModes}
		onmodechange={handleModeChange}
	/>
</div>
