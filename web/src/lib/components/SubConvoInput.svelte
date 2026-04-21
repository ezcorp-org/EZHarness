<script lang="ts">
	let {
		conversationId,
		onSend,
	}: {
		conversationId: string;
		onSend: (text: string) => void;
	} = $props();

	let value = $state("");
	let textarea: HTMLTextAreaElement | undefined = $state();

	function submit() {
		const text = value.trim();
		if (!text) return;
		onSend(text);
		value = "";
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}

	$effect(() => {
		// Auto-focus when mounted
		textarea?.focus();
	});
</script>

<div class="sub-convo-input flex items-end gap-2">
	<textarea
		bind:this={textarea}
		bind:value
		onkeydown={handleKeydown}
		rows={1}
		class="flex-1 resize-none rounded border border-[var(--color-border,#444)] bg-[var(--color-surface-tertiary,#2a2a3a)] p-2 text-xs text-[var(--color-text-primary,#e0e0e0)] placeholder-[var(--color-text-muted,#888)] focus:border-[var(--color-accent)] focus:outline-none"
		placeholder="Message {conversationId ? '' : ''}..."
	></textarea>
	<button
		onclick={submit}
		disabled={!value.trim()}
		class="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-30"
	>
		Send
	</button>
</div>
