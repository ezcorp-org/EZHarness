import { describe, expect, test } from "vitest";
import type { FactoryDefinition, FactoryNode } from "@ezcorp/factory-sdk";
import {
	FACTORY_NODE_KINDS,
	ROOT_GRAPH_SCOPE,
	addFactoryNode,
	connectFactoryNodes,
	diffFactoryDefinitions,
	findFactoryNodeScope,
	newFactoryNode,
	parseFactoryNode,
	projectFactoryGraph,
	readFactoryNode,
	removeFactoryEdge,
	removeFactoryNode,
	replaceFactoryNode,
} from "./model";
import { blankFactory } from "./client";

function definition(): FactoryDefinition {
	let source = blankFactory("factory-model");
	source = addFactoryNode(source, ROOT_GRAPH_SCOPE, newFactoryNode("task", "collect"));
	source = addFactoryNode(source, ROOT_GRAPH_SCOPE, newFactoryNode("branch", "choose"));
	source = connectFactoryNodes(source, ROOT_GRAPH_SCOPE, "collect", "choose");
	return source;
}

describe("factory graph model", () => {
	test("projects nodes, dependencies, diagnostics, and nested graph scopes", () => {
		const source = definition();
		const projected = projectFactoryGraph(source, ROOT_GRAPH_SCOPE, [{ code: "bad", message: "Bad node", path: [], nodeId: "choose" }]);
		expect(projected.nodes).toEqual([
			expect.objectContaining({ id: "collect", kind: "task", diagnosticCount: 0 }),
			expect.objectContaining({ id: "choose", kind: "branch", diagnosticCount: 1 }),
		]);
		expect(projected.edges).toEqual([{ id: "collect->choose", source: "collect", target: "choose" }]);
		expect(projected.childGraphs.map(child => child.label)).toEqual(["choose / then", "choose / else"]);
		expect(projectFactoryGraph(source, projected.childGraphs[0]!.scope).nodes).toEqual([]);
		expect(findFactoryNodeScope(source, "choose")).toEqual(ROOT_GRAPH_SCOPE);
		expect(findFactoryNodeScope(source, "missing")).toBeNull();
		expect(readFactoryNode(source, ROOT_GRAPH_SCOPE, "collect")).toMatchObject({ kind: "task" });
		expect(readFactoryNode(source, ROOT_GRAPH_SCOPE, "missing")).toBeNull();
	});

	test("adds, replaces, connects, disconnects, and removes immutable nodes", () => {
		const initial = definition();
		const joined = addFactoryNode(initial, ROOT_GRAPH_SCOPE, newFactoryNode("join", "join"));
		const replaced = replaceFactoryNode(joined, ROOT_GRAPH_SCOPE, "join", { ...newFactoryNode("join", "joined"), mode: "any" } as FactoryNode);
		const connected = connectFactoryNodes(replaced, ROOT_GRAPH_SCOPE, "choose", "joined");
		expect(connectFactoryNodes(connected, ROOT_GRAPH_SCOPE, "choose", "joined")).toBe(connected);
		const disconnected = removeFactoryEdge(connected, ROOT_GRAPH_SCOPE, "choose", "joined");
		expect(removeFactoryEdge(disconnected, ROOT_GRAPH_SCOPE, "choose", "joined")).toBe(disconnected);
		const removed = removeFactoryNode(connectFactoryNodes(disconnected, ROOT_GRAPH_SCOPE, "collect", "joined"), ROOT_GRAPH_SCOPE, "collect");
		expect(projectFactoryGraph(removed, ROOT_GRAPH_SCOPE).nodes.map(node => node.id)).toEqual(["choose", "joined"]);
		expect(projectFactoryGraph(removed, ROOT_GRAPH_SCOPE).edges).toEqual([]);
		expect(initial.graph.nodes.map(node => node.id)).toEqual(["collect", "choose"]);
	});

	test("creates every supported construct with an editable nested graph where required", () => {
		const nodes = FACTORY_NODE_KINDS.map((kind, index) => newFactoryNode(kind, kind + "-" + index));
		expect(nodes.map(node => node.kind)).toEqual(FACTORY_NODE_KINDS);
		let source = blankFactory("all-kinds");
		for (const node of nodes) source = addFactoryNode(source, ROOT_GRAPH_SCOPE, node);
		const children = projectFactoryGraph(source, ROOT_GRAPH_SCOPE).childGraphs;
		expect(children.map(child => child.label)).toEqual([
			"branch-1 / then",
			"branch-1 / else",
			"map-3 / body",
			"loop-4 / body",
		]);
		source = addFactoryNode(source, children[0]!.scope, newFactoryNode("task", "nested"));
		expect(findFactoryNodeScope(source, "nested")).toEqual(children[0]!.scope);
	});

	test("parses supported node JSON and rejects unsafe editor coordinates", () => {
		expect(parseFactoryNode(JSON.stringify(newFactoryNode("task", "parsed")))).toMatchObject({ id: "parsed", kind: "task" });
		expect(() => parseFactoryNode("null")).toThrow("supported kind");
		expect(() => parseFactoryNode('{"id":1,"kind":"task"}')).toThrow("supported kind");
		expect(() => parseFactoryNode('{"id":"node","kind":"future"}')).toThrow("supported kind");
		expect(() => parseFactoryNode("{")).toThrow();
		expect(() => projectFactoryGraph(definition(), ["missing"])).toThrow("scope");
		expect(() => projectFactoryGraph(definition(), ["graph", "nodes", 100, "body"])).toThrow("scope");
		expect(() => projectFactoryGraph(definition(), ["graph", "nodes", "bad"])).toThrow("scope");
		expect(() => addFactoryNode(definition(), ROOT_GRAPH_SCOPE, newFactoryNode("task", "collect"))).toThrow("unique");
		expect(() => replaceFactoryNode(definition(), ROOT_GRAPH_SCOPE, "missing", newFactoryNode("task", "new"))).toThrow("not found");
		expect(() => replaceFactoryNode(definition(), ROOT_GRAPH_SCOPE, "choose", newFactoryNode("branch", "collect"))).toThrow("unique");
		expect(() => removeFactoryNode(definition(), ROOT_GRAPH_SCOPE, "missing")).toThrow("not found");
		expect(() => connectFactoryNodes(definition(), ROOT_GRAPH_SCOPE, "collect", "collect")).toThrow("itself");
		expect(() => connectFactoryNodes(definition(), ROOT_GRAPH_SCOPE, "missing", "collect")).toThrow("not found");
	});

	test("reports exact changed paths and acceptance-contract changes", () => {
		const before = definition();
		const after = {
			...before,
			version: "0.2.0",
			acceptance: { ...before.acceptance, version: "0.2.0" },
			graph: { ...before.graph, nodes: [...before.graph.nodes, newFactoryNode("task", "ship")] },
		};
		expect(diffFactoryDefinitions(before, before)).toEqual({ paths: [], contractChanged: false });
		const diff = diffFactoryDefinitions(before, after);
		expect(diff.paths).toContain("$.version");
		expect(diff.paths).toContain("$.acceptance.version");
		expect(diff.paths.some(path => path.includes("graph.nodes"))).toBe(true);
		expect(diff.contractChanged).toBe(true);
	});
});
