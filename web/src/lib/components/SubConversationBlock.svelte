<script lang="ts">
	import { untrack } from "svelte";
	import { slide } from "svelte/transition";
	import { agentColor } from "$lib/agent-color";
	import { subConversationStore } from "$lib/sub-conversation-store.svelte.js";
	import type { SubConvoMessage } from "$lib/sub-conversation-store.svelte.js";
	import SubConvoInput from "./SubConvoInput.svelte";

	let {
		conversation,
		messages = [],
		isActive = false,
		onreturn,
		onsend,
		messageCount,
		lastMessagePreview,
	}: {
		conversation: { id: string; agentName: string; agentConfigId: string };
		messages: SubConvoMessage[];
		isActive: boolean;
		onreturn: () => void;
		onsend?: (text: string) => void;
		messageCount?: number;
		lastMessagePreview?: string | null;
	} = $props();

	let collapsed = $state(untrack(() => !isActive));
	let color = $derived(agentColor(conversation.agentName));
	let lazyMessages = $state<SubConvoMessage[]>([]);
	let loadingMessages = $state(false);
	let hasLoadedLazy = $state(false);

	let displayMessages = $derived(isActive ? messages : (hasLoadedLazy ? lazyMessages : messages));

	let summaryText = $derived.by(() => {
		if (messageCount != null && lastMessagePreview) {
			return `${messageCount} messages -- "${lastMessagePreview}"`;
		}
		if (displayMessages.length === 0) return "No messages yet";
		const last = displayMessages[displayMessages.length - 1]!;
		const text = last.content;
		return text.length > 80 ? text.slice(0, 80) + "..." : text;
	});

	async function toggleCollapse() {
		if (isActive) return;
		collapsed = !collapsed;
		if (!collapsed && !hasLoadedLazy && !isActive) {
			await fetchLazyMessages();
		}
	}

	async function fetchLazyMessages() {
		if (loadingMessages || hasLoadedLazy) return;
		loadingMessages = true;
		try {
			const res = await fetch(`/api/conversations/${conversation.id}/messages?all=true`);
			if (res.ok) {
				const data = await res.json();
				lazyMessages = (data as any[]).map((m: any) => ({
					id: m.id,
					role: m.role,
					content: m.content,
					createdAt: new Date(m.createdAt),
				}));
				hasLoadedLazy = true;
			}
		} catch { /* silent */ }
		loadingMessages = false;
	}
</script>

<div
	class="sub-convo-block ml-6 rounded-md border-l-4 bg-[var(--color-surface-secondary,#1e1e2e)]"
	style:border-color={color}
>
	<!-- Header -->
	<button
		class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-[var(--color-text-primary,#e0e0e0)] hover:bg-white/5"
		onclick={toggleCollapse}
	>
		<span data-testid="sub-convo-agent-name" class="sub-convo-agent-name" style:color={color}>@{conversation.agentName}</span>
		{#if collapsed}
			<span class="sub-convo-summary truncate text-xs text-[var(--color-text-muted,#888)]">{summaryText}</span>
		{/if}
	</button>

	<!-- Expanded content -->
	{#if !collapsed}
		<div transition:slide={{ duration: 200 }}>
			<div class="sub-convo-messages max-h-96 overflow-y-auto p-3 space-y-2">
				{#if loadingMessages}
					<div class="text-xs text-[var(--color-text-muted,#888)]">Loading messages...</div>
				{:else}
					{#each displayMessages as msg (msg.id)}
						<div class="text-sm {msg.role === 'user' ? 'text-[var(--color-text-muted,#aaa)]' : 'text-[var(--color-text-primary,#e0e0e0)]'}">
							<span class="text-xs font-semibold opacity-60">{msg.role === 'user' ? 'You' : conversation.agentName}:</span>
							{msg.content}
						</div>
					{/each}
				{/if}
			</div>

			{#if isActive || hasLoadedLazy}
				<div class="border-t border-white/10 p-2">
					<SubConvoInput
						conversationId={conversation.id}
						onSend={(text) => onsend?.(text)}
					/>
					<div class="mt-2 flex justify-end">
						{#if isActive}
							<button
								class="sub-convo-return rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed"
								disabled={subConversationStore.isStreaming}
								onclick={onreturn}
							>
								Return to main
							</button>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
