<script lang="ts">
	import { inlineToolStore } from "$lib/inline-tool-store.svelte";
	import ToolCardRouter from "$lib/components/tool-cards/ToolCardRouter.svelte";
	let { conversationId }: { conversationId: string } = $props();
	const calls = $derived(inlineToolStore.getByConversation(conversationId));
</script>

{#each calls as call (call.id)}
	<ToolCardRouter toolCall={{ ...call, extensionId: call.extensionName, status: call.status === "pending" ? "running" : call.status, startedAt: call.startedAt ?? 0 }} {conversationId} />
{/each}
