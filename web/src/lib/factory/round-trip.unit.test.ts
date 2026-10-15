import { describe, expect, test } from "vitest";
import { canonicalizeJson, compileFactory, defineFactory, FactoryParseError, parseFactoryJson, parseFactoryYaml, referenceFactories, type FactoryDefinition, type JsonValue } from "@ezcorp/factory-sdk";
import { isFactoryDefinition } from "@ezcorp/factory-sdk/schema";
import { blankFactory } from "./client";
import {
	ROOT_GRAPH_SCOPE,
	addFactoryNode,
	connectFactoryNodes,
	newFactoryNode,
	parseFactoryNode,
	projectFactoryGraph,
	readFactoryNode,
	removeFactoryEdge,
	removeFactoryNode,
	replaceFactoryNode,
	snapshotFactoryValue,
	type GraphScope,
} from "./model";

/**
 * C09: JSON, YAML, SDK, and the visual editor all reach the same compiled
 * execution digest for every construct, and only a deliberate edit changes it.
 * The four reference factories cover task, map, loop, subfactory, approval,
 * acceptance, and release nodes; the fifth definition adds branch and join.
 */

function digest(definition: unknown): string {
	const compiled = compileFactory(definition);
	if (!compiled.ok) throw new Error(`does not compile: ${JSON.stringify(compiled.diagnostics).slice(0, 300)}`);
	return compiled.factory.digest;
}

function withBranchAndJoin(): FactoryDefinition {
	const base = structuredClone(referenceFactories[0]!) as FactoryDefinition;
	const first = base.graph.nodes[0]!.id;
	return {
		...base,
		id: "round-trip.branch-join.v1",
		graph: {
			...base.graph,
			nodes: [
				...base.graph.nodes,
				{ id: "choose-path", kind: "branch", dependsOn: [first], condition: { kind: "literal", value: true }, then: { nodes: [], outputs: {} }, else: { nodes: [], outputs: {} } },
				{ id: "rejoin", kind: "join", dependsOn: ["choose-path"], mode: "all", predecessors: ["choose-path"] },
			] as FactoryDefinition["graph"]["nodes"],
		},
	};
}

const DEFINITIONS: readonly FactoryDefinition[] = [...(referenceFactories as readonly FactoryDefinition[]), withBranchAndJoin()];

/** A genuine block-style YAML document, not the JSON subset: every scalar is a double-quoted YAML string or a plain number. */
function blockYaml(value: JsonValue, indent = ""): string {
	if (value === null || typeof value !== "object") return typeof value === "string" ? JSON.stringify(value) : String(value);
	const next = indent + "  ";
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return value.map(item => `\n${indent}- ${blockYaml(item, next).replace(/^\n\s*/, "")}`).join("");
	}
	const entries = Object.entries(value);
	if (entries.length === 0) return "{}";
	return entries.map(([key, item]) => `\n${indent}${JSON.stringify(key)}: ${blockYaml(item, next)}`).join("");
}

/** Every graph scope in a definition, root first. */
function scopes(definition: FactoryDefinition, scope: GraphScope = ROOT_GRAPH_SCOPE): GraphScope[] {
	return [scope, ...projectFactoryGraph(definition, scope).childGraphs.flatMap(child => scopes(definition, child.scope))];
}

/** Re-applies every node through the editor's own text form, and round-trips its structure edits. */
function throughTheEditor(source: FactoryDefinition): FactoryDefinition {
	let edited = snapshotFactoryValue(source);
	for (const scope of scopes(edited)) {
		for (const node of projectFactoryGraph(edited, scope).nodes) {
			const current = readFactoryNode(edited, scope, node.id)!;
			edited = replaceFactoryNode(edited, scope, node.id, parseFactoryNode(JSON.stringify(current, null, 2)));
			const last = current.dependsOn?.at(-1);
			if (last !== undefined) edited = connectFactoryNodes(removeFactoryEdge(edited, scope, last, node.id), scope, last, node.id);
		}
		edited = removeFactoryNode(addFactoryNode(edited, scope, newFactoryNode("task", "round-trip-scratch")), scope, "round-trip-scratch");
	}
	return edited;
}

describe("round-trip digest parity", () => {
	for (const definition of DEFINITIONS) {
		test(`${definition.id} compiles to one digest through JSON, YAML, the SDK, and the editor`, () => {
			const expected = digest(definition);
			const json = canonicalizeJson(definition as unknown as JsonValue);
			expect(digest(parseFactoryJson(json))).toBe(expected);
			// The export route's YAML is the canonical JSON subset; a hand-written block document must agree too.
			expect(digest(parseFactoryYaml(json))).toBe(expected);
			const yaml = `# exported for review\n${blockYaml(JSON.parse(json) as JsonValue).trimStart()}\n`;
			expect(yaml).not.toMatch(/^\{/);
			expect(digest(parseFactoryYaml(yaml))).toBe(expected);
			expect(digest(defineFactory(definition))).toBe(expected);
			const edited = throughTheEditor(definition);
			expect(isFactoryDefinition(edited)).toBe(true);
			expect(digest(edited)).toBe(expected);
		});
	}

	test("only a deliberate edit changes the digest", () => {
		const definition = DEFINITIONS[0]!;
		const node = definition.graph.nodes[0]!;
		const edited = replaceFactoryNode(definition, ROOT_GRAPH_SCOPE, node.id, { ...node, retry: { maxAttempts: 2, initialDelayMs: 1_000, maximumDelayMs: 2_000 } } as typeof node);
		expect(digest(edited)).not.toBe(digest(definition));
	});
});

describe("unknown schema versions", () => {
	test("a future version is refused by every path with a named error, never silently stripped", () => {
		const future = { ...blankFactory("future.factory"), schemaVersion: "factory.v9", futureExecutionField: { mode: "new" } };
		expect(isFactoryDefinition(future)).toBe(false);
		const compiled = compileFactory(future);
		expect(compiled.ok).toBe(false);
		expect(compiled.ok ? [] : compiled.diagnostics.map(item => item.code)).toContain("FACTORY_SCHEMA");
		for (const parse of [parseFactoryJson, parseFactoryYaml]) {
			const failure = (() => { try { parse(JSON.stringify(future)); return null; } catch (error) { return error; } })();
			expect(failure).toBeInstanceOf(FactoryParseError);
			expect((failure as FactoryParseError).message).not.toBe("");
		}
		// The editor cannot absorb it either: its node and source checks refuse unknown shapes.
		expect(() => parseFactoryNode(JSON.stringify({ id: "x", kind: "future-kind" }))).toThrow("Node JSON needs a supported kind and a string ID.");
	});
});
