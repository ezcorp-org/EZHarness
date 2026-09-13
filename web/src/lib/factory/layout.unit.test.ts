import { describe, expect, test } from "vitest";
import { layoutFactoryGraph } from "./layout";

describe("factory ELK layout", () => {
	test("lays out the same directed graph deterministically with accessible flow records", async () => {
		const projection = {
			nodes: [
				{ id: "prepare", nodeId: "prepare", kind: "task" as const, label: "Prepare a very long candidate label", diagnosticCount: 0 },
				{ id: "release", nodeId: "release", kind: "release" as const, label: "Release", diagnosticCount: 2 },
			],
			edges: [{ id: "prepare->release", source: "prepare", target: "release" }],
			childGraphs: [],
		};
		const first = await layoutFactoryGraph(projection);
		const second = await layoutFactoryGraph(projection);
		expect(first).toEqual(second);
		expect(first.nodes).toHaveLength(2);
		expect(first.nodes[0]).toMatchObject({
			type: "factory",
			data: { nodeId: "prepare", kind: "task" },
			ariaLabel: "Prepare a very long candidate label, task",
		});
		expect(first.nodes[1]?.ariaLabel).toContain("2 diagnostics");
		expect(first.nodes[1]!.position.x).toBeGreaterThan(first.nodes[0]!.position.x);
		expect(first.edges).toEqual([
			expect.objectContaining({ id: "prepare->release", type: "smoothstep", focusable: true }),
		]);
	});

	test("does not load ELK for an empty graph", async () => {
		expect(await layoutFactoryGraph({ nodes: [], edges: [], childGraphs: [] })).toEqual({ nodes: [], edges: [] });
	});
});
