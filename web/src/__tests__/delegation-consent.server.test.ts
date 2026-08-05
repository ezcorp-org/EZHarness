/**
 * The web-side assembly of a C3 consent record.
 *
 * This module is where the pure hash meets the world, so the properties
 * worth pinning are the ones a pure test cannot see:
 *
 *   - the ROOT's version pin is refused when the saved snapshot and the
 *     definition that would run have diverged (Ruling 2) — the chosen
 *     resolution to "the run records a version the delegation did not
 *     pin", detected here rather than papered over at the executor;
 *   - a diverged CHILD does not refuse; it falls back to a content
 *     fingerprint, which still invalidates consent on any later edit;
 *   - `capabilitiesForTool` / `capabilitiesForAgent` honour the hash's
 *     `undefined` = UNREACHABLE contract, which is what makes an
 *     extension narrowing its manifest stale a consent whose capability
 *     set only SHRANK (T11);
 *   - the closure is resolved with the OWNER's principal, so a `service`
 *     delegation hashes a strictly smaller graph.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { workflowDefinitionHash } from "$server/runtime/workflow-definition-hash";

const cache = vi.hoisted(() => ({ getCachedWorkflows: vi.fn(), getExecutor: vi.fn() }));
vi.mock("$lib/server/context", () => ({
  getCachedWorkflows: cache.getCachedWorkflows,
  getExecutor: cache.getExecutor,
}));

const registry = vi.hoisted(() => ({
  getRegisteredTool: vi.fn(),
  getGrantedPermissions: vi.fn(),
}));
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getRegisteredTool: registry.getRegisteredTool,
      getGrantedPermissions: registry.getGrantedPermissions,
    }),
  },
}));

const db = vi.hoisted(() => ({ getWorkflowByName: vi.fn(), getLatestWorkflowVersion: vi.fn() }));
vi.mock("$server/db/queries/workflows", () => ({ getWorkflowByName: db.getWorkflowByName }));
vi.mock("$server/db/queries/workflow-versions", () => ({
  getLatestWorkflowVersion: db.getLatestWorkflowVersion,
}));

const { buildDelegationConsent } = await import("$lib/server/delegation-consent");
// The four `ConsentHashSources` live in `src/` so that the fire-time
// recompute (which cannot import `web/`) uses the SAME ones — see that
// module's header. They are exercised HERE, through the same mocked
// registry the assembly above sees, so the two halves cannot be proved
// against different worlds.
const { agentCapabilityLookup, capabilitiesForTool } = await import(
  "$server/runtime/workflow-delegation-record"
);
const capabilitiesForAgent = (agent: string) =>
  agentCapabilityLookup(cache.getExecutor().listAgents())(agent);

function definition(name: string, child?: string) {
  return {
    name,
    description: "",
    steps:
      child === undefined
        ? [{ name: "s1", agent: "writer", input: {} }]
        : [{ name: "s1", kind: "workflow", workflow: child, input: {} }],
  };
}

function entry(name: string, visibility: string, child?: string) {
  return {
    definition: definition(name, child),
    source: "db",
    id: `id-${name}`,
    projectId: null,
    userId: "u1",
    visibility,
    forkedFrom: null,
  };
}

const ROOT = entry("root", "system");

function request(overrides: Record<string, unknown> = {}) {
  return {
    entry: ROOT,
    extensionName: "ext",
    workflowName: "root",
    projectId: null,
    ownerKind: "user" as const,
    ownerId: "u1",
    trigger: { kind: "cron", spec: { expr: "0 * * * *" } },
    ...overrides,
  } as never;
}

beforeEach(() => {
  cache.getCachedWorkflows.mockReset().mockReturnValue([ROOT]);
  cache.getExecutor.mockReset().mockReturnValue({ listAgents: () => [] });
  registry.getRegisteredTool.mockReset().mockReturnValue(null);
  registry.getGrantedPermissions.mockReset().mockReturnValue(null);
  db.getWorkflowByName.mockReset().mockResolvedValue(undefined);
  db.getLatestWorkflowVersion.mockReset().mockResolvedValue(undefined);
});

// ── the capability lookups honour "undefined means unreachable" ─────

describe("capabilitiesForTool", () => {
  test("an unregistered tool is UNDEFINED, not an empty set", () => {
    // The two must not hash alike: reaching a tool and finding it
    // declares nothing is a different fact from not reaching it.
    expect(capabilitiesForTool("ghost__thing")).toBeUndefined();
  });

  test("a registered tool yields its extension's flattened grants", () => {
    registry.getRegisteredTool.mockReturnValue({ extensionId: "ext-1" });
    registry.getGrantedPermissions.mockReturnValue({ network: ["api.example.com"] });
    expect(capabilitiesForTool("ext__thing")).toEqual([
      { kind: "network", value: "api.example.com" },
    ]);
    expect(registry.getGrantedPermissions).toHaveBeenCalledWith("ext-1");
  });

  test("a registered tool with NO grants is an empty set, not undefined", () => {
    registry.getRegisteredTool.mockReturnValue({ extensionId: "ext-1" });
    registry.getGrantedPermissions.mockReturnValue(null);
    expect(capabilitiesForTool("ext__thing")).toEqual([]);
  });
});

describe("capabilitiesForAgent", () => {
  test("an unknown agent is UNDEFINED", () => {
    expect(capabilitiesForAgent("nobody")).toBeUndefined();
  });

  test("a known agent yields its declared capabilities", () => {
    cache.getExecutor.mockReturnValue({
      listAgents: () => [{ name: "writer", capabilities: ["llm", "file"] }],
    });
    expect(capabilitiesForAgent("writer")).toEqual([
      { kind: "llm", value: null },
      { kind: "file", value: null },
    ]);
  });

  test("a known agent declaring nothing is an empty set, not undefined", () => {
    cache.getExecutor.mockReturnValue({ listAgents: () => [{ name: "writer", capabilities: [] }] });
    expect(capabilitiesForAgent("writer")).toEqual([]);
  });
});

// ── Ruling 2 — the root's pin ───────────────────────────────────────

describe("buildDelegationConsent — the version pin", () => {
  test("a workflow with no DB row pins NULL and still hashes", async () => {
    const result = await buildDelegationConsent(request());
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.definitionVersionId).toBeNull();
    expect(result.consentHash).toMatch(/^[0-9a-f]{64}$/);
    // BOTH digests reach the route. The advisory one is what lets a fire
    // tell "a release edited this workflow" from "the grant moved", and a
    // consent that omitted it would leave the first fire re-authorizing a
    // release that never happened.
    expect(result.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.definitionHash).not.toBe(result.consentHash);
  });

  test("a row with no version row pins NULL too", async () => {
    db.getWorkflowByName.mockResolvedValue({ id: "def-1" });
    const result = await buildDelegationConsent(request());
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.definitionVersionId).toBeNull();
  });

  test("a MATCHING version is pinned", async () => {
    db.getWorkflowByName.mockResolvedValue({ id: "def-1" });
    db.getLatestWorkflowVersion.mockResolvedValue({
      id: "v1",
      version: 1,
      stepsHash: workflowDefinitionHash(ROOT.definition as never),
    });
    const result = await buildDelegationConsent(request());
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.definitionVersionId).toBe("v1");
  });

  test("a DIVERGED version is a 409 and no hash is produced", async () => {
    db.getWorkflowByName.mockResolvedValue({ id: "def-1" });
    db.getLatestWorkflowVersion.mockResolvedValue({
      id: "v1",
      version: 1,
      stepsHash: "some-other-content",
    });
    const result = await buildDelegationConsent(request());
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(409);
    expect((await result.json()).error).toContain("does not match the definition that would run");
  });
});

// ── the closure is the OWNER's view ─────────────────────────────────

describe("buildDelegationConsent — the closure", () => {
  const withChild = entry("root", "system", "child");
  const child = entry("child", "project");

  beforeEach(() => {
    cache.getCachedWorkflows.mockReturnValue([withChild, child]);
  });

  test("a user delegation reaches a project-visible child", async () => {
    const result = await buildDelegationConsent(request({ entry: withChild, ownerKind: "user" }));
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.material.graph.map((g) => g.name)).toEqual(["child", "root"]);
    expect(result.material.unresolved).toEqual([]);
  });

  test("a service delegation does NOT, and hashes differently", async () => {
    const asUser = await buildDelegationConsent(request({ entry: withChild, ownerKind: "user" }));
    const asService = await buildDelegationConsent(
      request({ entry: withChild, ownerKind: "service", ownerId: "svc-1" }),
    );
    expect(asUser).not.toBeInstanceOf(Response);
    expect(asService).not.toBeInstanceOf(Response);
    if (asUser instanceof Response || asService instanceof Response) return;
    expect(asService.material.unresolved).toEqual(["child"]);
    expect(asService.material.graph.map((g) => g.name)).toEqual(["root"]);
    expect(asService.consentHash).not.toBe(asUser.consentHash);
    // The GRAPH differs too — a definition the principal cannot resolve
    // is not in the walk at all — so both digests move. The split scopes
    // what a difference MEANS at fire time; it does not narrow the walk.
    expect(asService.definitionHash).not.toBe(asUser.definitionHash);
  });

  test("a child whose version DIVERGED falls back to a content fingerprint, not a refusal", async () => {
    // Asymmetric on purpose: the root's id is written to the row, so a
    // divergence there is a lie the audit trail would catch. A child's
    // identity only feeds the hash, and the content fingerprint still
    // notices any later edit.
    db.getWorkflowByName.mockImplementation(async (name: string) =>
      name === "child" ? { id: "def-child" } : undefined,
    );
    db.getLatestWorkflowVersion.mockResolvedValue({
      id: "cv1",
      version: 1,
      stepsHash: "diverged",
    });
    const result = await buildDelegationConsent(request({ entry: withChild }));
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    const childMaterial = result.material.graph.find((g) => g.name === "child");
    expect(childMaterial?.identity).toMatch(/^unversioned:/);
  });

  test("a child whose version MATCHES is identified by version id", async () => {
    db.getWorkflowByName.mockImplementation(async (name: string) =>
      name === "child" ? { id: "def-child" } : undefined,
    );
    db.getLatestWorkflowVersion.mockResolvedValue({
      id: "cv1",
      version: 4,
      stepsHash: workflowDefinitionHash(child.definition as never),
    });
    const result = await buildDelegationConsent(request({ entry: withChild }));
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.material.graph.find((g) => g.name === "child")?.identity).toBe("version:cv1@4");
  });
});

// ── the stored capability set is derived FROM the hashed material ───

describe("buildDelegationConsent — the capability set", () => {
  test("it is the hashed material's own set, de-duplicated and split back", async () => {
    cache.getExecutor.mockReturnValue({
      listAgents: () => [{ name: "writer", capabilities: ["llm"] }],
    });
    const result = await buildDelegationConsent(request());
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    // Sorted by the `kind::value` KEY, so the agent's own valueless
    // `llm` declaration (`llm::`) precedes the step's provider binding
    // (`llm::<agent-binding>`). They do NOT collapse: "this agent may
    // call an LLM" and "this step binds no provider, so the agent's own
    // binding decides" are different facts and the dialog shows both.
    expect(result.capabilitySet).toEqual([
      { kind: "agent", value: "writer" },
      { kind: "llm", value: null },
      { kind: "llm", value: "<agent-binding>" },
    ]);
    // …and every entry is present in the hashed material, so the dialog
    // and the digest cannot disagree.
    const hashed = new Set(result.material.graph.flatMap((g) => g.capabilities));
    for (const cap of result.capabilitySet) {
      expect(hashed.has(`${cap.kind}::${cap.value ?? ""}`)).toBe(true);
    }
  });

  test("an unreachable agent contributes its own marker rather than nothing", async () => {
    const result = await buildDelegationConsent(request());
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.capabilitySet).toContainEqual({ kind: "agent:unreachable", value: "writer" });
  });
});
