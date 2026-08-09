/**
 * C3's consent hash — now TWO digests over two disjoint projections.
 *
 * The module is pure, so the matrix is exhaustive in every direction and
 * that is the point. What changed is that "the digest moves" became
 * "WHICH digest moves":
 *
 *   • **SEMANTIC** (`hash`, stored as `consent_hash`) — the delegation
 *     facts, the FLAT capability closure, and the walk's bounds. This is
 *     what the job may reach, and a difference here is judged by the
 *     widening test at fire time.
 *   • **ADVISORY** (`definitionHash`, stored as `definition_hash`) — the
 *     graph as written: names, resolved version identities, default model
 *     bindings, step lists. A difference here NEVER parks a run on its
 *     own; it carries consent forward and leaves an audit row.
 *
 * The split exists because one combined digest made every release a
 * consent event: a **bundled** extension ships its workflows inside the
 * app image, so any edit to one parked every delegation on it. So the
 * matrix below is three-way rather than two-way:
 *
 *   • {@link SEMANTIC_INVALIDATING} — moves the semantic digest. Dropping
 *     any one of these inputs is how a job comes to reach something the
 *     human never approved.
 *   • {@link DEFINITION_INVALIDATING} — moves the ADVISORY digest and
 *     provably NOT the semantic one. Each row is asserted both ways,
 *     because "it moved something" would be satisfied by folding the
 *     graph back into the consent digest and re-creating the bug.
 *   • {@link NOT_INVALIDATING} — moves neither. The consent-fatigue
 *     direction: a hash that re-asked on a prose edit would train people
 *     to click through, and then the dialog that matters is not read.
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
    agentCaps: new Map<string, ConsentCapability[]>([["writer", [{ kind: "storage" }]]]),
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

/** The SEMANTIC digest of the fixture after exactly one mutation. */
function hashWith(mutate?: (w: World) => void): string {
  const w = fixture();
  mutate?.(w);
  return computeWorkflowConsentHash(rootOf(w), w.delegation, sourcesOf(w)).hash;
}

/** The ADVISORY graph digest, same fixture, same one mutation. */
function defHashWith(mutate?: (w: World) => void): string {
  const w = fixture();
  mutate?.(w);
  return computeWorkflowConsentHash(rootOf(w), w.delegation, sourcesOf(w)).definitionHash;
}

function materialWith(mutate?: (w: World) => void) {
  const w = fixture();
  mutate?.(w);
  return computeWorkflowConsentHash(rootOf(w), w.delegation, sourcesOf(w)).material;
}

const BASELINE = hashWith();
const DEF_BASELINE = defHashWith();

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
        steps: root.steps.map((s) => ({
          ...Object.fromEntries(Object.entries(s).reverse()),
        })) as typeof root.steps,
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
// Every SEMANTIC input, individually invalidating. One defect per test.
// ─────────────────────────────────────────────────────────────────────

/** [what it proves, the single mutation]. Each row must produce a
 *  SEMANTIC digest different from `BASELINE` AND from every other row. */
