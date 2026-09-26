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

// Exact values, edge inputs, and the smaller helpers. W18d's Stryker run left
// 89 mutants alive in model.ts because the suite above checked shapes, not
// values; each test here pins the value a mutant would change.
describe("factory graph model: exact values and edges", () => {
	const digest = "sha256:" + "a".repeat(64);
	const empty = { nodes: [], outputs: {} };

	test("every new node carries its kind's exact editable defaults", () => {
		expect(FACTORY_NODE_KINDS.map(kind => newFactoryNode(kind, "n"))).toEqual([
			{ id: "n", dependsOn: [], kind: "task", runner: { package: "package-name", manifestName: "package-name", version: "1.0.0", digest, export: "run" } },
			{ id: "n", dependsOn: [], kind: "branch", condition: { kind: "literal", value: true }, then: empty, else: empty },
			{ id: "n", dependsOn: [], kind: "join", mode: "all", predecessors: [] },
			{ id: "n", dependsOn: [], kind: "map", collection: { kind: "literal", value: [] }, itemSchema: {}, body: empty, mode: "all", maxItems: 100, maxConcurrency: 4 },
			{
				id: "n", dependsOn: [], kind: "loop", initialInput: { kind: "literal", value: null }, carriedSchema: {}, resultSchema: {}, body: empty,
				until: { kind: "literal", value: false }, nextInput: { kind: "literal", value: null }, maxIterations: 3, maxElapsedMs: 3_600_000, onExhausted: "fail",
			},
			{ id: "n", dependsOn: [], kind: "subfactory", factory: { id: "factory-id", version: "1.0.0", digest }, releaseMode: "none", grants: [] },
			{
				id: "n", dependsOn: [], kind: "approval", choices: ["approve", "deny"], context: { kind: "literal", value: null }, actorScope: "project-member",
				expiresInMs: 86_400_000, onDenied: "fail", onExpired: "fail",
			},
			{ id: "n", dependsOn: [], kind: "acceptance", contract: "contract-id", candidate: { kind: "literal", value: null }, evidence: { kind: "literal", value: [] } },
			{
				id: "n", dependsOn: [], kind: "release", adapter: { package: "release-adapter", manifestName: "release-adapter", version: "1.0.0", digest, export: "release" },
				acceptedCandidate: { kind: "literal", value: null }, destination: { kind: "literal", value: null },
			},
		]);
		expect(newFactoryNode("task", "a")).not.toBe(newFactoryNode("task", "a"));
	});

	test("map and loop bodies, and branch arms, are addressed by exact scopes", () => {
		let source = blankFactory("scopes");
		for (const node of [newFactoryNode("task", "first"), newFactoryNode("branch", "choose"), newFactoryNode("map", "each"), newFactoryNode("loop", "again")]) {
			source = addFactoryNode(source, ROOT_GRAPH_SCOPE, node);
		}
		expect(projectFactoryGraph(source, ROOT_GRAPH_SCOPE).childGraphs).toEqual([
			{ label: "choose / then", scope: ["graph", "nodes", 1, "then"] },
			{ label: "choose / else", scope: ["graph", "nodes", 1, "else"] },
			{ label: "each / body", scope: ["graph", "nodes", 2, "body"] },
			{ label: "again / body", scope: ["graph", "nodes", 3, "body"] },
		]);
		// A node in the else arm is found only by searching past the empty then arm.
		source = addFactoryNode(source, ["graph", "nodes", 1, "else"], newFactoryNode("task", "fallback"));
		source = addFactoryNode(source, ["graph", "nodes", 3, "body"], newFactoryNode("task", "repeat"));
		expect(findFactoryNodeScope(source, "fallback")).toEqual(["graph", "nodes", 1, "else"]);
		expect(findFactoryNodeScope(source, "repeat")).toEqual(["graph", "nodes", 3, "body"]);
		expect(projectFactoryGraph(source, ["graph", "nodes", 1, "else"]).nodes.map(node => node.id)).toEqual(["fallback"]);
	});

	test("an invalid scope names itself, including an index into a non-array", () => {
		expect(() => projectFactoryGraph(definition(), ["graph", 0])).toThrow(new Error("Factory graph scope is invalid."));
		expect(() => projectFactoryGraph(definition(), ["graph", 0, "nodes"])).toThrow(new Error("Factory graph scope is invalid."));
	});

	test("edges skip dependencies outside the graph and nodes without a dependency list", () => {
		let source = blankFactory("edges");
		source = addFactoryNode(source, ROOT_GRAPH_SCOPE, newFactoryNode("task", "a"));
		source = addFactoryNode(source, ROOT_GRAPH_SCOPE, { ...newFactoryNode("task", "b"), dependsOn: ["a", "elsewhere"] } as FactoryNode);
		const { dependsOn: _dropped, ...bare } = newFactoryNode("task", "c");
		source = addFactoryNode(source, ROOT_GRAPH_SCOPE, bare as FactoryNode);
		const projected = projectFactoryGraph(source, ROOT_GRAPH_SCOPE);
		expect(projected.edges).toEqual([{ id: "a->b", source: "a", target: "b" }]);
		expect(projected.nodes.map(node => node.diagnosticCount)).toEqual([0, 0, 0]);
	});

	test("the first node can be replaced, and replacing keeps its position", () => {
		const replaced = replaceFactoryNode(definition(), ROOT_GRAPH_SCOPE, "collect", newFactoryNode("join", "gather"));
		expect(replaced.graph.nodes.map(node => [node.id, node.kind])).toEqual([["gather", "join"], ["choose", "branch"]]);
	});

	test("connecting needs both ends, and adds to a node that has no dependency list", () => {
		expect(() => connectFactoryNodes(definition(), ROOT_GRAPH_SCOPE, "collect", "missing")).toThrow("not found");
		let source = blankFactory("connect");
		source = addFactoryNode(source, ROOT_GRAPH_SCOPE, newFactoryNode("task", "a"));
		const { dependsOn: _dropped, ...bare } = newFactoryNode("task", "b");
		source = addFactoryNode(source, ROOT_GRAPH_SCOPE, bare as FactoryNode);
		const connected = connectFactoryNodes(source, ROOT_GRAPH_SCOPE, "a", "b");
		expect(readFactoryNode(connected, ROOT_GRAPH_SCOPE, "b")?.dependsOn).toEqual(["a"]);
	});

	test("disconnecting removes only that edge and ignores a missing node or dependency list", () => {
		let source = blankFactory("disconnect");
		for (const id of ["a", "b"]) source = addFactoryNode(source, ROOT_GRAPH_SCOPE, newFactoryNode("task", id));
		source = addFactoryNode(source, ROOT_GRAPH_SCOPE, { ...newFactoryNode("task", "c"), dependsOn: ["a", "b"] } as FactoryNode);
		const { dependsOn: _dropped, ...bare } = newFactoryNode("task", "d");
		source = addFactoryNode(source, ROOT_GRAPH_SCOPE, bare as FactoryNode);
		expect(readFactoryNode(removeFactoryEdge(source, ROOT_GRAPH_SCOPE, "a", "c"), ROOT_GRAPH_SCOPE, "c")?.dependsOn).toEqual(["b"]);
		expect(removeFactoryEdge(source, ROOT_GRAPH_SCOPE, "a", "missing")).toBe(source);
		expect(removeFactoryEdge(source, ROOT_GRAPH_SCOPE, "a", "d")).toBe(source);
	});

	test("the diff names each changed path in sorted, typed notation", () => {
		const base = { a: 1, list: [1, 2], nested: { z: 1, y: 2 }, shape: ["x"], swap: { k: 1 }, gone: null } as unknown as FactoryDefinition;
		const next = { a: 1, list: [1, 3, 4], nested: { y: 3, z: 1 }, shape: "x", swap: "text", gone: { now: true } } as unknown as FactoryDefinition;
		expect(diffFactoryDefinitions(base, next)).toEqual({
			paths: ["$.gone", "$.list[1]", "$.list[2]", "$.nested.y", "$.shape", "$.swap"],
			contractChanged: false,
		});
		expect(diffFactoryDefinitions({ a: "text" } as unknown as FactoryDefinition, { a: { b: 1 } } as unknown as FactoryDefinition).paths).toEqual(["$.a"]);
		expect(diffFactoryDefinitions(1 as unknown as FactoryDefinition, 2 as unknown as FactoryDefinition).paths).toEqual(["$"]);
	});

	test("replacing the whole acceptance section counts as a contract change; a lookalike key does not", () => {
		const before = definition();
		expect(diffFactoryDefinitions(before, { ...before, acceptance: null } as unknown as FactoryDefinition)).toEqual({ paths: ["$.acceptance"], contractChanged: true });
		expect(diffFactoryDefinitions(before, { ...before, acceptanceNotes: "x" } as unknown as FactoryDefinition)).toEqual({ paths: ["$.acceptanceNotes"], contractChanged: false });
	});
});
