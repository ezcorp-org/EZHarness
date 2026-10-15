import { expect, test } from "bun:test";
import type { ConsentCapability, ConsentHashSources } from "../../runtime/workflow-capability-hash";
import { workflowExecutionHash } from "../../runtime/workflow-definition-hash";
import type { WorkflowDefinition, WorkflowStep } from "../../types";
import {
  classifyLegacyWorkflow,
  legacyWorkflowClassificationDigest,
  LEGACY_WORKFLOW_CLASSIFICATION_SCHEMA_VERSION,
  LEGACY_WORKFLOW_DENIED_CAPABILITY_KINDS,
} from "./classification";

function definition(name: string, steps: WorkflowStep[]): WorkflowDefinition {
  return { name, description: `${name} fixture`, steps };
}

function toolStep(name: string, tool: string): WorkflowStep {
  return { name, kind: "tool", tool };
}

function sourcesFor(
  definitions: readonly WorkflowDefinition[],
  tools: Readonly<Record<string, readonly ConsentCapability[] | undefined>>,
  agents: Readonly<Record<string, readonly ConsentCapability[] | undefined>> = {},
): ConsentHashSources {
  const byName = new Map(definitions.map(entry => [entry.name, entry] as const));
  return {
    resolve: (name: string) => byName.get(name),
    identify: () => ({ kind: "unversioned" }),
    capabilitiesForTool: (tool: string) => (Object.hasOwn(tools, tool) ? tools[tool] : undefined),
    capabilitiesForAgent: (agent: string) => (Object.hasOwn(agents, agent) ? agents[agent] : undefined),
  };
}

test("a workflow whose every tool is reachable and effect-free is non-publishing", () => {
  const root = definition("summarize", [toolStep("read", "notes__read_note"), { name: "shape", kind: "transform", output: { summary: "$steps.read.output" } }]);
  const classification = classifyLegacyWorkflow(root, sourcesFor([root], { notes__read_note: [{ kind: "fs.read", value: "/project" }, { kind: "storage" }] }));

  expect(classification.verdict).toBe("non-publishing");
  expect(classification.findings).toEqual([]);
  expect(classification.closure).toEqual(["summarize"]);
  expect(classification.schemaVersion).toBe(LEGACY_WORKFLOW_CLASSIFICATION_SCHEMA_VERSION);
  expect(classification.definitionDigest).toBe(workflowExecutionHash(root));
  expect(classification.capabilities).toContain("tool::notes__read_note");
  expect(classification.capabilities).toContain("fs.read::/project");
});

test("a shell-bearing step is publishing, and names the capability that made it so", () => {
  const root = definition("deploy", [toolStep("run", "ops__run_command")]);
  const classification = classifyLegacyWorkflow(root, sourcesFor([root], { ops__run_command: [{ kind: "shell" }] }));

  expect(classification.verdict).toBe("publishing");
  expect(classification.findings).toEqual([{ workflowName: "deploy", reason: "shell", detail: "shell::" }]);
});

test("a network-capable extension tool is publishing whichever kind declares the reach", () => {
  const cases: ReadonlyArray<readonly [ConsentCapability, string]> = [
    [{ kind: "network", value: "api.github.com" }, "network::api.github.com"],
    [{ kind: "network.tcp", value: "10.0.0.1:5432" }, "network.tcp::10.0.0.1:5432"],
  ];
  for (const [capability, key] of cases) {
    const root = definition("fetcher", [toolStep("call", "web__fetch")]);
    const classification = classifyLegacyWorkflow(root, sourcesFor([root], { web__fetch: [capability] }));
    expect(classification.verdict).toBe("publishing");
    expect(classification.findings).toEqual([{ workflowName: "fetcher", reason: "network", detail: key }]);
  }
});

test("an agent that declares http reach is publishing under the same rule", () => {
  const root = definition("researcher", [{ name: "ask", kind: "agent", agent: "scout" }]);
  const classification = classifyLegacyWorkflow(root, sourcesFor([root], {}, { scout: [{ kind: "http" }] }));

  expect(classification.verdict).toBe("publishing");
  expect(classification.findings).toEqual([{ workflowName: "researcher", reason: "network", detail: "http::" }]);
});

test("an MCP-invoking tool is publishing", () => {
  const root = definition("bridge", [toolStep("call", "server__invoke")]);
  const classification = classifyLegacyWorkflow(root, sourcesFor([root], { server__invoke: [{ kind: "ezcorp:mcp:invoke" }] }));

  expect(classification.verdict).toBe("publishing");
  expect(classification.findings).toEqual([{ workflowName: "bridge", reason: "mcp", detail: "ezcorp:mcp:invoke::" }]);
});

test("a capability kind the host cannot classify is publishing rather than assumed benign", () => {
  const root = definition("odd", [toolStep("call", "plugin__do")]);
  const classification = classifyLegacyWorkflow(root, sourcesFor([root], { plugin__do: [{ kind: "custom", value: "vendor:thing" }] }));

  expect(classification.verdict).toBe("publishing");
  expect(classification.findings).toEqual([{ workflowName: "odd", reason: "unclassified-capability", detail: "custom::vendor:thing" }]);
});

