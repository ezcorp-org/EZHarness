<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { getCardComponentName } from "./utils.js";
	import PermissionGate from "./PermissionGate.svelte";
	import TerminalCard from "./TerminalCard.svelte";
	import DiffCard from "./DiffCard.svelte";
	import SearchResultsCard from "./SearchResultsCard.svelte";
	import TaskListCard from "./TaskListCard.svelte";
	import TaskDetailCard from "./TaskDetailCard.svelte";
	import DefaultCard from "./DefaultCard.svelte";

	let { toolCall, conversationId, messageId, onsendmessage }: { toolCall: ToolCallState; conversationId?: string; messageId?: string; onsendmessage?: (message: string) => void } = $props();

	let cardName = $derived(getCardComponentName(toolCall.cardType, toolCall.permissionPending));
</script>

{#if cardName === 'PermissionGate'}
	<PermissionGate {toolCall} />
{:else if cardName === 'TerminalCard'}
	<TerminalCard {toolCall} />
{:else if cardName === 'DiffCard'}
	<DiffCard {toolCall} />
{:else if cardName === 'SearchResultsCard'}
	<SearchResultsCard {toolCall} />
{:else if cardName === 'TaskListCard'}
	<TaskListCard {toolCall} {conversationId} {messageId} {onsendmessage} />
{:else if cardName === 'TaskDetailCard'}
	<TaskDetailCard {toolCall} {conversationId} {messageId} {onsendmessage} />
{:else}
	<DefaultCard {toolCall} />
{/if}
