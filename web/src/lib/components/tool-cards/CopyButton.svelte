<script lang="ts">
	import { copyToClipboard } from "$lib/clipboard.js";

	let { text }: { text: string } = $props();
	let copied = $state(false);

	async function handleCopy() {
		const ok = await copyToClipboard(text);
		if (ok) {
			copied = true;
			setTimeout(() => (copied = false), 2000);
		}
	}
</script>

<button
	onclick={handleCopy}
	class="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
	title="Copy output"
	aria-label={copied ? 'Copied' : 'Copy output'}
>
	{#if copied}
		<svg class="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
			<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
		</svg>
	{:else}
		<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
		</svg>
	{/if}
</button>
