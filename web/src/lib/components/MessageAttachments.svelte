<script lang="ts">
	import AttachmentCard from "./AttachmentCard.svelte";
	import type { AttachmentSummary } from "$lib/api.js";

	let { attachments }: { attachments?: AttachmentSummary[] } = $props();
</script>

{#if attachments && attachments.length > 0}
	<div class="mt-2 flex flex-wrap gap-2" data-testid="message-attachments">
		{#each attachments as att (att.id)}
			<AttachmentCard attachment={att} />
		{/each}
	</div>
{/if}
