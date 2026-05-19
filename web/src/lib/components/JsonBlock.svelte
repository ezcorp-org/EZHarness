<script lang="ts">
	import MarkdownRenderer from "./MarkdownRenderer.svelte";

	let { value, indent = 2 }: { value: unknown; indent?: number } = $props();

	const content = $derived(
		"```json\n" + JSON.stringify(value, null, indent) + "\n```",
	);
</script>

<MarkdownRenderer {content} />
