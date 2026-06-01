<script lang="ts">
	// Minimal stub for $lib/components/ConversationList used by the
	// chat-index page component test. It exposes the same `onselect`
	// contract — `(id: string, messageId?: string)` — via two buttons so
	// the test can drive both a plain title-row select (no messageId) and
	// a sidebar message-search hit (with messageId) and assert the page's
	// `handleSelect` builds the correct deep-link URL. No network calls.
	let {
		onselect,
	}: {
		projectId?: string;
		activeConversationId?: string;
		oncreate?: () => void;
		onselect?: (id: string, messageId?: string) => void;
	} = $props();
</script>

<div data-testid="conversation-list-stub">
	<button
		type="button"
		data-testid="stub-select-plain"
		onclick={() => onselect?.("conv-9")}
	>
		plain select
	</button>
	<button
		type="button"
		data-testid="stub-select-deeplink"
		onclick={() => onselect?.("conv-9", "msg-42")}
	>
		deep-link select
	</button>
</div>