test("a tool or agent the host cannot resolve is classified by absence of evidence and refused", () => {
  const toolRoot = definition("ghost-tool", [toolStep("call", "missing__tool")]);
  const toolVerdict = classifyLegacyWorkflow(toolRoot, sourcesFor([toolRoot], {}));
  expect(toolVerdict.verdict).toBe("publishing");
  expect(toolVerdict.findings).toEqual([{ workflowName: "ghost-tool", reason: "unreachable-tool", detail: "tool:unreachable::missing__tool" }]);

  const agentRoot = definition("ghost-agent", [{ name: "ask", kind: "agent", agent: "missing" }]);
  const agentVerdict = classifyLegacyWorkflow(agentRoot, sourcesFor([agentRoot], {}));
  expect(agentVerdict.verdict).toBe("publishing");
  expect(agentVerdict.findings).toEqual([{ workflowName: "ghost-agent", reason: "unreachable-agent", detail: "agent:unreachable::missing" }]);
});

test("a nested workflow inside the allowlist stays non-publishing, and one outside it does not", () => {
  const child = definition("child", [toolStep("read", "notes__read_note")]);
  const parent = definition("parent", [{ name: "delegate", kind: "workflow", workflow: "child" }]);
  const tools = { notes__read_note: [{ kind: "fs.read", value: "/project" }] };
  const inside = classifyLegacyWorkflow(parent, sourcesFor([parent, child], tools));
  expect(inside.verdict).toBe("non-publishing");
  expect(inside.closure).toEqual(["child", "parent"]);

  const shelling = definition("child", [toolStep("run", "ops__run_command")]);
  const outside = classifyLegacyWorkflow(parent, sourcesFor([parent, shelling], { ...tools, ops__run_command: [{ kind: "shell" }] }));
  expect(outside.verdict).toBe("publishing");
  expect(outside.findings).toEqual([{ workflowName: "child", reason: "shell", detail: "shell::" }]);
});

test("a nested name the resolver cannot answer is a finding, not a pass", () => {
  const parent = definition("parent", [{ name: "delegate", kind: "workflow", workflow: "absent" }]);
  const classification = classifyLegacyWorkflow(parent, sourcesFor([parent], {}));

  expect(classification.verdict).toBe("publishing");
  expect(classification.findings).toEqual([{ workflowName: "parent", reason: "unresolved-workflow", detail: "absent" }]);
});

test("a cycle and a graph below the depth cap are both findings", () => {
  const left = definition("left", [{ name: "go", kind: "workflow", workflow: "right" }]);
  const right = definition("right", [{ name: "back", kind: "workflow", workflow: "left" }]);
  const cyclic = classifyLegacyWorkflow(left, sourcesFor([left, right], {}));
  expect(cyclic.findings.some(finding => finding.reason === "workflow-cycle")).toBe(true);
  expect(cyclic.verdict).toBe("publishing");

  const chain = ["a", "b", "c", "d", "e"].map((name, index, names) =>
    definition(name, index + 1 < names.length ? [{ name: "next", kind: "workflow", workflow: names[index + 1]! }] : [toolStep("read", "notes__read_note")]),
  );
  const deep = classifyLegacyWorkflow(chain[0]!, sourcesFor(chain, { notes__read_note: [{ kind: "fs.read", value: "/project" }] }));
  expect(deep.findings.some(finding => finding.reason === "workflow-too-deep")).toBe(true);
  expect(deep.verdict).toBe("publishing");
});

test("the classification digest moves when the graph does, and an attestation therefore cannot follow it", () => {
  const clean = definition("edited", [toolStep("read", "notes__read_note")]);
  const tools = { notes__read_note: [{ kind: "fs.read", value: "/project" }], ops__run_command: [{ kind: "shell" }] };
  const before = classifyLegacyWorkflow(clean, sourcesFor([clean], tools));
  const edited = definition("edited", [toolStep("read", "notes__read_note"), toolStep("run", "ops__run_command")]);
  const after = classifyLegacyWorkflow(edited, sourcesFor([edited], tools));

  expect(legacyWorkflowClassificationDigest(before)).not.toBe(legacyWorkflowClassificationDigest(after));
  expect(before.definitionDigest).not.toBe(after.definitionDigest);
  expect(legacyWorkflowClassificationDigest(before)).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(legacyWorkflowClassificationDigest(before)).toBe(legacyWorkflowClassificationDigest(classifyLegacyWorkflow(clean, sourcesFor([clean], tools))));
});

test("the same graph under a different extension release is a different pinned definition", () => {
  const release = { installationId: "notes-install", binding: "notes@1.0.0", ownerId: "owner-1", scope: "project" };
  const root = definition("released", [toolStep("read", "notes__read_note")]);
  const sources = sourcesFor([root], { notes__read_note: [{ kind: "fs.read", value: "/project" }] });
  const bare = classifyLegacyWorkflow(root, sources);
  const released = classifyLegacyWorkflow(root, sources, release);

  expect(bare.definitionDigest).not.toBe(released.definitionDigest);
  expect(released.definitionDigest).toBe(workflowExecutionHash(root, release));
});

test("the denied kinds are published as one sorted list a caller can show", () => {
  expect(LEGACY_WORKFLOW_DENIED_CAPABILITY_KINDS).toEqual([
    "agent:unreachable", "custom", "ezcorp:mcp:invoke", "http", "network", "network.tcp", "shell", "tool:unreachable",
  ]);
});
