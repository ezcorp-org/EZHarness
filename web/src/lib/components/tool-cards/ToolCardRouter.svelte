<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { getCardComponentName, isCollapsibleDevCard } from "./utils.js";
	import PermissionGate from "./PermissionGate.svelte";
	import TerminalCard from "./TerminalCard.svelte";
	import DiffCard from "./DiffCard.svelte";
	import SearchResultsCard from "./SearchResultsCard.svelte";
	import TaskListCard from "./TaskListCard.svelte";
	import TaskDetailCard from "./TaskDetailCard.svelte";
	import AskUserQuestionCard from "./AskUserQuestionCard.svelte";
	import DesignCanvasCard from "./DesignCanvasCard.svelte";
	import DesignBriefCard from "./DesignBriefCard.svelte";
	import KokoroTtsPlayerCard from "./KokoroTtsPlayerCard.svelte";
	import PriceChartCard from "./PriceChartCard.svelte";
	import WeatherCard from "./WeatherCard.svelte";
	import { parseWeatherPayload } from "./weather-card-logic.js";
	import ImageGenCard from "./ImageGenCard.svelte";
	import DefaultCard from "./DefaultCard.svelte";
	import CollapsibleCard from "./CollapsibleCard.svelte";
	import EzToolResultCard from "$lib/components/ez/EzToolResultCard.svelte";
	import { parseInstallCardResult } from "./ez-install-card-logic.js";

	let { toolCall, conversationId, messageId, onsendmessage, mode = 'inline' }: { toolCall: ToolCallState; conversationId?: string; messageId?: string; onsendmessage?: (message: string) => void; mode?: 'inline' | 'dock' } = $props();

	let cardName = $derived(getCardComponentName(toolCall.cardType, toolCall.permissionPending));
	// Defensive fallback for extension-authored weather tools: if the runtime
	// event loses `cardType` but the result is unmistakably a weather-panel
	// payload, still render the WeatherCard instead of a raw/default card.
	let shouldRenderWeatherCard = $derived(
		cardName === 'WeatherCard' ||
		(cardName === 'DefaultCard' && toolCall.status === 'complete' && !!parseWeatherPayload(toolCall.output)),
	);

	// `ez-install` only renders EzToolResultCard once the result actually
	// carries a usable `openUrl` (running call / no deep-link → null);
	// otherwise fall back to DefaultCard so a streaming or malformed
	// result degrades to today's behavior instead of an empty card.
	let installResult = $derived(
		cardName === 'EzToolResultCard' ? parseInstallCardResult(toolCall.output) : null,
	);

	// Noisy dev-command cards (Bash, grep/glob, Edit/Write diffs) collapse to a
	// one-line header inline; full-size in the dock. Decision lives in a pure
	// helper so the matrix is unit-tested without a renderer.
	let collapsibleDevCard = $derived(isCollapsibleDevCard(cardName, mode));
</script>

{#snippet devCard()}
	{#if cardName === 'TerminalCard'}
		<TerminalCard {toolCall} />
	{:else if cardName === 'DiffCard'}
		<DiffCard {toolCall} />
	{:else}
		<SearchResultsCard {toolCall} />
	{/if}
{/snippet}

{#if cardName === 'PermissionGate'}
	<PermissionGate {toolCall} />
{:else if collapsibleDevCard}
	<CollapsibleCard {toolCall}>
		{@render devCard()}
	</CollapsibleCard>
{:else if cardName === 'TerminalCard' || cardName === 'DiffCard' || cardName === 'SearchResultsCard'}
	{@render devCard()}
{:else if cardName === 'TaskListCard'}
	<TaskListCard {toolCall} {conversationId} {messageId} {onsendmessage} />
{:else if cardName === 'TaskDetailCard'}
	<TaskDetailCard {toolCall} {conversationId} {messageId} {onsendmessage} />
{:else if cardName === 'AskUserQuestionCard'}
	<AskUserQuestionCard {toolCall} />
{:else if cardName === 'DesignCanvasCard'}
	<DesignCanvasCard {toolCall} {conversationId} {messageId} {mode} />
{:else if cardName === 'DesignBriefCard'}
	<DesignBriefCard {toolCall} {conversationId} />
{:else if cardName === 'KokoroTtsPlayerCard'}
	<KokoroTtsPlayerCard {toolCall} {conversationId} {messageId} />
{:else if cardName === 'PriceChartCard'}
	<PriceChartCard {toolCall} {conversationId} {mode} />
{:else if shouldRenderWeatherCard}
	<WeatherCard {toolCall} />
{:else if cardName === 'ImageGenCard'}
	<ImageGenCard {toolCall} {conversationId} {messageId} {onsendmessage} />
{:else if cardName === 'EzToolResultCard' && installResult}
	<EzToolResultCard result={installResult} toolName={toolCall.toolName} />
{:else}
	<DefaultCard {toolCall} />
{/if}
