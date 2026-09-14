import { expect, test } from "bun:test";
import { compileFactory, referenceCodeV1, referenceImageV1 } from "@ezcorp/factory-sdk";
import type { CompiledFactory, FactoryDefinition, FactoryNode } from "@ezcorp/factory-sdk";
import { factoryBoundedReplacement, FactoryRunControlError } from "./run-controls";

function compiled(definition: FactoryDefinition): CompiledFactory {
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map(item => item.code).join(","));
  return result.factory;
}

/** One revision, optionally altered before it is compiled. */
function revision(edit: (definition: FactoryDefinition) => void = () => {}, source: FactoryDefinition = referenceCodeV1): CompiledFactory {
  const definition = structuredClone(source);
  edit(definition);
  definition.version = "2.0.0";
  return compiled(definition);
}

function nodeIn(definition: FactoryDefinition, id: string): FactoryNode {
  return definition.graph.nodes.find(node => node.id === id)!;
}

const RUN_DEADLINE_MS = 3 * 24 * 60 * 60 * 1_000;

/** The revision a replan starts from, narrow enough that every widening is expressible. */
function widest(definition: FactoryDefinition): void {
  definition.capabilities = ["repository.read", "repository.write"];
  definition.effects = ["none", "read", "write"];
  definition.bounds = { ...definition.bounds, runDeadlineMs: RUN_DEADLINE_MS, maxExpandedNodes: 64, maxScopeDepth: 8 };
  (nodeIn(definition, "github-pr-release") as { effects: unknown }).effects = ["write"];
  (nodeIn(definition, "protected-checks") as { resources: unknown }).resources = { maxCostMicros: "500", maxTokens: 10, maxComputeMs: 20, memoryBytes: 64, resourceClass: "cpu" };
}

test("an identical revision is a bounded replacement and a narrower one still is", () => {
  const current = revision(widest);
  expect(factoryBoundedReplacement(current, revision(widest))).toBe(true);
  expect(factoryBoundedReplacement(current, revision(definition => {
    widest(definition);
    definition.bounds = { ...definition.bounds, runDeadlineMs: RUN_DEADLINE_MS - 1, maxExpandedNodes: definition.bounds.maxExpandedNodes - 1, maxScopeDepth: definition.bounds.maxScopeDepth - 1 };
    definition.capabilities = ["repository.read"];
    (nodeIn(definition, "protected-checks") as { resources: unknown }).resources = { maxCostMicros: "499", maxTokens: 9, maxComputeMs: 19, memoryBytes: 63 };
  }))).toBe(true);
});

