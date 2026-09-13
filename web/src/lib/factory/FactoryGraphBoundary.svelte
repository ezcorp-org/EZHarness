<script lang="ts">
	import { onMount } from "svelte";
	import type { FactoryGraphProjection } from "./model";

	let {
		projection,
		selectedNodeId = null,
		onSelectNode,
		onConnect,
		onDeleteNode,
		onDeleteEdge,
	}: {
		projection: FactoryGraphProjection;
		selectedNodeId?: string | null;
		onSelectNode: (nodeId: string | null) => void;
		onConnect: (source: string, target: string) => void;
		onDeleteNode: (nodeId: string) => void;
		onDeleteEdge: (source: string, target: string) => void;
	} = $props();

	let Graph = $state<typeof import("./FactoryGraph.svelte").default | null>(null);

	onMount(async () => {
		Graph = (await import("./FactoryGraph.svelte")).default;
	});
</script>

{#if Graph}
	<Graph {projection} {selectedNodeId} {onSelectNode} {onConnect} {onDeleteNode} {onDeleteEdge} />
{:else}
	<div class="graph-loading" data-testid="factory-graph-loading" aria-live="polite">Preparing graph editor…</div>
{/if}

<style>
	.graph-loading {
		display: grid;
		height: 100%;
		min-height: 420px;
		place-items: center;
		background: var(--color-surface-secondary);
		color: var(--color-text-muted);
		font-family: var(--font-mono);
		font-size: 12px;
	}
</style>
