import { expect, test } from "bun:test";
import { compileFactory } from "./compiler";
import { referenceCodeV1 } from "./references.js";
import { simulateFactory } from "./simulator";
import type { FactoryDefinition, FactoryNode } from "./index";

const digest = "sha256:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const runner = { package: "inert", version: "1", digest, export: "run" } as const;
const child = { id: "child.factory", version: "1", digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" } as const;
const string = { type: "string" } as const;

function compiled(nodes: readonly FactoryNode[]) {
  const definition: FactoryDefinition = {
    schemaVersion: "factory.v1", id: "simulator-coverage", version: "1", interpreterCompatibility: "1", inputPorts: {}, outputPorts: {}, graph: { nodes, outputs: {} },
    acceptance: referenceCodeV1.acceptance, packages: [...referenceCodeV1.packages, { name: runner.package, version: runner.version, digest }], factories: [child], capabilities: [], effects: ["none"],
    bounds: { maxExpandedNodes: 100, maxScopeDepth: 16 },
  };
  const result = compileFactory(definition);
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.nodeId ?? "definition"}`).join(", "));
  return result.factory;
}

test("simulator drives malformed subfactory and acceptance results through the production output fence", () => {
  const cases: readonly [string, FactoryNode, "child" | "acceptance"][] = [
    ["child", { id: "child", kind: "subfactory", factory: child, releaseMode: "none", grants: [], outputPorts: { value: string } }, "child"],
    ["accept", { id: "accept", kind: "acceptance", contract: referenceCodeV1.acceptance.id, candidate: { kind: "literal", value: "candidate" }, evidence: { kind: "literal", value: "evidence" }, outputPorts: { acceptedCandidate: string } }, "acceptance"],
  ];
  for (const [id, node, callback] of cases) {
    const result = simulateFactory(compiled([node]), `invalid-${id}`, {}, {
      [callback]: () => ({ kind: "success", output: { [callback === "acceptance" ? "acceptedCandidate" : "value"]: 1 } }),
    });
    expect(result.state.status).toBe("failed");
    expect(result.state.nodes[id]?.error).toBe("OUTPUT_INVALID");
  }
});

test("simulator fences a malformed release result after its accepted candidate", () => {
  const acceptance: Extract<FactoryNode, { kind: "acceptance" }> = {
    id: "accept", kind: "acceptance", contract: referenceCodeV1.acceptance.id, candidate: { kind: "literal", value: "candidate" }, evidence: { kind: "literal", value: "evidence" }, outputPorts: { acceptedCandidate: string },
  };
  const release: Extract<FactoryNode, { kind: "release" }> = {
    id: "release", kind: "release", dependsOn: ["accept"], adapter: runner, acceptedCandidate: { kind: "ref", root: "node", name: "accept", path: ["acceptedCandidate"] }, destination: { kind: "literal", value: "destination" }, outputPorts: { receipt: string },
  };
  const result = simulateFactory(compiled([acceptance, release]), "invalid-release", {}, {
    acceptance: () => ({ kind: "success", output: { acceptedCandidate: "candidate" } }),
    release: () => ({ kind: "success", output: { receipt: 1 } }),
  });
  expect(result.state.status).toBe("failed");
  expect(result.state.nodes.release?.error).toBe("OUTPUT_INVALID");
  expect(result.commands).toContainEqual(expect.objectContaining({ kind: "fail-run", error: "OUTPUT_INVALID" }));
});

test("simulator turns an unanswered approval into its deterministic expiry path", () => {
  const factory = compiled([{
    id: "approval", kind: "approval", choices: ["approve", "deny"], context: { kind: "literal", value: {} }, actorScope: "operator", expiresInMs: 10,
    onDenied: "fail", onExpired: "fail", outputPorts: { choice: { type: "string", enum: ["approve", "deny"] } },
  }]);
  const result = simulateFactory(factory, "unanswered-approval", {}, { approval: () => undefined });
  expect(result.state.status).toBe("failed");
  expect(result.state.nodes.approval?.error).toBe("APPROVAL_EXPIRED");
  expect(result.events.some((event) => event.kind === "timer-expired" && event.nodeId === "approval")).toBe(true);
});
