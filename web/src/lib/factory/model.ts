import type {
	CompilerDiagnostic,
	FactoryDefinition,
	FactoryGraph,
	FactoryNode,
	JsonValue,
} from "@ezcorp/factory-sdk/types";

export type GraphScope = readonly (string | number)[];
export const ROOT_GRAPH_SCOPE: GraphScope = Object.freeze(["graph"]);
export const FACTORY_NODE_KINDS = Object.freeze([
	"task",
	"branch",
	"join",
	"map",
	"loop",
	"subfactory",
	"approval",
	"acceptance",
	"release",
] as const);
export type FactoryNodeKind = (typeof FACTORY_NODE_KINDS)[number];

export interface FactoryCanvasNode {
	readonly id: string;
	readonly nodeId: string;
	readonly kind: FactoryNodeKind;
	readonly label: string;
	readonly diagnosticCount: number;
}

export interface FactoryCanvasEdge {
	readonly id: string;
	readonly source: string;
	readonly target: string;
}

export interface FactoryChildGraph {
	readonly label: string;
	readonly scope: GraphScope;
}

export interface FactoryGraphProjection {
	readonly nodes: readonly FactoryCanvasNode[];
	readonly edges: readonly FactoryCanvasEdge[];
	readonly childGraphs: readonly FactoryChildGraph[];
}

export interface DefinitionDiff {
	readonly paths: readonly string[];
	readonly contractChanged: boolean;
}

export function snapshotFactoryValue<T>(value: T): T {
	// Factory values are strict JSON. JSON cloning also accepts Svelte's deep
	// reactive proxies, which structuredClone rejects in browsers.
	return JSON.parse(JSON.stringify(value)) as T;
}

function graphAt(source: FactoryDefinition, scope: GraphScope): FactoryGraph {
	let value: unknown = source;
	for (const segment of scope) {
		if (typeof segment === "number") {
			if (!Array.isArray(value)) throw new Error("Factory graph scope is invalid.");
			value = value[segment];
		} else {
			if (!value || typeof value !== "object") throw new Error("Factory graph scope is invalid.");
			value = (value as Record<string, unknown>)[segment];
		}
	}
	if (!value || typeof value !== "object" || !Array.isArray((value as { nodes?: unknown }).nodes)) {
		throw new Error("Factory graph scope is invalid.");
	}
	return value as FactoryGraph;
}

function replaceGraph(source: FactoryDefinition, scope: GraphScope, graph: FactoryGraph): FactoryDefinition {
	const result = snapshotFactoryValue(source) as unknown as Record<string, unknown>;
	let owner: unknown = result;
	for (const segment of scope.slice(0, -1)) {
		owner = typeof segment === "number"
			? (owner as unknown[])[segment]
			: (owner as Record<string, unknown>)[segment];
	}
	const last = scope.at(-1);
	if (last === undefined || !owner || typeof owner !== "object") throw new Error("Factory graph scope is invalid.");
	if (typeof last === "number") (owner as unknown[])[last] = graph;
	else (owner as Record<string, unknown>)[last] = graph;
	return result as unknown as FactoryDefinition;
}

function childGraphs(node: FactoryNode, scope: GraphScope, index: number): FactoryChildGraph[] {
	const base = [...scope, "nodes", index];
	if (node.kind === "branch") {
		return [
			{ label: node.id + " / then", scope: [...base, "then"] },
			{ label: node.id + " / else", scope: [...base, "else"] },
		];
	}
	if (node.kind === "map" || node.kind === "loop") {
		return [{ label: node.id + " / body", scope: [...base, "body"] }];
	}
	return [];
}

export function projectFactoryGraph(
	source: FactoryDefinition,
	scope: GraphScope,
	diagnostics: readonly CompilerDiagnostic[] = [],
): FactoryGraphProjection {
	const graph = graphAt(source, scope);
	const ids = new Set(graph.nodes.map(node => node.id));
	const nodes = graph.nodes.map(node => ({
		id: node.id,
		nodeId: node.id,
		kind: node.kind,
		label: node.id,
		diagnosticCount: diagnostics.filter(diagnostic => diagnostic.nodeId === node.id).length,
	}));
	const edges = graph.nodes.flatMap(node =>
		(node.dependsOn ?? [])
			.filter(dependency => ids.has(dependency))
			.map(dependency => ({ id: dependency + "->" + node.id, source: dependency, target: node.id })),
	);
	return {
		nodes,
		edges,
		childGraphs: graph.nodes.flatMap((node, index) => childGraphs(node, scope, index)),
	};
}

export function findFactoryNodeScope(source: FactoryDefinition, nodeId: string): GraphScope | null {
	function find(graph: FactoryGraph, scope: GraphScope): GraphScope | null {
		for (let index = 0; index < graph.nodes.length; index += 1) {
			const node = graph.nodes[index]!;
			if (node.id === nodeId) return scope;
			for (const child of childGraphs(node, scope, index)) {
				const found = find(graphAt(source, child.scope), child.scope);
				if (found) return found;
			}
		}
		return null;
	}
	return find(source.graph, ROOT_GRAPH_SCOPE);
}

export function readFactoryNode(source: FactoryDefinition, scope: GraphScope, nodeId: string): FactoryNode | null {
	return graphAt(source, scope).nodes.find(node => node.id === nodeId) ?? null;
}

export function addFactoryNode(source: FactoryDefinition, scope: GraphScope, node: FactoryNode): FactoryDefinition {
	const graph = graphAt(source, scope);
	if (graph.nodes.some(item => item.id === node.id)) throw new Error("Node IDs must be unique in this graph.");
	return replaceGraph(source, scope, { ...graph, nodes: [...graph.nodes, snapshotFactoryValue(node)] });
}

