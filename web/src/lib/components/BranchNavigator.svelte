<script lang="ts">
	let {
		siblings,
		currentId,
		onnavigate,
	}: {
		siblings: { id: string; createdAt: string }[];
		currentId: string;
		onnavigate: (messageId: string) => void;
	} = $props();

	let currentIndex = $derived(siblings.findIndex((s) => s.id === currentId));
	let total = $derived(siblings.length);
	let hasPrev = $derived(currentIndex > 0);
	let hasNext = $derived(currentIndex < total - 1);

	function goPrev() {
		if (hasPrev) onnavigate(siblings[currentIndex - 1]!.id);
	}

	function goNext() {
		if (hasNext) onnavigate(siblings[currentIndex + 1]!.id);
	}
</script>

{#if total > 1}
	<span class="inline-flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
		<button
			onclick={goPrev}
			disabled={!hasPrev}
			class="px-0.5 hover:text-[var(--color-text-primary)] disabled:opacity-30 disabled:cursor-default"
			aria-label="Previous branch"
		>&lt;</button>
		<span>{currentIndex + 1}/{total}</span>
		<button
			onclick={goNext}
			disabled={!hasNext}
			class="px-0.5 hover:text-[var(--color-text-primary)] disabled:opacity-30 disabled:cursor-default"
			aria-label="Next branch"
		>&gt;</button>
	</span>
{/if}
