/**
 * C3's consent hash.
 *
 * The module is pure, so the matrix is exhaustive in BOTH directions and
 * that is the point:
 *
 *   • every input individually INVALIDATES — mutate exactly one thing and
 *     the digest must move. For a consent control the mutation that
 *     matters is "drop an input and watch something that should re-ask the
 *     human stop re-asking".
 *   • every exclusion individually does NOT invalidate — the inverse
 *     direction. Without it the hash could be over-broad (re-asking on a
 *     prose edit) and nothing would notice, which is the consent-fatigue
 *     failure mode the exclusion list exists to prevent.
 *
 * Every test differs from `fixture()` by exactly one defect.
 */
import { describe, expect, test } from "bun:test";
import {
  CONSENT_HASH_MATERIAL_VERSION,
  computeWorkflowConsentHash,
} from "../runtime/workflow-capability-hash";
import type {
  ConsentCapability,
  ConsentDelegation,
  ConsentHashSources,
  WorkflowVersionIdentity,
} from "../runtime/workflow-capability-hash";
import type { WorkflowDefinition } from "../types";

/**
 * The world, in the shape the hash consumes it.
 *
 * `identities` is keyed by NAME and deliberately does not depend on a
 * definition's content: that pins the version identity across a body edit,
 * which is what isolates the reachability inputs (`when` /
 * `skipDependents`) from the identity that would otherwise mask them.
 */
interface World {
  defs: WorkflowDefinition[];
  identities: Map<string, WorkflowVersionIdentity>;
  toolCaps: Map<string, ConsentCapability[]>;
  agentCaps: Map<string, ConsentCapability[]>;
  delegation: ConsentDelegation;
}

function fixture(): World {
  const child: WorkflowDefinition = {
    name: "child",
    description: "the child",
    steps: [{ name: "c-tool", kind: "tool", tool: "ext__deploy" }],
  };
  const root: WorkflowDefinition = {
    name: "root",
    description: "the root",
    defaultModel: { provider: "anthropic", model: "sonnet" },
    steps: [
      {
        name: "s-agent",
        kind: "agent",
        agent: "writer",
        when: { ref: "$input.go", op: "truthy" },
        skipDependents: false,
      },
      { name: "s-tool", kind: "tool", tool: "ext__notify", dependsOn: ["s-agent"] },
      { name: "s-nest", kind: "workflow", workflow: "child" },
      { name: "s-gate", kind: "gate", condition: { ref: "$prev.output.ok", op: "truthy" } },
    ],
  };
  // Visible to the resolver but referenced by nobody — the hash must
  // fingerprint the CLOSURE, not the cache it was resolved out of.
  const bystander: WorkflowDefinition = {
    name: "bystander",
    description: "not reachable from root",
    steps: [{ name: "b-tool", kind: "tool", tool: "ext__rm" }],
  };

  return {
    defs: [root, child, bystander],
    identities: new Map<string, WorkflowVersionIdentity>([
      ["root", { kind: "version", versionId: "ver-root", version: 1 }],
      ["child", { kind: "version", versionId: "ver-child", version: 1 }],
      ["bystander", { kind: "version", versionId: "ver-bystander", version: 1 }],
    ]),
    toolCaps: new Map<string, ConsentCapability[]>([
      ["ext__notify", [{ kind: "network", value: "hooks.example.com" }]],
      ["ext__deploy", [{ kind: "shell" }]],
      ["ext__rm", [{ kind: "fs.write", value: "/tmp" }]],
    ]),
    agentCaps: new Map<string, ConsentCapability[]>([
      ["writer", [{ kind: "storage" }]],
    ]),
    delegation: {
      extensionName: "deploy-bot",
      workflowName: "root",
      projectId: "proj-1",
      runAs: { kind: "user", id: "user-1" },
      trigger: { kind: "cron", spec: { expr: "0 * * * *", tz: "UTC" } },
      input: { branch: "main" },
      displayName: "Nightly deploy",
      concurrency: { policy: "skip" },
    },
  };
}

function sourcesOf(w: World): ConsentHashSources {
  return {
    resolve: (name) => w.defs.find((d) => d.name === name),
    identify: (def) => w.identities.get(def.name) ?? { kind: "unversioned" },
    capabilitiesForTool: (tool) => w.toolCaps.get(tool),
    capabilitiesForAgent: (agent) => w.agentCaps.get(agent),
  };
}

