<script lang="ts">
	/**
	 * Non-seeded <ChatThread> harness for the Sessions P4 reload-restore test
	 * (`ChatThread.restore-leaf.component.test.ts`). Unlike
	 * ChatThreadBehaviorHarness (which passes `seedMessages` → seeded mode),
	 * this mounts ChatThread WITHOUT a seed so the async `loadMessages` +
	 * `restoreDurableLeaf` path runs exactly as production does. The live
	 * `activeLeafId` is projected onto a testid the spec reads after the load
	 * settles.
	 */
	import ChatThread, { type ChatThreadChrome } from "../ChatThread.svelte";

	interface Props {
		conversationId?: string;
	}
	let { conversationId = "conv-1" }: Props = $props();

	let live = $state<ChatThreadChrome | undefined>();
	let activeLeafId = $derived(live?.activeLeafId ?? null);
</script>

<div style="display:none">
	<ChatThread
		bind:live
		{conversationId}
		projectId="proj-1"
		variant="page"
		convListRefresh={() => {}}
	/>
</div>

<div data-testid="active-leaf">{activeLeafId ?? ""}</div>
