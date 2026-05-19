<script lang="ts">
	import ActiveAgentsList from "$lib/components/ActiveAgentsList.svelte";
</script>

<div class="space-y-4">
	<div>
		<h1 class="text-2xl font-semibold text-[var(--color-text-primary)]">Active Agents</h1>
		<p class="text-sm text-[var(--color-text-muted)]">
			Chats with a live agent run. Click a row to jump into the conversation.
		</p>
	</div>
	<ActiveAgentsList groupByProject />
</div>