test("each widening is denied on its own", () => {
  const current = revision(widest);
  const denials: [string, (definition: FactoryDefinition) => void][] = [
    ["a different protected contract", definition => { definition.acceptance = { ...definition.acceptance, version: "2.0.0" }; }],
    ["a dropped protected claim", definition => { definition.acceptance = { ...definition.acceptance, claims: definition.acceptance.claims.slice(1) }; }],
    ["a changed input boundary", definition => { definition.inputPorts = { ...definition.inputPorts, extra: { type: "string" } }; }],
    ["a changed output boundary", definition => {
      definition.outputPorts = { ...definition.outputPorts, extra: { type: "object", additionalProperties: true } };
      definition.graph.outputs = { ...definition.graph.outputs, extra: { kind: "ref", root: "node", name: "github-pr-release", path: ["receipt"] } };
    }],
    ["a different interpreter", definition => { definition.interpreterCompatibility = "factory-kernel.v2"; }],
    ["a longer run deadline", definition => { definition.bounds = { ...definition.bounds, runDeadlineMs: RUN_DEADLINE_MS + 1 }; }],
    ["more expanded nodes", definition => { definition.bounds = { ...definition.bounds, maxExpandedNodes: definition.bounds.maxExpandedNodes + 1 }; }],
    ["a deeper scope", definition => { definition.bounds = { ...definition.bounds, maxScopeDepth: definition.bounds.maxScopeDepth + 1 }; }],
    ["a new capability", definition => { definition.capabilities = [...definition.capabilities, "repository.admin"]; }],
    ["a new effect", definition => { definition.effects = ["none", "read", "write", "publish"]; (nodeIn(definition, "github-pr-release") as { effects: unknown }).effects = ["publish"]; }],
    ["more declared cost", definition => { (nodeIn(definition, "protected-checks") as { resources: { maxCostMicros: string } }).resources.maxCostMicros = "501"; }],
    ["more declared tokens", definition => { (nodeIn(definition, "protected-checks") as { resources: { maxTokens: number } }).resources.maxTokens = 11; }],
    ["more declared compute", definition => { (nodeIn(definition, "protected-checks") as { resources: { maxComputeMs: number } }).resources.maxComputeMs = 21; }],
    ["more declared memory", definition => { (nodeIn(definition, "protected-checks") as { resources: { memoryBytes: number } }).resources.memoryBytes = 65; }],
    ["an undeclared resource class", definition => { (nodeIn(definition, "protected-checks") as { resources: { resourceClass: string } }).resources.resourceClass = "gpu"; }],
    ["demand declared on a second node", definition => { (nodeIn(definition, "snapshot-repository") as { resources: unknown }).resources = { maxTokens: 11 }; }],
  ];

  for (const [reason, edit] of denials) {
    const replacement = revision(definition => { widest(definition); edit(definition); });
    expect({ reason, bounded: factoryBoundedReplacement(current, replacement) }).toEqual({ reason, bounded: false });
  }
});

test("declared demand is read from every nested node and from a loop budget", () => {
  const current = revision(definition => {
    (nodeIn(definition, "candidate-rounds") as { budget: unknown }).budget = { maxCostMicros: "900", maxTokens: 90, maxComputeMs: 900 };
  }, referenceImageV1);
  const equal = revision(definition => {
    (nodeIn(definition, "candidate-rounds") as { budget: unknown }).budget = { maxCostMicros: "900", maxTokens: 90, maxComputeMs: 900 };
  }, referenceImageV1);
  expect(factoryBoundedReplacement(current, equal)).toBe(true);

  const wider = revision(definition => {
    (nodeIn(definition, "candidate-rounds") as { budget: unknown }).budget = { maxCostMicros: "901", maxTokens: 90, maxComputeMs: 900 };
  }, referenceImageV1);
  expect(factoryBoundedReplacement(current, wider)).toBe(false);

  // The GPU demand of a node nested two scopes deep counts as the replacement's own demand.
  const gpuFree = revision(definition => {
    (nodeIn(definition, "candidate-rounds") as { budget: unknown }).budget = { maxCostMicros: "900", maxTokens: 90, maxComputeMs: 900 };
    const rounds = nodeIn(definition, "candidate-rounds");
    if (rounds.kind !== "loop") throw new Error("fixture");
    const map = rounds.body.nodes.find(node => node.id === "generate-four-seeds")!;
    (map as { resources: unknown }).resources = { maxComputeMs: 900 };
  }, referenceImageV1);
  expect(factoryBoundedReplacement(gpuFree, current)).toBe(false);
  expect(factoryBoundedReplacement(current, gpuFree)).toBe(true);
});

test("a demand that is not a whole non-negative count is corrupt, never silently bounded", () => {
  const current = revision();
  for (const value of [{ maxTokens: 1.5 }, { maxCostMicros: "-1" }, { maxCostMicros: "1e3" }]) {
    const forged = structuredClone(current) as CompiledFactory;
    (forged.definition.graph.nodes.find(node => node.id === "protected-checks") as { resources: unknown }).resources = value;
    expect(() => factoryBoundedReplacement(forged, current)).toThrow(FactoryRunControlError);
    expect(() => factoryBoundedReplacement(current, forged)).toThrow("factory_control_corrupt");
  }
});
