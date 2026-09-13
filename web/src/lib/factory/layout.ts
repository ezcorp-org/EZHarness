import type { Edge, Node } from "@xyflow/svelte";
import type { FactoryGraphProjection } from "./model";

export interface FactoryNodeData extends Record<string, unknown> {
	readonly label: string;
	readonly kind: string;
	readonly nodeId: string;
	readonly diagnosticCount: number;
}

export type FactoryFlowNode = Node<FactoryNodeData, "factory">;
export type FactoryFlowEdge = Edge<Record<string, never>, "smoothstep">;

const nodeWidth = 224;
const nodeHeight = 76;

export async function layoutFactoryGraph(projection: FactoryGraphProjection): Promise<{
	readonly nodes: FactoryFlowNode[];
	readonly edges: FactoryFlowEdge[];
}> {
	if (projection.nodes.length === 0) return { nodes: [], edges: [] };
	const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
	const elk = new ELK();
	const graph = await elk.layout({
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "RIGHT",
			"elk.edgeRouting": "ORTHOGONAL",
			"elk.randomSeed": "17",
			"elk.spacing.nodeNode": "44",
			"elk.layered.spacing.nodeNodeBetweenLayers": "96",
		},
		children: projection.nodes.map(node => ({ id: node.id, width: nodeWidth, height: nodeHeight })),
		edges: projection.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
	});
	const positions = new Map((graph.children ?? []).map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
	return {
		nodes: projection.nodes.map(node => ({
			id: node.id,
			type: "factory",
			position: positions.get(node.id) ?? { x: 0, y: 0 },
			data: {
				label: node.label,
				kind: node.kind,
				nodeId: node.nodeId,
				diagnosticCount: node.diagnosticCount,
			},
			focusable: true,
			ariaRole: "button",
			ariaLabel: node.label + ", " + node.kind + (node.diagnosticCount === 0 ? "" : ", " + node.diagnosticCount + " diagnostics"),
		})),
		edges: projection.edges.map(edge => ({
			...edge,
			type: "smoothstep",
			focusable: true,
			ariaLabel: edge.target + " depends on " + edge.source,
		})),
	};
}
