<script lang="ts">
	import { Handle, Position } from "@xyflow/svelte";
	import type { FactoryNodeData } from "./layout";

	let { data, selected = false }: { data: FactoryNodeData; selected?: boolean } = $props();
</script>

<div
	class:factory-node-selected={selected}
	class:factory-node-invalid={data.diagnosticCount > 0}
	class="factory-flow-node"
	data-testid="factory-graph-node"
	data-node-id={data.nodeId}
>
	<Handle type="target" position={Position.Left} />
	<div class="factory-node-kind">{data.kind}</div>
	<div class="factory-node-label" title={data.label}>{data.label}</div>
	{#if data.diagnosticCount > 0}
		<div class="factory-node-diagnostics">{data.diagnosticCount} issue{data.diagnosticCount === 1 ? "" : "s"}</div>
	{/if}
	<Handle type="source" position={Position.Right} />
</div>

<style>
	.factory-flow-node {
		box-sizing: border-box;
		width: 224px;
		min-height: 76px;
		border: 1px solid var(--color-border-strong);
		border-left: 4px solid var(--color-accent);
		border-radius: 4px;
		background: var(--color-surface-elevated);
		box-shadow: var(--shadow-sm);
		padding: 11px 14px;
		color: var(--color-text-primary);
	}
	.factory-node-selected {
		outline: 3px solid color-mix(in srgb, var(--color-accent) 38%, transparent);
		border-color: var(--color-accent);
	}
	.factory-node-invalid {
		border-left-color: var(--color-red-500);
	}
	.factory-node-kind {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: .12em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}
	.factory-node-label {
		margin-top: 3px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 14px;
		font-weight: 700;
	}
	.factory-node-diagnostics {
		margin-top: 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-red-600);
	}
</style>
