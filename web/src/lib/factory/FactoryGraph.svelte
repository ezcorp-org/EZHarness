<script lang="ts">
	import {
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		SvelteFlow,
		type Connection,
		type Edge,
		type Node,
	} from "@xyflow/svelte";
	import "@xyflow/svelte/dist/style.css";
	import FactoryNode from "./FactoryNode.svelte";
	import { layoutFactoryGraph, type FactoryFlowEdge, type FactoryFlowNode } from "./layout";
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

	let nodes = $state.raw<FactoryFlowNode[]>([]);
	let edges = $state.raw<FactoryFlowEdge[]>([]);
	let layoutGeneration = 0;

	$effect(() => {
		const current = projection;
		const generation = ++layoutGeneration;
		void layoutFactoryGraph(current).then(layout => {
			if (generation !== layoutGeneration) return;
			nodes = layout.nodes.map(node => ({ ...node, selected: node.id === selectedNodeId }));
			edges = layout.edges;
		});
	});

	$effect(() => {
		const selected = selectedNodeId;
		if (nodes.some(node => node.selected !== (node.id === selected))) {
			nodes = nodes.map(node => node.selected === (node.id === selected) ? node : { ...node, selected: node.id === selected });
		}
	});

	function connect(connection: Connection): void {
		if (connection.source && connection.target) onConnect(connection.source, connection.target);
	}

	function remove(items: { nodes: Node[]; edges: Edge[] }): void {
		for (const node of items.nodes) onDeleteNode(node.id);
		for (const edge of items.edges) onDeleteEdge(edge.source, edge.target);
	}
</script>

<div class="factory-flow" data-testid="factory-graph" aria-label="Factory graph editor">
	{#if projection.nodes.length === 0}
		<div class="factory-flow-empty">
			<strong>No nodes in this graph.</strong>
			<span>Add a node from the inspector to start this scope.</span>
		</div>
	{/if}
	<SvelteFlow
		bind:nodes
		bind:edges
		nodeTypes={{ factory: FactoryNode }}
		fitView
		fitViewOptions={{ padding: 0.25, maxZoom: 1.15 }}
		minZoom={0.2}
		maxZoom={2.4}
		deleteKey={["Backspace", "Delete"]}
		nodesFocusable={true}
		edgesFocusable={true}
		onnodeclick={({ node }) => onSelectNode(node.id)}
		onpaneclick={() => onSelectNode(null)}
		onconnect={connect}
		ondelete={remove}
		colorMode="system"
	>
		<Controls />
		<MiniMap pannable zoomable />
		<Background variant={BackgroundVariant.Lines} gap={24} size={1} />
	</SvelteFlow>
</div>

<style>
	.factory-flow {
		position: relative;
		height: 100%;
		min-height: 420px;
		overflow: hidden;
		background:
			linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 5%, transparent), transparent 35%),
			var(--color-surface-secondary);
	}
	.factory-flow-empty {
		position: absolute;
		inset: 50% auto auto 50%;
		z-index: 3;
		display: grid;
		width: min(300px, calc(100% - 32px));
		transform: translate(-50%, -50%);
		gap: 4px;
		border: 1px dashed var(--color-border-strong);
		background: color-mix(in srgb, var(--color-surface-elevated) 92%, transparent);
		padding: 18px;
		text-align: center;
		color: var(--color-text-secondary);
	}
	.factory-flow-empty strong {
		color: var(--color-text-primary);
	}
	:global(.svelte-flow__node-factory) {
		border: 0;
		background: transparent;
	}
	:global(.svelte-flow__edge.selected path),
	:global(.svelte-flow__edge:focus path) {
		stroke: var(--color-accent);
		stroke-width: 3;
	}
	:global(.svelte-flow__controls),
	:global(.svelte-flow__minimap) {
		border: 1px solid var(--color-border);
		border-radius: 3px;
		background: var(--color-surface-elevated);
		box-shadow: var(--shadow-sm);
	}
	@media (max-width: 640px) {
		.factory-flow {
			min-height: 360px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.svelte-flow__node),
		:global(.svelte-flow__viewport) {
			transition: none !important;
		}
	}
</style>
