import { describe, expect, test } from "bun:test";
import { FactoryAuthoringError, defineFactory } from "./authoring";
import { compileFactory } from "./compiler";
import { referenceCatalogV1, referenceCodeV1, referenceDataV1, referenceFactories, referenceImageV1 } from "./references";
import type { FactoryDefinition, FactoryNode } from "./types";

function clone(definition: FactoryDefinition = referenceCodeV1): FactoryDefinition {
  return structuredClone(definition);
}

function codes(definition: unknown): string[] {
  const result = compileFactory(definition);
  return result.ok ? [] : result.diagnostics.map((entry) => entry.code);
}

function node(definition: FactoryDefinition, id: string): FactoryNode {
  return definition.graph.nodes.find((candidate) => candidate.id === id) as FactoryNode;
}

describe("factory compiler", () => {
  test("compiles exact C10 signatures deterministically into immutable pinned IR", () => {
    expect(referenceFactories.map((item) => item.id)).toEqual(["reference.code.v1", "reference.image.v1", "reference.data.v1", "reference.catalog.v1"]);
    for (const definition of [referenceCodeV1, referenceImageV1, referenceDataV1, referenceCatalogV1]) {
      const first = compileFactory(definition);
      const second = compileFactory(structuredClone(definition));
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) continue;
      expect(first.factory.digest).toBe(second.factory.digest);
      expect(first.factory.schemaVersion).toBe("factory.ir.v1");
      expect(first.factory.lock.packages).toEqual([...first.factory.lock.packages].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      expect(first.factory.pages.every((page) => page.encodedBytes <= 32 * 1024)).toBe(true);
      expect(first.factory.partitions.every((partition) => partition.nodeIds.length <= 128)).toBe(true);
      expect(Object.isFrozen(first.factory)).toBe(true);
      expect(Object.isFrozen(first.factory.definition.graph.nodes)).toBe(true);
    }
  });

  test("materializes defaults and separates presentation digest", () => {
    const left = clone();
    const right = clone();
    left.presentation = { x: 1 };
    right.presentation = { x: 2 };
    const first = compileFactory(left);
    const second = compileFactory(right);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.factory.digest).toBe(second.factory.digest);
    expect(first.factory.presentationDigest).not.toBe(second.factory.presentationDigest);
    expect(first.factory.definition.bounds.runDeadlineMs).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(first.factory.definition.graph.nodes[0]?.deadlineMs).toBe(30 * 60 * 1_000);
  });

  test("uses safe own-property indexes for hostile identifiers", () => {
    const definition = clone(referenceDataV1);
    const first = definition.graph.nodes[0] as { id: string };
    const oldId = first.id;
    first.id = "__proto__";
    for (const candidate of definition.graph.nodes) if (candidate.dependsOn?.includes(oldId)) (candidate as { dependsOn: string[] }).dependsOn = candidate.dependsOn.map((id) => id === oldId ? "__proto__" : id);
    const result = compileFactory(definition);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getPrototypeOf(result.factory.indexes.nodeById)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result.factory.indexes.nodeById, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("rejects invalid root bounds and immutable pins", () => {
    expect(codes(undefined)).toEqual(["FACTORY_SCHEMA"]);
    for (const [field, value, code] of [
      ["maxExpandedNodes", 0, "BOUND_EXPANDED_NODES"],
      ["maxScopeDepth", 17, "BOUND_SCOPE_DEPTH"],
      ["runDeadlineMs", 31 * 24 * 60 * 60 * 1_000, "BOUND_RUN_DEADLINE"],
    ] as const) {
      const definition = clone();
      (definition.bounds as Record<string, number>)[field] = value;
      expect(codes(definition)).toContain(code);
    }
    const moving = clone();
    (moving.packages[0] as { version: string }).version = "latest";
    expect(codes(moving)).toContain("REFERENCE_VERSION");
    const badDigest = clone();
    (badDigest.packages[0] as { digest: string }).digest = "sha256:BAD";
    expect(codes(badDigest)).toContain("REFERENCE_DIGEST");
    const duplicate = clone();
    (duplicate as { packages: unknown[] }).packages.push(structuredClone(duplicate.packages[0]));
    expect(codes(duplicate)).toContain("REFERENCE_DUPLICATE");
  });

  test("rejects graph cycles, missing dependencies, duplicate IDs, and bad outputs", () => {
    const cycle = clone();
    (cycle.graph.nodes[0] as { dependsOn?: string[] }).dependsOn = [cycle.graph.nodes[1]!.id];
    expect(codes(cycle)).toContain("GRAPH_CYCLE");
    const missing = clone();
    (missing.graph.nodes[0] as { dependsOn?: string[] }).dependsOn = ["missing"];
    expect(codes(missing)).toContain("GRAPH_MISSING_NODE");
    const duplicate = clone();
    (duplicate.graph.nodes[1] as { id: string }).id = duplicate.graph.nodes[0]!.id;
    expect(codes(duplicate)).toContain("GRAPH_DUPLICATE_NODE");
    const noOutput = clone();
    delete (noOutput.graph.outputs as Record<string, unknown>).receipt;
    expect(codes(noOutput)).toContain("GRAPH_OUTPUT_MISSING");
    const unknownOutput = clone();
    (unknownOutput.graph.outputs as Record<string, unknown>).other = { kind: "literal", value: true };
    expect(codes(unknownOutput)).toContain("GRAPH_OUTPUT_UNKNOWN");
    const incompatible = clone();
    (incompatible.outputPorts as Record<string, unknown>).receipt = { type: "string" };
    expect(codes(incompatible)).toContain("GRAPH_OUTPUT_INCOMPATIBLE");
  });

  test("rejects bindings that are missing, unknown, unreachable, or incompatible", () => {
    const definition = clone();
    const target = node(definition, "freeze-complete-git-tree") as { inputPorts: Record<string, unknown>; bindings: Record<string, unknown>; dependsOn: string[] };
    target.inputPorts = { candidate: { type: "string" } };
    target.bindings = { candidate: { kind: "ref", root: "node", name: "snapshot-repository", path: ["snapshot"] }, extra: { kind: "literal", value: true } };
    expect(codes(definition)).toEqual(expect.arrayContaining(["BINDING_INCOMPATIBLE", "BINDING_REACHABILITY", "BINDING_UNKNOWN"]));
    const absent = clone();
    (node(absent, "freeze-complete-git-tree") as { inputPorts: Record<string, unknown> }).inputPorts = { candidate: { type: "string" } };
    expect(codes(absent)).toContain("BINDING_MISSING");
    const missingInput = clone();
    (node(missingInput, "freeze-complete-git-tree") as { inputPorts: Record<string, unknown>; bindings: Record<string, unknown> }).inputPorts = { candidate: { type: "string" } };
    (node(missingInput, "freeze-complete-git-tree") as { bindings: Record<string, unknown> }).bindings = { candidate: { kind: "ref", root: "input", name: "missing" } };
    expect(codes(missingInput)).toContain("BINDING_INPUT");
  });

  test("rejects authority widening and unsafe control bounds", () => {
    const capability = clone();
    (node(capability, "snapshot-repository") as { capabilities: string[] }).capabilities = ["admin"];
    expect(codes(capability)).toContain("AUTHORITY_CAPABILITY");
    const effect = clone();
    effect.effects = ["read"];
    expect(codes(effect)).toContain("AUTHORITY_EFFECT");
    const cost = clone();
    (node(cost, "snapshot-repository") as { resources: unknown }).resources = { maxCostMicros: "01" };
    expect(codes(cost)).toContain("BOUND_COST");
    const deadline = clone();
    (node(deadline, "snapshot-repository") as { deadlineMs: number }).deadlineMs = 0;
    expect(codes(deadline)).toContain("BOUND_NODE_DEADLINE");
    const retry = clone();
    (node(retry, "snapshot-repository") as { retry: unknown }).retry = { maxAttempts: 0, initialDelayMs: 2, maximumDelayMs: 1 };
    expect(codes(retry)).toContain("BOUND_RETRY");
    const loop = clone();
    (node(loop, "bounded-repair") as { maxIterations: number; budget: unknown }).maxIterations = 0;
    (node(loop, "bounded-repair") as { budget: unknown }).budget = { maxCostMicros: "-1" };
    expect(codes(loop)).toEqual(expect.arrayContaining(["BOUND_LOOP", "BOUND_COST"]));
    const map = clone(referenceImageV1);
    (node(map, "generate-four-seeds") as { maxConcurrency: number }).maxConcurrency = 0;
    expect(codes(map)).toContain("BOUND_MAP");
  });

  test("rejects malformed joins, approvals, release authority, and expressions", () => {
    const approval = clone();
    (node(approval, "release-approval") as { choices: string[] }).choices = [];
    expect(codes(approval)).toContain("BOUND_APPROVAL");
    const release = clone();
    (node(release, "github-pr-release") as { dependsOn: string[] }).dependsOn = ["release-approval"];
    expect(codes(release)).toContain("RELEASE_ACCEPTANCE");
    const expression = clone();
    (node(expression, "bounded-repair") as { until: unknown }).until = { kind: "wat" };
    expect(codes(expression)).toContain("FACTORY_SCHEMA");
    const joinBase = clone();
    (joinBase.graph.nodes as FactoryNode[]).splice(1, 0, { id: "join", kind: "join", mode: "any", predecessors: ["snapshot-repository"], quorum: 0 });
    expect(codes(joinBase)).toContain("JOIN_CONFIGURATION");
    const all = clone();
    (all.graph.nodes as FactoryNode[]).splice(1, 0, { id: "join", kind: "join", mode: "all", predecessors: ["snapshot-repository"], quorum: 1, eligibleOutcomes: ["succeeded"] });
    expect(codes(all)).toContain("JOIN_CONFIGURATION");
  });

  test("rejects speculative publication, unlocked dependencies, and validator authority overlap", () => {
    const branch = clone();
    (branch.graph.nodes as FactoryNode[]).splice(1, 0, { id: "branch", kind: "branch", condition: { kind: "literal", value: true }, then: { nodes: [structuredClone(node(branch, "github-pr-release"))], outputs: {} }, else: { nodes: [], outputs: {} } });
    expect(codes(branch)).toContain("SPECULATIVE_PUBLICATION");
    const unlocked = clone();
    (node(unlocked, "snapshot-repository") as { runner: { digest: string } }).runner.digest = `sha256:${"1".repeat(64)}`;
    expect(codes(unlocked)).toContain("REFERENCE_UNLOCKED");
    const overlap = clone();
    (overlap.acceptance.claims[0] as { validator: unknown }).validator = structuredClone((node(overlap, "generate-private-candidate") as { runner: unknown }).runner);
    expect(codes(overlap)).toContain("ACCEPTANCE_AUTHORITY");
  });

  test("authoring returns the canonical definition or located diagnostics", () => {
    expect(defineFactory(referenceCodeV1).id).toBe("reference.code.v1");
    expect(() => defineFactory({ ...referenceCodeV1, bounds: { ...referenceCodeV1.bounds, maxExpandedNodes: 0 } })).toThrow(FactoryAuthoringError);
  });
});
