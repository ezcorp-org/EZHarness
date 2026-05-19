<script lang="ts">
	import type { ToolCallState } from '$lib/stores.svelte.js';
	import { registerWeatherDisplayElement } from './weather-card-element.js';
	import { parseWeatherPayload, type WeatherCardPayload } from './weather-card-logic.js';

	let { toolCall }: { toolCall: ToolCallState } = $props();

	registerWeatherDisplayElement();

	let payload = $derived(parseWeatherPayload(toolCall.output));
	let hostEl = $state<(HTMLElement & { payload?: WeatherCardPayload | null }) | null>(null);

	$effect(() => {
		if (hostEl) hostEl.payload = payload;
	});
</script>

{#if !payload}
	<div class="weather-error" role="alert" data-testid="weather-card-missing">
		<strong>Cannot render weather card:</strong> tool output is missing required fields.
	</div>
{:else}
	<weather-display-card bind:this={hostEl} data-testid="weather-card-host"></weather-display-card>
{/if}

<style>
	.weather-error {
		padding: 0.75rem 1rem;
		background: var(--color-surface, #1a1a1a);
		border: 1px solid var(--color-border, #2a2a2a);
		border-radius: 8px;
		color: var(--color-error, #ef4444);
		font-size: 0.875rem;
	}
</style>
