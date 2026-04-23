<!--
  Mirrors ChatMessage.svelte's attachment-slot block (lines 224-231) so we
  can DOM-test the rendering contract without pulling in markdown, branch
  navigators, tool-call cards, and the rest of ChatMessage's surface.

  Keep in sync with ChatMessage.svelte's attachment render:
    - visible only when `attachments?.length > 0`
    - one AttachmentCard per entry, keyed by id
    - `data-testid="message-attachments"` wrapper
-->
<script lang="ts">
	import AttachmentCard from "../AttachmentCard.svelte";
	import type { AttachmentSummary } from "$lib/api.js";

	let { attachments }: { attachments?: AttachmentSummary[] } = $props();
</script>

<p>prompt text</p>
{#if attachments && attachments.length > 0}
	<div class="mt-2 flex flex-wrap gap-2" data-testid="message-attachments">
		{#each attachments as att (att.id)}
			<AttachmentCard attachment={att} />
		{/each}
	</div>
{/if}
