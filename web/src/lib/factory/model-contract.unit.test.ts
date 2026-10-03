import { describe, expect, test } from "vitest";
import type { FactoryDefinition, FactoryNode } from "@ezcorp/factory-sdk";
import { isFactoryDefinition } from "@ezcorp/factory-sdk/schema";
import { blankFactory } from "./client";
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
	removeFactoryEdge,
	replaceFactoryNode,
} from "./model";

/** The exact starting shape of every node kind the editor can add. */
const digest = "sha256:" + "a".repeat(64);
const literal = (value: unknown) => ({ kind: "literal", value });
const empty = { nodes: [], outputs: {} };
const EXPECTED: Record<string, unknown> = {
	task: { id: "n", dependsOn: [], kind: "task", runner: { package: "package-name", manifestName: "package-name", version: "1.0.0", digest, export: "run" } },
	branch: { id: "n", dependsOn: [], kind: "branch", condition: literal(true), then: empty, else: empty },
	join: { id: "n", dependsOn: [], kind: "join", mode: "all", predecessors: [] },
	map: { id: "n", dependsOn: [], kind: "map", collection: literal([]), itemSchema: {}, body: empty, mode: "all", maxItems: 100, maxConcurrency: 4 },
	loop: { id: "n", dependsOn: [], kind: "loop", initialInput: literal(null), carriedSchema: {}, resultSchema: {}, body: empty, until: literal(false), nextInput: literal(null), maxIterations: 3, maxElapsedMs: 3_600_000, onExhausted: "fail" },
	subfactory: { id: "n", dependsOn: [], kind: "subfactory", factory: { id: "factory-id", version: "1.0.0", digest }, releaseMode: "none", grants: [] },
	approval: { id: "n", dependsOn: [], kind: "approval", choices: ["approve", "deny"], context: literal(null), actorScope: "project-member", expiresInMs: 86_400_000, onDenied: "fail", onExpired: "fail" },
	acceptance: { id: "n", dependsOn: [], kind: "acceptance", contract: "contract-id", candidate: literal(null), evidence: literal([]) },
	release: { id: "n", dependsOn: [], kind: "release", adapter: { package: "release-adapter", manifestName: "release-adapter", version: "1.0.0", digest, export: "release" }, acceptedCandidate: literal(null), destination: literal(null) },
};

function withNodes(nodes: FactoryNode[]): FactoryDefinition {
	return { ...blankFactory("model.contract"), graph: { nodes, outputs: {} } };
}

describe("new nodes", () => {
	test("every kind starts from its exact documented shape and stays a valid definition", () => {
		expect(FACTORY_NODE_KINDS.length).toBe(Object.keys(EXPECTED).length);
		for (const kind of FACTORY_NODE_KINDS) {
			const node = newFactoryNode(kind, "n");
			expect(node).toEqual(EXPECTED[kind]);
			expect(isFactoryDefinition(addFactoryNode(blankFactory("x"), ROOT_GRAPH_SCOPE, node))).toBe(true);
		}
	});
});

describe("scopes", () => {
	test("an invalid scope is refused with one message wherever it is noticed", () => {
		const source = withNodes([newFactoryNode("map", "m")]);
		expect(() => projectFactoryGraph(source, ["graph", 0])).toThrow("Factory graph scope is invalid.");
		expect(() => projectFactoryGraph(source, ["graph", "nodes", 0, "body", "nodes", 0])).toThrow("Factory graph scope is invalid.");
		// A graph at the root has nowhere to be written back to.
		const bare = { nodes: [], outputs: {} } as unknown as FactoryDefinition;
		expect(() => addFactoryNode(bare, [], newFactoryNode("task", "t"))).toThrow("Factory graph scope is invalid.");
	});

	test("map and loop bodies, and both branch arms, are child scopes with exact labels", () => {
		const source = withNodes([newFactoryNode("task", "first"), newFactoryNode("map", "m"), newFactoryNode("loop", "l"), newFactoryNode("branch", "b")]);
		expect(projectFactoryGraph(source, ROOT_GRAPH_SCOPE).childGraphs).toEqual([
			{ label: "m / body", scope: ["graph", "nodes", 1, "body"] },
			{ label: "l / body", scope: ["graph", "nodes", 2, "body"] },
			{ label: "b / then", scope: ["graph", "nodes", 3, "then"] },
			{ label: "b / else", scope: ["graph", "nodes", 3, "else"] },
		]);
	});

	test("a node in a later child scope, or after a nested graph, is still found", () => {
		const inElse = addFactoryNode(withNodes([newFactoryNode("branch", "b")]), ["graph", "nodes", 0, "else"], newFactoryNode("task", "deep"));
		expect(findFactoryNodeScope(inElse, "deep")).toEqual(["graph", "nodes", 0, "else"]);
		const after = withNodes([newFactoryNode("map", "m"), newFactoryNode("task", "later")]);
		expect(findFactoryNodeScope(after, "later")).toEqual(ROOT_GRAPH_SCOPE);
		expect(findFactoryNodeScope(after, "absent")).toBeNull();
		// Writing into a nested scope rewrites only that graph.
		expect(inElse.graph.nodes[0]).toMatchObject({ then: empty, else: { nodes: [expect.objectContaining({ id: "deep" })], outputs: {} } });
	});
});