function rootOf(w: World): WorkflowDefinition {
  const root = w.defs.find((d) => d.name === "root");
  if (!root) throw new Error("fixture lost its root");
  return root;
}

/** Hash the fixture after applying exactly one mutation. */
function hashWith(mutate?: (w: World) => void): string {
  const w = fixture();
  mutate?.(w);
  return computeWorkflowConsentHash(rootOf(w), w.delegation, sourcesOf(w)).hash;
}

function materialWith(mutate?: (w: World) => void) {
  const w = fixture();
  mutate?.(w);
  return computeWorkflowConsentHash(rootOf(w), w.delegation, sourcesOf(w)).material;
}

const BASELINE = hashWith();

/** Every step of a definition in the fixture, by name. */
function stepOf(w: World, defName: string, stepName: string) {
  const def = w.defs.find((d) => d.name === defName);
  const step = def?.steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`fixture lost ${defName}.${stepName}`);
  return step;
}

// ─────────────────────────────────────────────────────────────────────
// Determinism
// ─────────────────────────────────────────────────────────────────────

describe("determinism", () => {
  test("the same world hashes to the same value", () => {
    expect(hashWith()).toBe(BASELINE);
    expect(BASELINE).toMatch(/^[0-9a-f]{64}$/);
  });

  test("key order in the definition, the delegation and the trigger spec is not an input", () => {
    const reordered = hashWith((w) => {
      const root = rootOf(w);
      // Same definition, keys written in a different order — a YAML loader
      // and a jsonb round-trip do not agree on insertion order.
      w.defs[w.defs.indexOf(root)] = {
        steps: root.steps.map((s) => ({ ...Object.fromEntries(Object.entries(s).reverse()) })) as
          typeof root.steps,
        defaultModel: { model: "sonnet", provider: "anthropic" },
        description: root.description,
        name: root.name,
      };
      w.delegation = {
        concurrency: { policy: "skip" },
        displayName: "Nightly deploy",
        input: { branch: "main" },
        trigger: { spec: { tz: "UTC", expr: "0 * * * *" }, kind: "cron" },
        runAs: { id: "user-1", kind: "user" },
        projectId: "proj-1",
        workflowName: "root",
        extensionName: "deploy-bot",
      };
    });
    expect(reordered).toBe(BASELINE);
  });

  test("a definition nobody references does not reach the digest", () => {
    expect(
      hashWith((w) => {
        const bystander = w.defs.find((d) => d.name === "bystander");
        if (!bystander) throw new Error("fixture lost its bystander");
        bystander.steps = [{ name: "b-tool", kind: "tool", tool: "ext__format_disk" }];
      }),
    ).toBe(BASELINE);
    expect(materialWith().graph.map((g) => g.name)).toEqual(["child", "root"]);
  });

  test("the material version is folded in", () => {
    expect(materialWith().v).toBe(CONSENT_HASH_MATERIAL_VERSION);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Every input, individually invalidating. One defect per test.
// ─────────────────────────────────────────────────────────────────────

/** [what it proves, the single mutation]. Each row must produce a hash
 *  different from `BASELINE` AND from every other row. */
const INVALIDATING: Array<[string, (w: World) => void]> = [
  // #1 extension name — a delegation presented by another extension.
  ["1. extensionName", (w) => { w.delegation.extensionName = "other-bot"; }],

  // #2 fully-qualified workflow name.
  ["2. workflowName", (w) => { w.delegation.workflowName = "ext:root"; }],

  // #3 the version id, and the version number, of the ROOT.
  [
    "3a. root version id",
    (w) => { w.identities.set("root", { kind: "version", versionId: "ver-root-2", version: 1 }); },
  ],
  [
    "3b. root version number",
    (w) => { w.identities.set("root", { kind: "version", versionId: "ver-root", version: 2 }); },
  ],
  // #3, nested arm: a child edit the parent's own version id cannot see.
  [
    "3c. nested version id",
    (w) => { w.identities.set("child", { kind: "version", versionId: "ver-child-2", version: 1 }); },
  ],

  // #4 the capability set.
  [
    "4a. a tool gains a capability",
    (w) => { w.toolCaps.set("ext__notify", [{ kind: "network", value: "hooks.example.com" }, { kind: "shell" }]); },
  ],
  [
    "4b. a tool loses a capability (the set SHRINKS — still stale)",
    (w) => { w.toolCaps.set("ext__notify", []); },
  ],
  [
    "4c. T11 — the manifest narrows so the tool is unreachable",
    (w) => { w.toolCaps.delete("ext__notify"); },
  ],
  [
    "4d. an agent's tool scope changes",
    (w) => { w.agentCaps.set("writer", [{ kind: "storage" }, { kind: "fs.read", value: "/etc" }]); },
  ],
  [
    "4e. the agent becomes unreachable",
    (w) => { w.agentCaps.delete("writer"); },
  ],
  [
    "4f. a NESTED definition's tool gains a capability",
    (w) => { w.toolCaps.set("ext__deploy", [{ kind: "shell" }, { kind: "fs.write", value: "/" }]); },
  ],
  [
    "4g. a step's tool is re-pointed",
    (w) => { stepOf(w, "root", "s-tool").tool = "ext__deploy"; },
  ],
  [
    "4h. a step's agent is re-pointed",
    (w) => { stepOf(w, "root", "s-agent").agent = "shipper"; },
  ],

  // #5 the transitive closure.
  [
    "5a. a nested edge is added",
    (w) => { rootOf(w).steps.push({ name: "s-nest-2", kind: "workflow", workflow: "bystander" }); },
  ],
  [
    "5b. a nested edge is removed",
    (w) => { rootOf(w).steps = rootOf(w).steps.filter((s) => s.name !== "s-nest"); },
  ],
  [
    "5c. a nested edge is re-pointed at another definition",
    (w) => { stepOf(w, "root", "s-nest").workflow = "bystander"; },
  ],
  [
    "5d. a nested definition's body changes (identity pinned by name)",
    (w) => { stepOf(w, "child", "c-tool").tool = "ext__rm"; },
  ],
  [
    "5e. unresolved — an edge that points nowhere today may resolve tomorrow",
    (w) => { w.defs = w.defs.filter((d) => d.name !== "child"); },
  ],
  [
    "5f. cycles",
    (w) => {
      const child = w.defs.find((d) => d.name === "child");
      if (!child) throw new Error("fixture lost its child");
      child.steps.push({ name: "c-nest", kind: "workflow", workflow: "root" });
    },
  ],
  [
    "5g. tooDeep",
    (w) => {
      // root → child → g1 → g2 → g3 : g3 is one level past the cap.
      const child = w.defs.find((d) => d.name === "child");
      if (!child) throw new Error("fixture lost its child");
      child.steps.push({ name: "c-nest", kind: "workflow", workflow: "g1" });
      for (const [name, next] of [["g1", "g2"], ["g2", "g3"]] as const) {
        w.defs.push({
          name,
          description: name,
          steps: [{ name: `${name}-nest`, kind: "workflow", workflow: next }],
        });
        w.identities.set(name, { kind: "unversioned" });
      }
      w.defs.push({ name: "g3", description: "g3", steps: [] });
      w.identities.set("g3", { kind: "unversioned" });
    },
  ],

  // #6 trigger.
  ["6a. trigger kind", (w) => { w.delegation.trigger.kind = "webhook"; }],
  ["6b. trigger spec", (w) => { w.delegation.trigger.spec = { expr: "*/5 * * * *", tz: "UTC" }; }],

  // #7 project and the run-as principal.
  ["7a. projectId", (w) => { w.delegation.projectId = "proj-2"; }],
  ["7b. runAs kind", (w) => { w.delegation.runAs = { kind: "service", id: "user-1" }; }],
  ["7c. runAs id", (w) => { w.delegation.runAs = { kind: "user", id: "user-2" }; }],

  // #8 the model-override set.
  [
    "8a. a per-step model override appears",
    (w) => { stepOf(w, "root", "s-agent").model = { provider: "openai", model: "o3" }; },
  ],
  [
    // Isolates #8 from #4: the PROVIDER is unchanged, so the `llm::`
    // capability is identical and only the binding itself moved. A silent
    // re-point from Sonnet to Opus is a 30× spend change on the owner's
    // credits and a capability-set-only hash cannot see it.
    "8c. a per-step model is re-pointed WITHIN the same provider",
    (w) => { stepOf(w, "root", "s-agent").model = { provider: "anthropic", model: "opus" }; },
  ],
  [
    "8b. the definition-level default model is re-pointed",
    (w) => { rootOf(w).defaultModel = { provider: "anthropic", model: "opus" }; },
  ],

  // #9 reachability — `when` AND `skipDependents`.
  [
    "9a. when",
    (w) => { stepOf(w, "root", "s-agent").when = { ref: "$input.go", op: "exists" }; },
  ],
  [
    "9b. when removed entirely",
    (w) => { stepOf(w, "root", "s-agent").when = undefined; },
  ],
  [
    "9c. skipDependents flipped false → true",
    (w) => { stepOf(w, "root", "s-agent").skipDependents = true; },
  ],
  [
    "9d. skipDependents flipped true → false on a step that relied on the default",
    (w) => { stepOf(w, "root", "s-tool").skipDependents = false; },
  ],

  // Structural: step order decides batch composition.
  ["10. step order", (w) => { rootOf(w).steps.reverse(); }],
  ["11. a step is renamed", (w) => { stepOf(w, "root", "s-gate").name = "s-gate-2"; }],
  ["12. a step kind changes", (w) => { stepOf(w, "root", "s-gate").kind = "transform"; }],
];

describe("every input individually invalidates consent", () => {
  for (const [label, mutate] of INVALIDATING) {
    test(label, () => {
      expect(hashWith(mutate)).not.toBe(BASELINE);
    });
  }

  test("no two of them collide — the hash discriminates all of them", () => {
    const hashes = new Set(INVALIDATING.map(([, mutate]) => hashWith(mutate)));
    expect(hashes.size).toBe(INVALIDATING.length);
    expect(hashes.has(BASELINE)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Every exclusion, individually NOT invalidating.
// ─────────────────────────────────────────────────────────────────────

const NOT_INVALIDATING: Array<[string, (w: World) => void]> = [
  ["input values", (w) => { w.delegation.input = { branch: "release", extra: 1 }; }],
  ["input values dropped entirely", (w) => { w.delegation.input = null; }],
  ["display name", (w) => { w.delegation.displayName = "Renamed by the owner"; }],
  ["concurrency policy", (w) => { w.delegation.concurrency = { policy: "queue" }; }],
  ["the root's description", (w) => { rootOf(w).description = "a typo fix"; }],
  [
    "a nested definition's description",
    (w) => {
      const child = w.defs.find((d) => d.name === "child");
      if (!child) throw new Error("fixture lost its child");
      child.description = "a typo fix";
    },
  ],
  [
    "the root's inputSchema (the version id is the input, not the schema)",
    (w) => { rootOf(w).inputSchema = { branch: { type: "string", label: "Branch" } }; },
  ],
];

describe("every exclusion individually does NOT invalidate consent", () => {
  for (const [label, mutate] of NOT_INVALIDATING) {
    test(label, () => {
      expect(hashWith(mutate)).toBe(BASELINE);
    });
  }

  test("an inputSchema-only edit that MINTS A VERSION does re-ask", () => {
    // The ruling, stated as a test: `versionMaterialKey` folds in
    // `inputSchema` while `versionStepsHash` does not, so a schema-only
    // edit mints a new version id under an identical steps hash. We hash
    // the version id, so consent goes stale — the accepted cost.
    expect(
      hashWith((w) => {
        rootOf(w).inputSchema = { branch: { type: "select", label: "Branch" } };
        w.identities.set("root", { kind: "version", versionId: "ver-root-2", version: 2 });
      }),
    ).not.toBe(BASELINE);
  });
});

// ─────────────────────────────────────────────────────────────────────
// The three closure rules
// ─────────────────────────────────────────────────────────────────────

describe("rule 1 — the closure is computed with the OWNER's resolver", () => {
  test("two principals over the same cache hash differently", () => {
    // The `service` arm reads `system` visibility only, so its resolver
    // simply does not answer for the project-visible child.
    const asUser = hashWith();
    const asService = hashWith((w) => {
      w.delegation.runAs = { kind: "service", id: "svc-1" };
      w.defs = w.defs.filter((d) => d.name !== "child");
    });
    expect(asService).not.toBe(asUser);

    const serviceMaterial = materialWith((w) => {
      w.delegation.runAs = { kind: "service", id: "svc-1" };
      w.defs = w.defs.filter((d) => d.name !== "child");
    });
    expect(serviceMaterial.graph.map((g) => g.name)).toEqual(["root"]);
    expect(serviceMaterial.unresolved).toEqual(["child"]);
  });

  test("the resolver's view alone moves the hash, with no delegation change at all", () => {
    // Same delegation row, same definitions, narrower view: this is what
    // hashing the flat cache instead of the owner's view would erase.
    expect(hashWith((w) => { w.defs = w.defs.filter((d) => d.name !== "child"); })).not.toBe(
      BASELINE,
    );
  });
});

describe("rule 2 — unresolved, cycles and tooDeep are hashed", () => {
  test("an unresolved edge is recorded by NAME so a later resolution is visible", () => {
    const material = materialWith((w) => { w.defs = w.defs.filter((d) => d.name !== "child"); });
    expect(material.unresolved).toEqual(["child"]);
    expect(material.graph.map((g) => g.name)).toEqual(["root"]);
  });

  test("an unresolved edge resolving later invalidates consent", () => {
    const beforeSharing = hashWith((w) => { w.defs = w.defs.filter((d) => d.name !== "child"); });
    // The workflow gets shared, or a new row takes the name: the graph
    // silently gains a live step. It must not silently keep consent.
    expect(BASELINE).not.toBe(beforeSharing);
  });

  // ── The three diagnostics, ISOLATED from `graph` ──
  //
  // A nested step's TARGET NAME is deliberately absent from the per-step
  // material (rule 3: a child is hashed by resolved identity, never by
  // name). For an edge that resolves to nothing, therefore, these three
  // lists are the ONLY representation of it in the digest — which is what
  // makes each of the next three tests fail the moment its list is
  // dropped, with nothing else in the material moving to cover for it.

  test("re-pointing an edge from one UNRESOLVABLE name to another invalidates consent", () => {
    const ghost = (target: string) => (w: World) => {
      stepOf(w, "root", "s-nest").workflow = target;
    };
    expect(materialWith(ghost("ghost-a")).graph.map((g) => g.name)).toEqual(["root"]);
    expect(materialWith(ghost("ghost-a")).unresolved).toEqual(["ghost-a"]);
    expect(hashWith(ghost("ghost-a"))).not.toBe(hashWith(ghost("ghost-b")));
  });

  test("re-pointing an OVER-DEEP edge invalidates consent", () => {
    // root(0) → a(1) → b(2) → c(3) → target(4) — one past the cap, so the
    // target is reported and never resolved, at either name.
    const deep = (target: string) => (w: World) => {
      rootOf(w).steps = [{ name: "s-nest", kind: "workflow", workflow: "a" }];
      for (const [name, next] of [["a", "b"], ["b", "c"]] as const) {
        w.defs.push({
          name,
          description: name,
          steps: [{ name: `${name}-nest`, kind: "workflow", workflow: next }],
        });
        w.identities.set(name, { kind: "version", versionId: `ver-${name}`, version: 1 });
      }
      w.defs.push({
        name: "c",
        description: "c",
        steps: [{ name: "c-nest", kind: "workflow", workflow: target }],
      });
      w.identities.set("c", { kind: "version", versionId: "ver-c", version: 1 });
    };
    expect(materialWith(deep("deep-a")).graph.map((g) => g.name)).toEqual(["a", "b", "c", "root"]);
    expect(materialWith(deep("deep-a")).tooDeep).toEqual(["deep-a"]);
    expect(hashWith(deep("deep-a"))).not.toBe(hashWith(deep("deep-b")));
  });

  test("changing the SHAPE of a cycle invalidates consent", () => {
    const cyclic = (target: string) => (w: World) => {
      rootOf(w).steps = [{ name: "s-nest", kind: "workflow", workflow: "a" }];
      w.defs.push({
        name: "a",
        description: "a",
        steps: [{ name: "a-nest", kind: "workflow", workflow: target }],
      });
      w.identities.set("a", { kind: "version", versionId: "ver-a", version: 1 });
    };
    expect(materialWith(cyclic("root")).graph.map((g) => g.name)).toEqual(["a", "root"]);
    expect(materialWith(cyclic("root")).cycles).toEqual(["root -> a -> root"]);
    expect(materialWith(cyclic("a")).cycles).toEqual(["a -> a"]);
    expect(hashWith(cyclic("root"))).not.toBe(hashWith(cyclic("a")));
  });

  test("cycles and tooDeep are de-duplicated and sorted", () => {
    const material = materialWith((w) => {
      const child = w.defs.find((d) => d.name === "child");
      if (!child) throw new Error("fixture lost its child");
      child.steps.push({ name: "c-nest", kind: "workflow", workflow: "root" });
    });
    expect(material.cycles).toEqual(["root -> child -> root"]);
    expect(material.tooDeep).toEqual([]);
  });
});

describe("rule 3 — a child is hashed by RESOLVED IDENTITY, never by name", () => {
  test("an asset shadowing a nested name invalidates the root hash", () => {
    // The merged cache is extension → YAML → DB, first-match-wins, so an
    // asset taking the nested name re-points the edge without editing a
    // single definition the human read. The shadowing entry has NO
    // version row (`systemCachedWorkflow` sets `id: null`), which is why
    // `definition_version_id` alone cannot catch this.
    const shadowed = hashWith((w) => {
      const child = w.defs.find((d) => d.name === "child");
      if (!child) throw new Error("fixture lost its child");
      w.defs = [
        { ...structuredClone(child), description: "a shadowing YAML asset" },
        ...w.defs.filter((d) => d.name !== "child"),
      ];
      w.identities.set("child", { kind: "unversioned" });
    });
    expect(shadowed).not.toBe(BASELINE);
  });

  test("BYTE-IDENTICAL steps still change the hash when the identity kind differs", () => {
    // The sharpest form: the shadowing asset is a verbatim copy, so every
    // content-derived fingerprint of it agrees with the DB row's. Only the
    // versioned/unversioned discriminant separates them.
    const versioned = materialWith();
    const shadowed = materialWith((w) => { w.identities.set("child", { kind: "unversioned" }); });
    const versionedChild = versioned.graph.find((g) => g.name === "child");
    const shadowedChild = shadowed.graph.find((g) => g.name === "child");
    expect(versionedChild?.steps).toEqual(shadowedChild?.steps ?? []);
    expect(versionedChild?.capabilities).toEqual(shadowedChild?.capabilities ?? []);
    expect(versionedChild?.identity).toBe("version:ver-child@1");
    expect(shadowedChild?.identity).toMatch(/^unversioned:[0-9a-f]{64}$/);
    expect(hashWith((w) => { w.identities.set("child", { kind: "unversioned" }); })).not.toBe(
      BASELINE,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// The YAML / extension fallback — no version row exists to pin
// ─────────────────────────────────────────────────────────────────────

describe("a workflow with no version row", () => {
  const yamlWorld = (w: World) => {
    w.identities.clear();
  };

  test("hashes through the definition fallback, not a version id", () => {
    const material = materialWith(yamlWorld);
    for (const entry of material.graph) {
      expect(entry.identity).toMatch(/^unversioned:[0-9a-f]{64}$/);
    }
    expect(hashWith(yamlWorld)).not.toBe(BASELINE);
  });

  test("a step-body edit still invalidates it", () => {
    const base = hashWith(yamlWorld);
    const edited = hashWith((w) => {
      yamlWorld(w);
      stepOf(w, "root", "s-tool").tool = "ext__deploy";
    });
    expect(edited).not.toBe(base);
  });

  test("skipDependents alone still invalidates it — this is the case with no version to mint", () => {
    const base = hashWith(yamlWorld);
    const flip = (w: World) => {
      yamlWorld(w);
      stepOf(w, "root", "s-tool").skipDependents = false;
    };
    expect(hashWith(flip)).not.toBe(base);
    // Asserted on the material too: the fallback identity hashes `steps`,
    // so the digest would move here even if reachability were dropped as
    // an input. The material is where the property is actually stated.
    expect(materialWith(flip).graph.find((g) => g.name === "root")?.steps).toContainEqual({
      name: "s-tool",
      kind: "tool",
      when: "null",
      skipDependents: false,
      model: "null",
    });
  });

  test("a description edit still does NOT invalidate it", () => {
    const base = hashWith(yamlWorld);
    const retyped = hashWith((w) => {
      yamlWorld(w);
      rootOf(w).description = "a typo fix";
    });
    expect(retyped).toBe(base);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Capability-set details the hash must keep apart
// ─────────────────────────────────────────────────────────────────────

describe("the capability set", () => {
  test('"declares nothing" and "cannot be reached" are different facts', () => {
    const declaresNothing = hashWith((w) => { w.toolCaps.set("ext__notify", []); });
    const unreachable = hashWith((w) => { w.toolCaps.delete("ext__notify"); });
    expect(declaresNothing).not.toBe(unreachable);
    expect(
      materialWith((w) => { w.toolCaps.delete("ext__notify"); }).graph.find((g) => g.name === "root")
        ?.capabilities,
    ).toContain("tool:unreachable::ext__notify");
  });

  test("it is sorted and de-duplicated, so declaration order is not an input", () => {
    const ordered = hashWith((w) => {
      w.toolCaps.set("ext__notify", [
        { kind: "network", value: "hooks.example.com" },
        { kind: "env", value: "TOKEN" },
      ]);
    });
    const reversed = hashWith((w) => {
      w.toolCaps.set("ext__notify", [
        { kind: "env", value: "TOKEN" },
        { kind: "network", value: "hooks.example.com" },
        { kind: "env", value: "TOKEN" },
      ]);
    });
    expect(reversed).toBe(ordered);
  });

  test("gate, transform, approval and workflow steps contribute nothing", () => {
    const root = materialWith().graph.find((g) => g.name === "root");
    expect(root?.capabilities).toEqual([
      "agent::writer",
      "llm::anthropic",
      "network::hooks.example.com",
      "storage::",
      "tool::ext__notify",
    ]);
  });

  test("a step naming a model without a provider falls back to the AGENT's binding", () => {
    // `model` REPLACES `defaultModel` whole rather than merging field by
    // field, so this step does NOT inherit `defaultModel.provider`.
    const caps = materialWith((w) => {
      stepOf(w, "root", "s-agent").model = { temperature: 0.2 };
    }).graph.find((g) => g.name === "root")?.capabilities;
    expect(caps).toContain("llm::<agent-binding>");
    expect(caps).not.toContain("llm::anthropic");
  });

  test("a malformed step with no tool or agent name is recorded as unreachable", () => {
    const caps = materialWith((w) => {
      rootOf(w).steps = [
        { name: "no-tool", kind: "tool" },
        { name: "no-agent", kind: "agent" },
      ];
    }).graph.find((g) => g.name === "root")?.capabilities;
    expect(caps).toEqual([
      "agent::",
      "agent:unreachable::",
      "llm::anthropic",
      "tool::",
      "tool:unreachable::",
    ]);
  });

  test("a step with no explicit kind is an agent step", () => {
    const caps = materialWith((w) => {
      rootOf(w).steps = [{ name: "implicit", agent: "writer" }];
    }).graph.find((g) => g.name === "root")?.capabilities;
    expect(caps).toEqual(["agent::writer", "llm::anthropic", "storage::"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// The material the consent dialog reads
// ─────────────────────────────────────────────────────────────────────

describe("the returned material", () => {
  test("carries the delegation facts and the per-step reachability verbatim", () => {
    const material = materialWith();
    expect(material.extensionName).toBe("deploy-bot");
    expect(material.workflowName).toBe("root");
    expect(material.projectId).toBe("proj-1");
    expect(material.runAs).toEqual({ kind: "user", id: "user-1" });
    expect(material.trigger).toEqual({ kind: "cron", spec: { expr: "0 * * * *", tz: "UTC" } });

    const root = material.graph.find((g) => g.name === "root");
    expect(root?.defaultModel).toBe('{"model":"sonnet","provider":"anthropic"}');
    expect(root?.steps).toEqual([
      {
        name: "s-agent",
        kind: "agent",
        when: '{"op":"truthy","ref":"$input.go"}',
        skipDependents: false,
        model: "null",
      },
      { name: "s-tool", kind: "tool", when: "null", skipDependents: true, model: "null" },
      { name: "s-nest", kind: "workflow", when: "null", skipDependents: true, model: "null" },
      { name: "s-gate", kind: "gate", when: "null", skipDependents: true, model: "null" },
    ]);
  });

  test("a definition with no defaultModel serializes as null", () => {
    const child = materialWith().graph.find((g) => g.name === "child");
    expect(child?.defaultModel).toBe("null");
  });
});
