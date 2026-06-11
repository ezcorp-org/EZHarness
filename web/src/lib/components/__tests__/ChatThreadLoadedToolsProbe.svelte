<script lang="ts">
	/**
	 * Test probe for the `/api/tools` → chrome.loadedTools → header-snippet
	 * chain (ChatThread.loadedTools.component.test.ts). Mounts the REAL
	 * <ChatThread> and projects `chrome.loadedTools` onto testids, exactly
	 * how the route shell consumes it for ChatHeader's tool-count badge.
	 * `selectedMode` passes through so the suite can assert the mode-scoped
	 * refetch (badge mirrors the runtime's mode tool surface).
	 */
	import ChatThread, {
		type ChatThreadChrome,
	} from "../ChatThread.svelte";
	import type { Mode } from "$lib/api.js";

	interface Props {
		selectedMode?: Mode | null;
	}

	let { selectedMode = null }: Props = $props();
</script>

<ChatThread conversationId="conv-1" projectId="proj-1" {selectedMode}>
	{#snippet header(chrome: ChatThreadChrome)}
		<div data-testid="probe-tool-count">{chrome.loadedTools.length}</div>
		<div data-testid="probe-tool-names">{chrome.loadedTools.map((t) => t.name).join(",")}</div>
	{/snippet}
</ChatThread>
