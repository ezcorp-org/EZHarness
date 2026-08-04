/**
 * C3 — the impure half of a consent record, shared by the consent route
 * (in `web/`) and by phase 6's fire-time recompute (in `src/`).
 *
 * The properties worth pinning here are the ones a pure test of
 * `workflow-capability-hash.ts` cannot see, because they are about the
 * SOURCES rather than the digest:
 *
 *   - `capabilitiesForTool` / `agentCapabilityLookup` honour the hash's
 *     `undefined` = UNREACHABLE contract, which is what makes an
 *     extension narrowing its manifest stale a consent whose capability
 *     set only SHRANK (T11);
 *   - a definition's version identity comes from the DB and falls back to
 *     a CONTENT fingerprint, so a workflow with no row is not an error
 *     path;
 *   - the stored `capability_set` is derived FROM the hashed material,
 *     not collected alongside it, so the dialog and the digest cannot
 *     disagree;
 *   - the closure is walked with the PRINCIPAL's resolver, so a `service`
 *     delegation hashes a strictly smaller graph than a `user` one.
 *
 * The web-side suite (`web/src/__tests__/delegation-consent.server.test.ts`)
 * exercises the same module through the route wrapper. Both exist on
 * purpose: this one is the leg that MEASURES it, because the vitest
 * coverage leg's `--coverage.include` is scoped to `web/src/lib/**`.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const registry = {
  getRegisteredTool: (_tool: string) => null as { extensionId: string } | null,
  getGrantedPermissions: (_id: string) => null as unknown,
};
mock.module("../extensions/registry", () => ({
  ExtensionRegistry: { getInstance: () => registry },
}));

const dbDoubles = {
  workflowByName: async (_name: string) => undefined as { id: string } | undefined,
  latestVersion: async (_id: string) =>
    undefined as { id: string; version: number; stepsHash: string } | undefined,
};
mock.module("../db/queries/workflows", () => ({
  getWorkflowByName: (name: string) => dbDoubles.workflowByName(name),
}));
mock.module("../db/queries/workflow-versions", () => ({
  getLatestWorkflowVersion: (id: string) => dbDoubles.latestVersion(id),
}));

const {
  agentCapabilityLookup,
  capabilitiesForTool,
  computeDelegationConsentRecord,
  latestWorkflowVersionFor,
} = await import("../runtime/workflow-delegation-record");
const { workflowDefinitionHash } = await import("../runtime/workflow-definition-hash");
const { delegationPrincipal } = await import("../runtime/workflow-delegation-consent");

import type { AgentDefinition, WorkflowDefinition } from "../types";
import type { CachedWorkflow } from "../runtime/workflow-scope";

function entry(
  definition: WorkflowDefinition,
  visibility: string,
  userId: string | null = "u1",
): CachedWorkflow {
  return {
    definition,
    source: "db",
    id: `id-${definition.name}`,
    projectId: null,
    userId,
    visibility,
    forkedFrom: null,
  } as unknown as CachedWorkflow;
}

const AGENT_ROOT: WorkflowDefinition = {
  name: "root",
  description: "",
  steps: [{ name: "s1", agent: "writer" }],
};
const TOOL_ROOT: WorkflowDefinition = {
  name: "root",
  description: "",
  steps: [{ name: "s1", kind: "tool", tool: "ext__thing" }],
};
const NESTED_ROOT: WorkflowDefinition = {
  name: "root",
  description: "",
  steps: [{ name: "n", kind: "workflow", workflow: "child" }],
};
const CHILD: WorkflowDefinition = {
  name: "child",
  description: "",
  steps: [{ name: "s1", agent: "writer" }],
};

beforeEach(() => {
  registry.getRegisteredTool = () => null;
  registry.getGrantedPermissions = () => null;
  dbDoubles.workflowByName = async () => undefined;
  dbDoubles.latestVersion = async () => undefined;
});

describe("capabilitiesForTool — undefined means UNREACHABLE", () => {
  test("an unregistered tool is UNDEFINED, not an empty set", () => {
    // Reaching a tool and finding it declares nothing is a DIFFERENT fact
    // from not reaching it, and the two must not hash alike (T11).
    expect(capabilitiesForTool("ghost__thing")).toBeUndefined();
  });

  test("a registered tool yields its extension's flattened grants", () => {
    registry.getRegisteredTool = () => ({ extensionId: "ext-1" });
    registry.getGrantedPermissions = () => ({ network: ["API.Example.COM"] });

    expect(capabilitiesForTool("ext__thing")).toEqual([
      // Lower-cased by the SAME flattener the PDP holds, so the dialog
      // shows the set the decision point will use.
      { kind: "network", value: "api.example.com" },
    ]);
  });

  test("a registered tool with NO grants is an EMPTY set, not undefined", () => {
    registry.getRegisteredTool = () => ({ extensionId: "ext-1" });
    registry.getGrantedPermissions = () => null;

    expect(capabilitiesForTool("ext__thing")).toEqual([]);
  });
});

describe("agentCapabilityLookup — the same contract, for agents", () => {
  const agents = [
    { name: "writer", capabilities: ["llm", "file"] },
    { name: "mute", capabilities: [] },
  ] as unknown as AgentDefinition[];

  test("an unknown agent is UNDEFINED", () => {
    expect(agentCapabilityLookup(agents)("nobody")).toBeUndefined();
  });

  test("a known agent yields its declared capabilities", () => {
    expect(agentCapabilityLookup(agents)("writer")).toEqual([
      { kind: "llm", value: null },
      { kind: "file", value: null },
    ]);
  });

  test("a known agent declaring nothing is an EMPTY set", () => {
    expect(agentCapabilityLookup(agents)("mute")).toEqual([]);
  });
});

describe("latestWorkflowVersionFor", () => {
  test("no definition row ⇒ undefined", async () => {
    expect(await latestWorkflowVersionFor("root")).toBeUndefined();
  });

  test("a definition row with no version ⇒ undefined", async () => {
    dbDoubles.workflowByName = async () => ({ id: "def-1" });

    expect(await latestWorkflowVersionFor("root")).toBeUndefined();
  });

  test("a version row is narrowed to the pinnable triple", async () => {
    dbDoubles.workflowByName = async () => ({ id: "def-1" });
    dbDoubles.latestVersion = async () => ({ id: "v1", version: 3, stepsHash: "h" });

    expect(await latestWorkflowVersionFor("root")).toEqual({
      id: "v1", version: 3, stepsHash: "h",
    });
  });
});

describe("computeDelegationConsentRecord", () => {
  function request(overrides: Record<string, unknown> = {}) {
    const root = entry(AGENT_ROOT, "system");
    return {
      entry: root,
      extensionName: "ext",
      workflowName: "root",
      projectId: null,
      runAs: { kind: "user", id: "u1" },
      trigger: { kind: "cron", spec: { expr: "0 * * * *" } },
      principal: delegationPrincipal("user", "u1"),
      entries: [root],
      agents: [] as AgentDefinition[],
      ...overrides,
    } as never;
  }

  test("a workflow with no DB row pins NULL and still hashes", async () => {
    const record = await computeDelegationConsentRecord(request());

    expect(record.pin).toEqual({ ok: true, definitionVersionId: null });
    expect(record.consentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a MATCHING version is pinned", async () => {
    dbDoubles.workflowByName = async () => ({ id: "def-1" });
    dbDoubles.latestVersion = async () => ({
      id: "v1", version: 1, stepsHash: workflowDefinitionHash(AGENT_ROOT),
    });

    const record = await computeDelegationConsentRecord(request());

    expect(record.pin).toEqual({ ok: true, definitionVersionId: "v1" });
    // …and the root is identified BY that version in the material, so the
    // pin and the hash agree about which snapshot was consented to.
    expect(record.material.graph[0]?.identity).toBe("version:v1@1");
  });

  test("a DIVERGED version REFUSES the pin rather than papering over it", async () => {
    dbDoubles.workflowByName = async () => ({ id: "def-1" });
    dbDoubles.latestVersion = async () => ({
      id: "v1", version: 1, stepsHash: "content-that-never-ran",
    });

    const record = await computeDelegationConsentRecord(request());

    expect(record.pin.ok).toBe(false);
    if (record.pin.ok) return;
    expect(record.pin.code).toBe("DELEGATION_VERSION_DIVERGENCE");
    expect(record.pin.message).toContain("does not match the definition that would run");
  });

  test("the capability set is the hashed material's own set, split back", async () => {
    const record = await computeDelegationConsentRecord(
      request({ agents: [{ name: "writer", capabilities: ["llm"] }] }),
    );

    expect(record.capabilitySet).toEqual([
      { kind: "agent", value: "writer" },
      // The agent's own valueless declaration (`llm::`)…
      { kind: "llm", value: null },
      // …and the step's provider binding, which is a DIFFERENT fact.
      { kind: "llm", value: "<agent-binding>" },
    ]);
    const hashed = new Set(record.material.graph.flatMap((g) => g.capabilities));
    for (const cap of record.capabilitySet) {
      expect(hashed.has(`${cap.kind}::${cap.value ?? ""}`)).toBe(true);
    }
  });

  test("an UNREACHABLE tool contributes its own marker, so a narrowing manifest stales consent", async () => {
    const root = entry(TOOL_ROOT, "system");
    const withTool = await computeDelegationConsentRecord(
      request({ entry: root, entries: [root] }),
    );
    expect(withTool.capabilitySet).toContainEqual({
      kind: "tool:unreachable", value: "ext__thing",
    });

    // Register the tool and the hash MOVES — the set grew, but the point
    // is that reachability is part of what was consented to.
    registry.getRegisteredTool = () => ({ extensionId: "ext-1" });
    registry.getGrantedPermissions = () => ({ shell: true });
    const reachable = await computeDelegationConsentRecord(
      request({ entry: root, entries: [root] }),
    );

    expect(reachable.capabilitySet).toContainEqual({ kind: "shell", value: null });
    expect(reachable.consentHash).not.toBe(withTool.consentHash);
  });

  test("the closure is the PRINCIPAL's: a service delegation hashes a smaller graph", async () => {
    const root = entry(NESTED_ROOT, "system");
    const child = entry(CHILD, "project");
    const entries = [root, child];

    const asUser = await computeDelegationConsentRecord(
      request({
        entry: root, entries,
        runAs: { kind: "user", id: "u1" },
        principal: delegationPrincipal("user", "u1"),
      }),
    );
    const asService = await computeDelegationConsentRecord(
      request({
        entry: root, entries,
        runAs: { kind: "service", id: "svc-1" },
        principal: delegationPrincipal("service", "svc-1"),
      }),
    );

    expect(asUser.material.graph.map((g) => g.name)).toEqual(["child", "root"]);
    expect(asUser.material.unresolved).toEqual([]);
    // `userId: null` satisfies `system` only, so the project-visible
    // child is not merely omitted — it is recorded as UNRESOLVED, which
    // is what makes a later re-tier of that child notice.
    expect(asService.material.graph.map((g) => g.name)).toEqual(["root"]);
    expect(asService.material.unresolved).toEqual(["child"]);
    expect(asService.consentHash).not.toBe(asUser.consentHash);
  });

  test("a CHILD whose version diverged falls back to a content fingerprint, not a refusal", async () => {
    // Asymmetric on purpose: the ROOT's id is written to the delegation
    // row, so a divergence there is a claim the audit trail would catch.
    // A child's identity only feeds the hash, and a content fingerprint
    // still notices any later edit.
    const root = entry(NESTED_ROOT, "system");
    const child = entry(CHILD, "system");
    dbDoubles.workflowByName = async (name: string) =>
      name === "child" ? { id: "def-child" } : undefined;
    dbDoubles.latestVersion = async () => ({ id: "cv1", version: 1, stepsHash: "diverged" });

    const record = await computeDelegationConsentRecord(
      request({ entry: root, entries: [root, child] }),
    );

    expect(record.pin).toEqual({ ok: true, definitionVersionId: null });
    expect(record.material.graph.find((g) => g.name === "child")?.identity).toMatch(
      /^unversioned:/,
    );
  });
});

afterAll(() => {
  restoreModuleMocks();
});