export function replaceFactoryNode(source: FactoryDefinition, scope: GraphScope, nodeId: string, node: FactoryNode): FactoryDefinition {
	const graph = graphAt(source, scope);
	const index = graph.nodes.findIndex(item => item.id === nodeId);
	if (index < 0) throw new Error("Factory node was not found.");
	if (node.id !== nodeId && graph.nodes.some(item => item.id === node.id)) throw new Error("Node IDs must be unique in this graph.");
	const nodes = [...graph.nodes];
	nodes[index] = snapshotFactoryValue(node);
	return replaceGraph(source, scope, { ...graph, nodes });
}

export function removeFactoryNode(source: FactoryDefinition, scope: GraphScope, nodeId: string): FactoryDefinition {
	const graph = graphAt(source, scope);
	if (!graph.nodes.some(node => node.id === nodeId)) throw new Error("Factory node was not found.");
	const nodes = graph.nodes
		.filter(node => node.id !== nodeId)
		.map(node => ({ ...node, ...(node.dependsOn === undefined ? {} : { dependsOn: node.dependsOn.filter(id => id !== nodeId) }) } as FactoryNode));
	return replaceGraph(source, scope, { ...graph, nodes });
}

export function connectFactoryNodes(source: FactoryDefinition, scope: GraphScope, from: string, to: string): FactoryDefinition {
	if (from === to) throw new Error("A node cannot depend on itself.");
	const graph = graphAt(source, scope);
	if (!graph.nodes.some(node => node.id === from) || !graph.nodes.some(node => node.id === to)) throw new Error("Factory node was not found.");
	const target = graph.nodes.find(node => node.id === to)!;
	if (target.dependsOn?.includes(from)) return source;
	return replaceFactoryNode(source, scope, to, { ...target, dependsOn: [...(target.dependsOn ?? []), from] });
}

export function removeFactoryEdge(source: FactoryDefinition, scope: GraphScope, from: string, to: string): FactoryDefinition {
	const graph = graphAt(source, scope);
	const target = graph.nodes.find(node => node.id === to);
	if (!target?.dependsOn?.includes(from)) return source;
	return replaceFactoryNode(source, scope, to, { ...target, dependsOn: target.dependsOn.filter(id => id !== from) });
}

export function parseFactoryNode(text: string): FactoryNode {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string" || !FACTORY_NODE_KINDS.includes((value as { kind?: FactoryNodeKind }).kind as FactoryNodeKind)) {
		throw new Error("Node JSON needs a supported kind and a string ID.");
	}
	return value as FactoryNode;
}

const placeholderDigest = "sha256:" + "a".repeat(64);
const literal = (value: JsonValue) => ({ kind: "literal" as const, value });
const emptyGraph = (): FactoryGraph => ({ nodes: [], outputs: {} });

export function newFactoryNode(kind: FactoryNodeKind, id: string): FactoryNode {
	const base = { id, dependsOn: [] };
	switch (kind) {
		case "task":
			return { ...base, kind, runner: { package: "package-name", manifestName: "package-name", version: "1.0.0", digest: placeholderDigest, export: "run" } };
		case "branch":
			return { ...base, kind, condition: literal(true), then: emptyGraph(), else: emptyGraph() };
		case "join":
			return { ...base, kind, mode: "all", predecessors: [] };
		case "map":
			return { ...base, kind, collection: literal([]), itemSchema: {}, body: emptyGraph(), mode: "all", maxItems: 100, maxConcurrency: 4 };
		case "loop":
			return { ...base, kind, initialInput: literal(null), carriedSchema: {}, resultSchema: {}, body: emptyGraph(), until: literal(false), nextInput: literal(null), maxIterations: 3, maxElapsedMs: 3_600_000, onExhausted: "fail" };
		case "subfactory":
			return { ...base, kind, factory: { id: "factory-id", version: "1.0.0", digest: placeholderDigest }, releaseMode: "none", grants: [] };
		case "approval":
			return { ...base, kind, choices: ["approve", "deny"], context: literal(null), actorScope: "project-member", expiresInMs: 86_400_000, onDenied: "fail", onExpired: "fail" };
		case "acceptance":
			return { ...base, kind, contract: "contract-id", candidate: literal(null), evidence: literal([]) };
		case "release":
			return { ...base, kind, adapter: { package: "release-adapter", manifestName: "release-adapter", version: "1.0.0", digest: placeholderDigest, export: "release" }, acceptedCandidate: literal(null), destination: literal(null) };
	}
}

function pathLabel(path: readonly (string | number)[]): string {
	if (path.length === 0) return "$";
	return "$" + path.map(segment => typeof segment === "number" ? `[${segment}]` : `.${segment}`).join("");
}

export function diffFactoryDefinitions(previous: FactoryDefinition, next: FactoryDefinition): DefinitionDiff {
	const paths: string[] = [];
	function compare(left: unknown, right: unknown, path: readonly (string | number)[]): void {
		if (Object.is(left, right)) return;
		if (Array.isArray(left) && Array.isArray(right)) {
			const length = Math.max(left.length, right.length);
			for (let index = 0; index < length; index += 1) compare(left[index], right[index], [...path, index]);
			return;
		}
		if (left && right && typeof left === "object" && typeof right === "object") {
			const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
			for (const key of [...keys].sort()) compare((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], [...path, key]);
			return;
		}
		paths.push(pathLabel(path));
	}
	compare(previous, next, []);
	return {
		paths,
		contractChanged: paths.some(path => path === "$.acceptance" || path.startsWith("$.acceptance.")),
	};
}