describe("edges", () => {
	const plain = (id: string, dependsOn?: string[]) => ({ ...newFactoryNode("task", id), ...(dependsOn === undefined ? { dependsOn: undefined } : { dependsOn }) }) as FactoryNode;

	test("connecting keeps existing dependencies, starts a missing list, and refuses a missing endpoint", () => {
		const source = withNodes([plain("a"), plain("b", ["a"]), plain("c"), { ...plain("d"), dependsOn: undefined } as FactoryNode]);
		expect(readDepends(connectFactoryNodes(source, ROOT_GRAPH_SCOPE, "c", "b"), "b")).toEqual(["a", "c"]);
		const noList = JSON.parse(JSON.stringify(source)) as FactoryDefinition;
		delete (noList.graph.nodes[3] as { dependsOn?: unknown }).dependsOn;
		expect(readDepends(connectFactoryNodes(noList, ROOT_GRAPH_SCOPE, "a", "d"), "d")).toEqual(["a"]);
		expect(connectFactoryNodes(source, ROOT_GRAPH_SCOPE, "a", "b")).toBe(source);
		expect(() => connectFactoryNodes(source, ROOT_GRAPH_SCOPE, "a", "missing")).toThrow("Factory node was not found.");
		expect(() => connectFactoryNodes(source, ROOT_GRAPH_SCOPE, "missing", "a")).toThrow("Factory node was not found.");
		expect(() => connectFactoryNodes(source, ROOT_GRAPH_SCOPE, "a", "a")).toThrow("A node cannot depend on itself.");
	});

	test("removing an edge drops exactly that dependency and ignores an edge that is not there", () => {
		const source = withNodes([plain("a"), plain("b"), plain("c", ["a", "b"])]);
		expect(readDepends(removeFactoryEdge(source, ROOT_GRAPH_SCOPE, "a", "c"), "c")).toEqual(["b"]);
		expect(removeFactoryEdge(source, ROOT_GRAPH_SCOPE, "a", "missing")).toBe(source);
		const noList = JSON.parse(JSON.stringify(source)) as FactoryDefinition;
		delete (noList.graph.nodes[0] as { dependsOn?: unknown }).dependsOn;
		expect(removeFactoryEdge(noList, ROOT_GRAPH_SCOPE, "b", "a")).toBe(noList);
	});

	test("the first node can be replaced in place", () => {
		const source = withNodes([plain("first"), plain("second")]);
		const replaced = replaceFactoryNode(source, ROOT_GRAPH_SCOPE, "first", { ...plain("first"), dependsOn: ["second"] } as FactoryNode);
		expect(replaced.graph.nodes.map(node => node.id)).toEqual(["first", "second"]);
		expect(readDepends(replaced, "first")).toEqual(["second"]);
	});
});

describe("node JSON", () => {
	test("anything but an object with a supported kind and string id is refused with one message", () => {
		for (const text of ["null", "3", '"task"', '{"id":1,"kind":"task"}', '{"id":"x","kind":"nope"}']) {
			expect(() => parseFactoryNode(text)).toThrow("Node JSON needs a supported kind and a string ID.");
		}
		expect(parseFactoryNode('{"id":"x","kind":"join"}')).toEqual({ id: "x", kind: "join" });
	});
});

describe("definition diffs", () => {
	test("paths name array indices, nested keys, nulls, and a changed root exactly", () => {
		const left = blankFactory("diff.factory");
		const right = { ...left, version: "0.2.0", capabilities: ["network"], presentation: null } as unknown as FactoryDefinition;
		expect(diffFactoryDefinitions(left, right)).toEqual({ paths: ["$.capabilities[0]", "$.presentation", "$.version"], contractChanged: false });
		expect(diffFactoryDefinitions(1 as never, 2 as never)).toEqual({ paths: ["$"], contractChanged: false });
		const contract = { ...left, acceptance: { ...left.acceptance, version: "9" } };
		expect(diffFactoryDefinitions(left, contract)).toEqual({ paths: ["$.acceptance.version"], contractChanged: true });
		expect(diffFactoryDefinitions(left, { ...left, acceptance: null } as never).contractChanged).toBe(true);
	});
});

function readDepends(source: FactoryDefinition, id: string): readonly string[] | undefined {
	return source.graph.nodes.find(node => node.id === id)?.dependsOn;
}
