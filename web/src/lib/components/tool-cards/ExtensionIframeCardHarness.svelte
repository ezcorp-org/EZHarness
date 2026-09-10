<script lang="ts">
	import ExtensionIframeCard from "./ExtensionIframeCard.svelte";
	import type { ToolCallState } from "$lib/stores.svelte.js";

	let {
		toolCall,
		conversationId = "conversation-1",
		iframeSrc = "/api/extensions/weather/preview",
		extensionName = "weather",
		mode = "inline",
	}: {
		toolCall: ToolCallState;
		conversationId?: string;
		iframeSrc?: string;
		extensionName?: string;
		mode?: "inline" | "dock";
	} = $props();
</script>

<ExtensionIframeCard {toolCall} {conversationId} {iframeSrc} {extensionName} {mode} ariaLabel="Weather preview">
	{#snippet sidebar({ postEvent, busy })}
		<button
			type="button"
			data-testid="post-preview-event"
			disabled={busy}
			onclick={() => void postEvent("refresh", { location: "Boston" }).catch(() => {})}
		>
			{busy ? "Sending" : "Refresh"}
		</button>
	{/snippet}
</ExtensionIframeCard>
