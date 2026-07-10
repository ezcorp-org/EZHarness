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
	import GradeDeltaCard from "./GradeDeltaCard.svelte";
	import SubstackReviewCard from "./SubstackReviewCard.svelte";
	import WeatherCard from "./WeatherCard.svelte";
	import { parseWeatherPayload } from "./weather-card-logic.js";
	import TimeClockCard from "./TimeClockCard.svelte";
	import { isTimeClockOutput } from "./time-clock-logic.js";
	import ImageGenCard from "./ImageGenCard.svelte";
	import DefaultCard from "./DefaultCard.svelte";
	import CollapsibleCard from "./CollapsibleCard.svelte";
	import EzToolResultCard from "$lib/components/ez/EzToolResultCard.svelte";
	import { parseInstallCardResult } from "./ez-install-card-logic.js";
	import { parseProposeCardResult } from "./ez-propose-card-logic.js";
	import PreviewConsentCard from "./PreviewConsentCard.svelte";
	import { parseConsentCardResult } from "./preview-consent-card-logic.js";

	let { toolCall, conversationId, messageId, onsendmessage, mode = 'inline' }: { toolCall: ToolCallState; conversationId?: string; messageId?: string; onsendmessage?: (message: string) => void; mode?: 'inline' | 'dock' } = $props();

	let cardName = $derived(getCardComponentName(toolCall.cardType, toolCall.permissionPending));
	// Defensive fallback for extension-authored weather tools: if the runtime
	// event loses `cardType` but the result is unmistakably a weather-panel
	// payload, still render the WeatherCard instead of a raw/default card.
	let shouldRenderWeatherCard = $derived(
		cardName === 'WeatherCard' ||
		(cardName === 'DefaultCard' && toolCall.status === 'complete' && !!parseWeatherPayload(toolCall.output)),
	);

	// Defensive fallback for time-teller: same rationale as weather above.
	let shouldRenderTimeClockCard = $derived(
		cardName === 'TimeClockCard' ||
		(cardName === 'DefaultCard' && toolCall.status === 'complete' && isTimeClockOutput(toolCall.output)),
	);

	// grade-delta-chart parses a full identify_slab record out of the
	// output — during a live run there is no (or only partial) output, so
	// a running call must show the generic running treatment
	// (DefaultCard), never a transient "Cannot render slab card" error
	// box. Same status gate as the Weather/TimeClock fallbacks above.
	let shouldRenderGradeDeltaCard = $derived(
		cardName === 'GradeDeltaCard' && toolCall.status === 'complete',
	);

	// EzToolResultCard renders only once the result actually carries a
	// usable `openUrl` (running call / no deep-link → null); otherwise we
	// fall back to DefaultCard so a streaming or malformed result degrades
	// to today's behavior instead of an empty card. The parser is keyed on
	// cardType: `ez-install` (extension-author install_draft) vs
	// `ez-propose` (built-in concierge propose_* tools).
	let ezCardResult = $derived(
		cardName !== 'EzToolResultCard'
			? null
			: toolCall.cardType === 'ez-install'
				? parseInstallCardResult(toolCall.output)
				: parseProposeCardResult(toolCall.output),
	);

	// Secure Preview Phase 2 — the expose-consent card parses its
	// {conversationId, port, title, summary} payload; a malformed/streaming
	// payload returns null so the router degrades to DefaultCard.
	let consentCardData = $derived(
		cardName === 'PreviewConsentCard' ? parseConsentCardResult(toolCall.output) : null,
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
	<PriceChartCard {toolCall} />
{:else if shouldRenderGradeDeltaCard}
	<GradeDeltaCard {toolCall} />
{:else if cardName === 'SubstackReviewCard'}
	<SubstackReviewCard {toolCall} {conversationId} />
{:else if shouldRenderWeatherCard}
	<WeatherCard {toolCall} />
{:else if shouldRenderTimeClockCard}
	<TimeClockCard {toolCall} />
{:else if cardName === 'ImageGenCard'}
	<ImageGenCard {toolCall} {conversationId} {messageId} {onsendmessage} />
{:else if cardName === 'EzToolResultCard' && ezCardResult}
	<EzToolResultCard result={ezCardResult} toolName={toolCall.toolName} />
{:else if cardName === 'PreviewConsentCard' && consentCardData}
	<PreviewConsentCard data={consentCardData} />
{:else}
	<DefaultCard {toolCall} />
{/if}
