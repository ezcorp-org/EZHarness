<script lang="ts">
	interface Props {
		type: "oauth" | "apikey" | "none";
		provider?: string;
	}

	const PROVIDER_NAMES: Record<string, string> = {
		openai: "OpenAI",
		gemini: "Google Gemini",
		claude: "Anthropic",
	};

	let { type, provider = "" }: Props = $props();

	let tooltip = $derived(
		type === "oauth"
			? `Using ${PROVIDER_NAMES[provider] ?? provider} subscription`
			: type === "apikey"
				? "Using API key"
				: "",
	);
</script>

{#if type !== "none"}
	<span class="inline-flex items-center" title={tooltip}>
		{#if type === "oauth"}
			<!-- Link/chain icon for OAuth subscription -->
			<svg class="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
					d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
					d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
			</svg>
		{:else}
			<!-- Key icon for API key -->
			<svg class="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
					d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
			</svg>
		{/if}
	</span>
{/if}
