<script lang="ts">
	/**
	 * `<TopicPills>` — the hover-revealed overlay of topic pills on a chat
	 * message row. Rendered by ChatMessage for any message anchored in a
	 * detected topic; clicking a pill runs the stage-2 extract (the result
	 * lands in the header <TopicsPopover>).
	 *
	 * NOTE: pills are deliberately NOT MessageToolbar buttons. They are a
	 * standalone hover overlay on the message row, so they never touch the
	 * `messageToolbar` extension dispatch contract (message-toolbar-registry)
	 * or its parity test. Reveal parity with the toolbar is achieved by
	 * reusing the same `group-hover` / `group-data-[toolbar-revealed]` classes.
	 */
	import { type Topic, typeBadgeClass } from "$lib/topic-contexts-logic";

	let {
		topics,
		busyId = null,
		onextract,
	}: {
		/** Topics anchored to this message (already capped by the parent). */
		topics: Topic[];
		/** Topic id whose extract is in flight — drives the spinner + guard. */
		busyId?: string | null;
		onextract: (topicId: string) => void;
	} = $props();

	/**
	 * Double-click / re-entrancy guard: while ANY extract is in flight the
	 * pills are inert (the parent also no-ops a second POST, so this is the
	 * UX half). `busyId` is set synchronously by the parent before the await,
	 * so a real second click sees it; a truly same-tick double click is
	 * caught by the parent's own guard.
	 */
	function clickTopic(id: string) {
		if (busyId !== null) return;
		onextract(id);
	}
</script>

{#if topics.length > 0}
	<div
		class="absolute right-2 top-2 z-10 flex max-w-[70%] flex-wrap items-center justify-end gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-data-[toolbar-revealed=true]:opacity-100 {busyId !== null ? 'opacity-100' : ''}"
		data-testid="topic-pills"
	>
		{#each topics as topic (topic.id)}
			<button
				type="button"
				data-testid="topic-pill-{topic.id}"
				onclick={() => clickTopic(topic.id)}
				disabled={busyId !== null}
				title="Extract & copy the context for “{topic.label}”"
				class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] shadow-sm hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
			>
				{#if busyId === topic.id}
					<svg
						class="h-3 w-3 animate-spin text-[var(--color-accent)]"
						data-testid="topic-pill-spinner"
						viewBox="0 0 24 24"
						fill="none"
						aria-hidden="true"
					>
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
					</svg>
				{:else}
					<span class="h-1.5 w-1.5 shrink-0 rounded-full {typeBadgeClass(topic.typeId)}" aria-hidden="true"></span>
				{/if}
				<span class="max-w-[10rem] truncate">{topic.label}</span>
			</button>
		{/each}
	</div>
{/if}