const SEMANTIC_INVALIDATING: Array<[string, (w: World) => void]> = [
  // #1 extension name — a delegation presented by another extension.
  [
    "1. extensionName",
    (w) => {
      w.delegation.extensionName = "other-bot";
    },
  ],

  // #2 fully-qualified workflow name.
  [
    "2. workflowName",
    (w) => {
      w.delegation.workflowName = "ext:root";
    },
  ],

  // #4 the capability set.
  [
    "4a. a tool gains a capability the closure did not already reach",
    (w) => {
      w.toolCaps.set("ext__notify", [
        { kind: "network", value: "hooks.example.com" },
        { kind: "env", value: "DEPLOY_TOKEN" },
      ]);
    },
  ],
  [
    "4b. a tool loses a capability (the set SHRINKS — still stale)",
    (w) => {
      w.toolCaps.set("ext__notify", []);
    },
  ],
  [
    "4c. T11 — the manifest narrows so the tool is unreachable",
    (w) => {
      w.toolCaps.delete("ext__notify");
    },
  ],
  [
    "4d. an agent's tool scope changes",
    (w) => {
      w.agentCaps.set("writer", [{ kind: "storage" }, { kind: "fs.read", value: "/etc" }]);
    },
  ],
  [
    "4e. the agent becomes unreachable",
    (w) => {
      w.agentCaps.delete("writer");
    },
  ],
  [
    "4f. a NESTED definition's tool gains a capability",
    (w) => {
      w.toolCaps.set("ext__deploy", [{ kind: "shell" }, { kind: "fs.write", value: "/" }]);
    },
  ],
  [
    "4g. a step's tool is re-pointed",
    (w) => {
      stepOf(w, "root", "s-tool").tool = "ext__deploy";
    },
  ],
  [
    "4h. a step's agent is re-pointed",
    (w) => {
      stepOf(w, "root", "s-agent").agent = "shipper";
    },
  ],

  // #5 the transitive closure.
  [
    "5a. a nested edge is added",
    (w) => {
      rootOf(w).steps.push({ name: "s-nest-2", kind: "workflow", workflow: "bystander" });
    },
  ],
  [
    "5b. a nested edge is removed",
    (w) => {
      rootOf(w).steps = rootOf(w).steps.filter((s) => s.name !== "s-nest");
    },
  ],
  [
    "5c. a nested edge is re-pointed at another definition",
    (w) => {
      stepOf(w, "root", "s-nest").workflow = "bystander";
    },
  ],
  [
    "5d. a nested definition's body changes (identity pinned by name)",
    (w) => {
      stepOf(w, "child", "c-tool").tool = "ext__rm";
    },
  ],
  [
    "5e. unresolved — an edge that points nowhere today may resolve tomorrow",
    (w) => {
      w.defs = w.defs.filter((d) => d.name !== "child");
    },
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
      for (const [name, next] of [
        ["g1", "g2"],
        ["g2", "g3"],
      ] as const) {
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
  [
    "6a. trigger kind",
    (w) => {
      w.delegation.trigger.kind = "webhook";
    },
  ],
  [
    "6b. trigger spec",
    (w) => {
      w.delegation.trigger.spec = { expr: "*/5 * * * *", tz: "UTC" };
    },
  ],

  // #7 project and the run-as principal.
  [
    "7a. projectId",
    (w) => {
      w.delegation.projectId = "proj-2";
    },
  ],
  [
    "7b. runAs kind",
    (w) => {
      w.delegation.runAs = { kind: "service", id: "user-1" };
    },
  ],
  [
    "7c. runAs id",
    (w) => {
      w.delegation.runAs = { kind: "user", id: "user-2" };
    },
  ],

  // #8 the model-override set.
  [
    // The PROVIDER moved, so the `llm::` capability key moved with it —
    // which is a reach fact, not a spelling one.
    "8a. a per-step model override appears, naming a NEW provider",
    (w) => {
      stepOf(w, "root", "s-agent").model = { provider: "openai", model: "o3" };
    },
  ],
];

// ─────────────────────────────────────────────────────────────────────
// Every ADVISORY input: it moves the GRAPH digest and provably NOT the
// consent digest. These are the ones a release moves, and the whole
// point of the split is that they no longer re-ask.
// ─────────────────────────────────────────────────────────────────────

const DEFINITION_INVALIDATING: Array<[string, (w: World) => void]> = [
  // #3 the version id, and the version number, of the ROOT.
  [
    "3a. root version id",
    (w) => {
      w.identities.set("root", { kind: "version", versionId: "ver-root-2", version: 1 });
    },
  ],
  [
    "3b. root version number",
    (w) => {
      w.identities.set("root", { kind: "version", versionId: "ver-root", version: 2 });
    },
  ],
  // #3, nested arm: a child edit the parent's own version id cannot see.
  [
    "3c. nested version id",
    (w) => {
      w.identities.set("child", { kind: "version", versionId: "ver-child-2", version: 1 });
    },
  ],

  // #8 the model-override set, WITHIN one provider.
  [
    // Isolates #8 from #4: the PROVIDER is unchanged, so the `llm::`
    // capability is identical and only the binding itself moved. A silent
    // re-point from Sonnet to Opus is a 30× spend change on the owner's
    // credits — which is why it must still be fingerprinted, and why the
    // ADVISORY digest is recorded rather than merely omitted.
    "8c. a per-step model is re-pointed WITHIN the same provider",
    (w) => {
      stepOf(w, "root", "s-agent").model = { provider: "anthropic", model: "opus" };
    },
  ],
  [
    "8b. the definition-level default model is re-pointed",
    (w) => {
      rootOf(w).defaultModel = { provider: "anthropic", model: "opus" };
    },
  ],

  // #9 reachability — `when` AND `skipDependents`.
  [
    "9a. when",
    (w) => {
      stepOf(w, "root", "s-agent").when = { ref: "$input.go", op: "exists" };
    },
  ],
  [
    "9b. when removed entirely",
    (w) => {
      stepOf(w, "root", "s-agent").when = undefined;
    },
  ],
  [
    "9c. skipDependents flipped false → true",
    (w) => {
      stepOf(w, "root", "s-agent").skipDependents = true;
    },
  ],
  [
    "9d. skipDependents flipped true → false on a step that relied on the default",
    (w) => {
      stepOf(w, "root", "s-tool").skipDependents = false;
    },
  ],

  // Structural: step order decides batch composition.
  [
    "10. step order",
    (w) => {
      rootOf(w).steps.reverse();
    },
  ],
  [
    "11. a step is renamed",
    (w) => {
      stepOf(w, "root", "s-gate").name = "s-gate-2";
    },
  ],
  [
    "12. a step kind changes",
    (w) => {
      stepOf(w, "root", "s-gate").kind = "transform";
    },
  ],
];

describe("every SEMANTIC input individually invalidates consent", () => {
  for (const [label, mutate] of SEMANTIC_INVALIDATING) {
    test(label, () => {
      expect(hashWith(mutate)).not.toBe(BASELINE);
    });
  }
});

describe("every DEFINITION input moves the ADVISORY digest and NOT the consent one", () => {
  for (const [label, mutate] of DEFINITION_INVALIDATING) {
    test(label, () => {
      // Both halves, every row. "It moved something" would be satisfied by
      // folding the graph back into the consent digest — which is exactly
      // the defect: a bundled extension's release parking every job.
      expect(defHashWith(mutate)).not.toBe(DEF_BASELINE);
      expect(hashWith(mutate)).toBe(BASELINE);
    });
  }
});

describe("the two digests together discriminate every input", () => {
  const ALL = [...SEMANTIC_INVALIDATING, ...DEFINITION_INVALIDATING];

  test("no two of them collide on the PAIR", () => {
    // Over the pair rather than over either digest alone: a semantic
    // change and a definition change can legitimately agree on the half
    // they do not touch, and the property that matters is that the record
    // as a whole still tells them apart.
    //
    // Grouped by pair rather than counted, so a failure NAMES the two
    // mutations that became indistinguishable instead of reporting
    // `34 !== 35` and leaving the reader to find them.
    const byPair = new Map<string, string[]>();
    for (const [label, m] of ALL) {
      const key = `${hashWith(m)}|${defHashWith(m)}`;
      byPair.set(key, [...(byPair.get(key) ?? []), label]);
    }
    expect([...byPair.values()].filter((labels) => labels.length > 1)).toEqual([]);
    expect(byPair.size).toBe(ALL.length);
    expect(byPair.has(`${BASELINE}|${DEF_BASELINE}`)).toBe(false);
  });

  test("the two digests of one record are never the same value", () => {
    expect(DEF_BASELINE).toMatch(/^[0-9a-f]{64}$/);
    expect(DEF_BASELINE).not.toBe(BASELINE);
  });
});

describe("the capability closure is FLAT — attribution is the dialog's, not the digest's", () => {
  test("a capability the closure ALREADY reaches, added to a second tool, moves neither digest", () => {
    // Deliberate, and the one place the split trades resolution away.
    // `ext__deploy` in the child already declares `shell`, so the job could
    // already shell; `ext__notify` gaining it adds no REACH, and reach is
    // what a consent control refuses. The graph did not move either, so
    // this is a genuine no-op rather than a carry-forward.
    const alsoShell = (w: World) => {
      w.toolCaps.set("ext__notify", [
        { kind: "network", value: "hooks.example.com" },
        { kind: "shell" },
      ]);
    };
    expect(hashWith(alsoShell)).toBe(BASELINE);
    expect(defHashWith(alsoShell)).toBe(DEF_BASELINE);
    // …and the PER-DEFINITION attribution the consent dialog renders does
    // move, so a human re-reading the material still sees where it came
    // from. Only the digest flattens.
    expect(materialWith(alsoShell).graph.find((g) => g.name === "root")?.capabilities).toContain(
      "shell::",
    );
  });

  test("…but the same capability arriving where the closure reached NOTHING like it does move it", () => {
    // The pair. Without it "flat" would be indistinguishable from "not
    // hashed at all".
    expect(
      hashWith((w) => {
        w.toolCaps.set("ext__notify", [
          { kind: "network", value: "hooks.example.com" },
          { kind: "env", value: "DEPLOY_TOKEN" },
        ]);
      }),
    ).not.toBe(BASELINE);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Every exclusion, individually NOT invalidating.
// ─────────────────────────────────────────────────────────────────────

const NOT_INVALIDATING: Array<[string, (w: World) => void]> = [
  [
    "input values",
    (w) => {
      w.delegation.input = { branch: "release", extra: 1 };
    },
  ],
  [
    "input values dropped entirely",
    (w) => {
      w.delegation.input = null;
    },
  ],
  [
    "display name",
    (w) => {
      w.delegation.displayName = "Renamed by the owner";
    },
  ],
  [
    "concurrency policy",
    (w) => {
      w.delegation.concurrency = { policy: "queue" };
    },
  ],
  [
    "the root's description",
    (w) => {
      rootOf(w).description = "a typo fix";
    },
  ],
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
    (w) => {
      rootOf(w).inputSchema = { branch: { type: "string", label: "Branch" } };
    },
  ],
];

describe("every exclusion individually does NOT invalidate consent", () => {
  for (const [label, mutate] of NOT_INVALIDATING) {
    test(label, () => {
      // NEITHER digest. An exclusion that moved the advisory one would
      // write an "re-authorized by release" audit row on every fire for a
      // release that never happened.
      expect(hashWith(mutate)).toBe(BASELINE);
      expect(defHashWith(mutate)).toBe(DEF_BASELINE);
    });
  }

  test("an inputSchema-only edit that MINTS A VERSION moves the ADVISORY digest only", () => {
    // The ruling, restated for the split: `versionMaterialKey` folds in
    // `inputSchema` while `versionStepsHash` does not, so a schema-only
    // edit mints a new version id under an identical steps hash. We still
    // fingerprint the version id — it is the coarser, dumber, safer key —
    // but it lands in the ADVISORY digest, so the edit carries consent
    // forward instead of re-asking. That was the accepted cost; it is no
    // longer a cost.
    const schemaEdit = (w: World) => {
      rootOf(w).inputSchema = { branch: { type: "select", label: "Branch" } };
      w.identities.set("root", { kind: "version", versionId: "ver-root-2", version: 2 });
    };
    expect(defHashWith(schemaEdit)).not.toBe(DEF_BASELINE);
    expect(hashWith(schemaEdit)).toBe(BASELINE);
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
    expect(
      hashWith((w) => {
        w.defs = w.defs.filter((d) => d.name !== "child");
      }),
    ).not.toBe(BASELINE);
  });
});

describe("rule 2 — unresolved, cycles and tooDeep are hashed", () => {
  test("an unresolved edge is recorded by NAME so a later resolution is visible", () => {
    const material = materialWith((w) => {
      w.defs = w.defs.filter((d) => d.name !== "child");
    });
    expect(material.unresolved).toEqual(["child"]);
    expect(material.graph.map((g) => g.name)).toEqual(["root"]);
  });

  test("an unresolved edge resolving later invalidates consent", () => {
    const beforeSharing = hashWith((w) => {
      w.defs = w.defs.filter((d) => d.name !== "child");
    });
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
      for (const [name, next] of [
        ["a", "b"],
        ["b", "c"],
      ] as const) {
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
  test("an asset shadowing a nested name moves the ADVISORY digest", () => {
    // The merged cache is extension → YAML → DB, first-match-wins, so an
    // asset taking the nested name re-points the edge without editing a
    // single definition the human read. The shadowing entry has NO
    // version row (`systemCachedWorkflow` sets `id: null`), which is why
    // `definition_version_id` alone cannot catch this.
    //
    // Identity lives in the ADVISORY projection, so a shadow whose STEPS
    // are a verbatim copy reaches exactly what the human approved and is
    // carried forward. A shadow that reaches anything MORE moves the
    // capability closure and parks — which is the next test.
    const shadow = (w: World) => {
      const child = w.defs.find((d) => d.name === "child");
      if (!child) throw new Error("fixture lost its child");
      w.defs = [
        { ...structuredClone(child), description: "a shadowing YAML asset" },
        ...w.defs.filter((d) => d.name !== "child"),
      ];
      w.identities.set("child", { kind: "unversioned" });
    };
    expect(defHashWith(shadow)).not.toBe(DEF_BASELINE);
    expect(hashWith(shadow)).toBe(BASELINE);
  });

  test("a shadow that REACHES MORE moves the consent digest too", () => {
    // The pair, and the load-bearing half: the vector rule 3 exists for
    // is a name re-pointed at a graph the human never read. Fingerprinting
    // the identity is what makes the swap visible at all; the closure is
    // what decides whether it may run unattended.
    const hostileShadow = (w: World) => {
      w.defs = [
        {
          name: "child",
          description: "a shadowing YAML asset",
          steps: [{ name: "c-tool", kind: "tool", tool: "ext__rm" }],
        },
        ...w.defs.filter((d) => d.name !== "child"),
      ];
      w.identities.set("child", { kind: "unversioned" });
    };
    expect(hashWith(hostileShadow)).not.toBe(BASELINE);
    expect(defHashWith(hostileShadow)).not.toBe(DEF_BASELINE);
  });

  test("BYTE-IDENTICAL steps still change the ADVISORY digest when the identity kind differs", () => {
    // The sharpest form: the shadowing asset is a verbatim copy, so every
    // content-derived fingerprint of it agrees with the DB row's. Only the
    // versioned/unversioned discriminant separates them.
    const versioned = materialWith();
    const shadowed = materialWith((w) => {
      w.identities.set("child", { kind: "unversioned" });
    });
    const versionedChild = versioned.graph.find((g) => g.name === "child");
    const shadowedChild = shadowed.graph.find((g) => g.name === "child");
    expect(versionedChild?.steps).toEqual(shadowedChild?.steps ?? []);
    expect(versionedChild?.capabilities).toEqual(shadowedChild?.capabilities ?? []);
    expect(versionedChild?.identity).toBe("version:ver-child@1");
    expect(shadowedChild?.identity).toMatch(/^unversioned:[0-9a-f]{64}$/);
    expect(
      defHashWith((w) => {
        w.identities.set("child", { kind: "unversioned" });
      }),
    ).not.toBe(DEF_BASELINE);
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
    // Identity is ADVISORY, so losing every version row re-fingerprints
    // the graph and leaves the reach — which did not change — alone.
    expect(defHashWith(yamlWorld)).not.toBe(DEF_BASELINE);
    expect(hashWith(yamlWorld)).toBe(BASELINE);
  });

  test("a step-body edit still invalidates it", () => {
    const base = hashWith(yamlWorld);
    const edited = hashWith((w) => {
      yamlWorld(w);
      stepOf(w, "root", "s-tool").tool = "ext__deploy";
    });
    expect(edited).not.toBe(base);
  });

  test("skipDependents alone still moves the ADVISORY digest — the case with no version to mint", () => {
    const base = defHashWith(yamlWorld);
    const flip = (w: World) => {
      yamlWorld(w);
      stepOf(w, "root", "s-tool").skipDependents = false;
    };
    expect(defHashWith(flip)).not.toBe(base);
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
    const declaresNothing = hashWith((w) => {
      w.toolCaps.set("ext__notify", []);
    });
    const unreachable = hashWith((w) => {
      w.toolCaps.delete("ext__notify");
    });
    expect(declaresNothing).not.toBe(unreachable);
    expect(
      materialWith((w) => {
        w.toolCaps.delete("ext__notify");
      }).graph.find((g) => g.name === "root")?.capabilities,
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
