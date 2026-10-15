import { expect, test } from "bun:test";
import { compileFactory } from "@ezcorp/factory-sdk/compiler";
import { createKernelState, referenceCodeV1, referenceImageV1, type CompiledFactory, type FactoryDefinition, type JsonValue, type KernelAttempt, type KernelState } from "@ezcorp/factory-sdk";
import { resolveFactoryProtectedNodeSource, resolveFactoryProtectedTaskSource } from "./protected-command-provenance";

const attempt = (commandId: string, candidateGeneration = 0): KernelAttempt => ({ candidateGeneration, attempt: 1, commandId, startedAtMs: 1, deadlineAtMs: 100, stopped: true, uncertain: false });
const compiled = (source: FactoryDefinition): CompiledFactory => {
  const result = compileFactory(source);
  if (!result.ok) throw new Error("reference fixture did not compile");
  return result.factory;
};
const withNodes = (factory: CompiledFactory, input: JsonValue, nodes: KernelState["nodes"]): KernelState => {
  const state = createKernelState(factory, "run", input, 1);
  return { ...state, nodes: { ...state.nodes, ...nodes } };
};
const codeInput = { repositoryConnection: {}, baseCommitSha: "a", request: "request", destinationRepository: {}, baseBranch: "main" };

test("traces a direct protected candidate to its exact stopped task attempt", () => {
  const factory = compiled(referenceCodeV1);
  const candidate = { digest: `sha256:${"a".repeat(64)}`, mediaType: "application/json", storage: "immutable" };
  const sourceAttempt = attempt("freeze-command");
  const state = withNodes(factory, codeInput, {
    "freeze-complete-git-tree": { status: "succeeded", candidateGeneration: 0, nextAttempt: 2, attempts: [sourceAttempt], output: { candidate } },
  });
  const acceptance = referenceCodeV1.graph.nodes.find(node => node.id === "acceptance");
  if (acceptance?.kind !== "acceptance") throw new Error("acceptance fixture is missing");
  const source = resolveFactoryProtectedTaskSource(factory, state, "acceptance", acceptance.candidate, candidate);
  expect(source).toEqual({ nodeInstanceId: "freeze-complete-git-tree", candidateGeneration: 0, attempt: sourceAttempt, path: ["candidate"] });
});

test("traces the retained winning loop output and rejects prior repaired evidence", () => {
  const factory = compiled(referenceImageV1);
  const candidate = { digest: `sha256:${"b".repeat(64)}`, mediaType: "image/png", storage: "immutable" };
  const sourceAttempt = attempt("select-command", 1);
  const result = { accepted: true, candidate, evidence: [], revisedPrompt: "done" };
  const state = withNodes(factory, { brief: "image", outputName: "image.png", destination: {} }, {
    "candidate-rounds": { status: "succeeded", candidateGeneration: 1, nextAttempt: 1, attempts: [], output: result, loop: { iteration: 1, carried: "retry", startedAtMs: 1, spentCostMicros: "0", unknownCostMicros: "0" } },
    "candidate-rounds/items/1/choose-first-accepted": { status: "succeeded", candidateGeneration: 1, nextAttempt: 2, attempts: [sourceAttempt], output: { result } },
  });
  const acceptance = referenceImageV1.graph.nodes.find(node => node.id === "acceptance")!;
  if (acceptance.kind !== "acceptance") throw new Error("acceptance fixture is missing");
  expect(resolveFactoryProtectedTaskSource(factory, state, "acceptance", acceptance.candidate, candidate)).toEqual({ nodeInstanceId: "candidate-rounds/items/1/choose-first-accepted", candidateGeneration: 1, attempt: sourceAttempt, path: ["result", "candidate"] });
  const repaired = { ...state, nodes: { ...state.nodes, "candidate-rounds/items/1/choose-first-accepted": { ...state.nodes["candidate-rounds/items/1/choose-first-accepted"]!, candidateGeneration: 2 } } };
  expect(() => resolveFactoryProtectedTaskSource(factory, repaired, "acceptance", acceptance.candidate, candidate)).toThrow("factory_protected_source_stale");
});

test("rejects literals, changed values, live attempts, and sources without retained task provenance", () => {
  const factory = compiled(referenceCodeV1);
  const candidate = { digest: `sha256:${"c".repeat(64)}`, mediaType: "application/json", storage: "immutable" };
  const state = withNodes(factory, codeInput, {
    "freeze-complete-git-tree": { status: "succeeded", candidateGeneration: 0, nextAttempt: 2, attempts: [{ ...attempt("live"), stopped: false }], output: { candidate } },
  });
  expect(() => resolveFactoryProtectedTaskSource(factory, state, "acceptance", { kind: "literal", value: candidate }, candidate)).toThrow("factory_protected_source_unsupported");
  expect(() => resolveFactoryProtectedTaskSource(factory, state, "acceptance", { kind: "ref", root: "node", name: "freeze-complete-git-tree", path: ["candidate"] }, { ...candidate, storage: "changed" })).toThrow("factory_protected_source_stale");
  expect(() => resolveFactoryProtectedTaskSource(factory, state, "acceptance", { kind: "ref", root: "node", name: "freeze-complete-git-tree", path: ["candidate"] }, candidate)).toThrow("factory_protected_source_stale");
  expect(() => resolveFactoryProtectedTaskSource(factory, state, "acceptance", { kind: "ref", root: "input", name: "candidate" }, candidate)).toThrow("factory_protected_source_unsupported");
});

test("binds a release value to the exact stopped acceptance attempt", () => {
  const factory = compiled(referenceCodeV1);
  const candidate = { digest: `sha256:${"d".repeat(64)}`, mediaType: "application/json", storage: "immutable" };
  const sourceAttempt = attempt("accept-command");
  const state = withNodes(factory, codeInput, {
    acceptance: { status: "succeeded", candidateGeneration: 0, nextAttempt: 2, attempts: [sourceAttempt], output: { acceptedCandidate: candidate } },
  });
  const release = referenceCodeV1.graph.nodes.find(node => node.id === "github-pr-release");
  if (release?.kind !== "release") throw new Error("release fixture is missing");
  expect(resolveFactoryProtectedNodeSource(factory, state, release.id, release.acceptedCandidate, candidate, "acceptance")).toEqual({ nodeInstanceId: "acceptance", candidateGeneration: 0, attempt: sourceAttempt, path: ["acceptedCandidate"], kind: "acceptance" });
});
