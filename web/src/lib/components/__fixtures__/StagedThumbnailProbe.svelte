<!--
  Mirrors the exact `stagedFiles → stagedPreviews` $effect used by
  ChatInput.svelte so vitest can assert the object-URL lifecycle without
  mounting the full composer. Keep in sync with ChatInput.svelte:158-171.
-->
<script lang="ts">
	let { stagedFiles }: { stagedFiles: File[] } = $props();

	let stagedPreviews = $state<Array<string | null>>([]);
	$effect(() => {
		const next = stagedFiles.map((f) =>
			f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
		);
		stagedPreviews = next;
		return () => {
			for (const url of next) if (url) URL.revokeObjectURL(url);
		};
	});
</script>

<ul data-testid="staged-previews">
	{#each stagedPreviews as url, i}
		<li data-testid={`preview-${i}`}>{url ?? "(no-thumb)"}</li>
	{/each}
</ul>
