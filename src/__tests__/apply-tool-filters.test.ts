import { test, expect, describe } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BuiltinToolDef } from "../runtime/tools/types";
import {
  applyToolFilters,
  ORCHESTRATION_TOOLS,
  isPreservedOrchestrationTool,
  POLICY_LEAF_SPAWN_DENY,
} from "../runtime/tools/filter";

// Minimal test fixtures — we only need `name`, so cast the rest.
function tool(name: string): AgentTool {
  return { name } as unknown as AgentTool;
}

function def(name: string, category: BuiltinToolDef["category"]): BuiltinToolDef {
  return { name, category } as unknown as BuiltinToolDef;
}

// A realistic mix: two read, two write, one orchestration, one extension-only
const sample = (): AgentTool[] => [
  tool("read_file"),
  tool("grep"),
  tool("write_file"),
  tool("bash_execute"),
  tool("invoke_agent"),     // always-preserved orchestration tool
  tool("extension_widget"), // not in builtinDefs
];

const builtinDefs = new Map<string, BuiltinToolDef>([
  ["read_file", def("read_file", "read")],
  ["grep", def("grep", "read")],
  ["write_file", def("write_file", "write")],
  ["bash_execute", def("bash_execute", "execute")],
]);

const names = (ts: AgentTool[]) => ts.map((t) => t.name).sort();

describe("applyToolFilters", () => {
  test("no options is identity", () => {
    expect(names(applyToolFilters(sample(), builtinDefs, {}))).toEqual(names(sample()));
  });

  describe("toolRestriction", () => {
    test("read-only keeps read tools + orchestration; drops write/execute + unknown", () => {
      const out = applyToolFilters(sample(), builtinDefs, { toolRestriction: "read-only" });
      expect(names(out)).toEqual(["grep", "invoke_agent", "read_file"]);
    });

    test("none keeps only orchestration tools", () => {
      const out = applyToolFilters(sample(), builtinDefs, { toolRestriction: "none" });
      expect(names(out)).toEqual(["invoke_agent"]);
    });

    test("Phase B2: collect_agent_result is an always-preserved orchestration tool", () => {
      // Membership contract for the set (background collect must be reachable
      // even under the most restrictive scope, like invoke_agent).
      expect(ORCHESTRATION_TOOLS.has("collect_agent_result")).toBe(true);
      const withCollect = [...sample(), tool("collect_agent_result")];
      // Survives toolRestriction: "none" ...
      expect(
        names(applyToolFilters(withCollect, builtinDefs, { toolRestriction: "none" })),
      ).toEqual(["collect_agent_result", "invoke_agent"]);
      // ... and a broad deny (only forceDeniedTools can strip orchestration tools).
      expect(
        names(
          applyToolFilters(withCollect, builtinDefs, {
            deniedTools: ["collect_agent_result"],
          }),
        ),
      ).toContain("collect_agent_result");
    });

    test("all is a no-op", () => {
      const out = applyToolFilters(sample(), builtinDefs, { toolRestriction: "all" });
      expect(names(out)).toEqual(names(sample()));
    });
  });

  describe("readOnlyAllowedTools — host-vouched read-safe tools (briefing watchlist)", () => {
    test("read-only keeps a vouched extension tool; write/execute stay stripped", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "read-only",
        readOnlyAllowedTools: ["extension_widget"],
      });
      expect(names(out)).toEqual(["extension_widget", "grep", "invoke_agent", "read_file"]);
      expect(names(out)).not.toContain("write_file");
      expect(names(out)).not.toContain("bash_execute");
    });

    test("empty list is exactly the pre-existing read-only behavior (fail-closed default)", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "read-only",
        readOnlyAllowedTools: [],
      });
      expect(names(out)).toEqual(["grep", "invoke_agent", "read_file"]);
    });

    test("ignored under 'none' — vouching never resurrects tools there", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "none",
        readOnlyAllowedTools: ["extension_widget"],
      });
      expect(names(out)).toEqual(["invoke_agent"]);
    });

    test("inert under 'allowlist' — vouching never widens an allowlist scope", () => {
      // The vouch is honored ONLY inside the read-only branch. Under an
      // allowlist restriction the allowedTools set is the single source
      // of truth; a vouched name outside it must NOT be resurrected.
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "allowlist",
        allowedTools: ["read_file"],
        readOnlyAllowedTools: ["extension_widget", "write_file"],
      });
      expect(names(out)).toEqual(["invoke_agent", "read_file"]);
    });

    test("inert under a fail-closed 'allowlist' (no allowedTools) — vouching cannot reopen it", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "allowlist",
        readOnlyAllowedTools: ["extension_widget"],
      });
      expect(names(out)).toEqual(["invoke_agent"]);
    });

    test("no effect without a restriction (modifier of read-only only)", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        readOnlyAllowedTools: ["extension_widget"],
      });
      expect(names(out)).toEqual(names(sample()));
    });

    test("layered: a vouched tool can still be denied downstream", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "read-only",
        readOnlyAllowedTools: ["extension_widget"],
        deniedTools: ["extension_widget"],
      });
      expect(names(out)).toEqual(["grep", "invoke_agent", "read_file"]);
    });

    test("trust contract pin: a vouched name is kept regardless of builtin category — vouching is the caller's responsibility", () => {
      // The field is a HOST-CODE trust declaration; the filter does not
      // second-guess it. Pinned so a future "category override" refactor
      // is a conscious decision, not an accident.
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "read-only",
        readOnlyAllowedTools: ["write_file"],
      });
      expect(names(out)).toContain("write_file");
      expect(names(out)).not.toContain("bash_execute");
    });
  });

  describe("allowedTools", () => {
    test("keeps only listed tools (plus orchestration, always)", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        allowedTools: ["read_file"],
      });
      expect(names(out)).toEqual(["invoke_agent", "read_file"]);
    });

    test("empty allowedTools list is a no-op (not an allow-none)", () => {
      const out = applyToolFilters(sample(), builtinDefs, { allowedTools: [] });
      expect(names(out)).toEqual(names(sample()));
    });
  });

  describe("deniedTools", () => {
    test("removes listed tools but preserves orchestration", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        deniedTools: ["bash_execute", "write_file", "invoke_agent"],
      });
      // invoke_agent is orchestration → preserved even when denied
      expect(names(out)).toEqual(["extension_widget", "grep", "invoke_agent", "read_file"]);
    });

    test("empty deniedTools list is a no-op", () => {
      const out = applyToolFilters(sample(), builtinDefs, { deniedTools: [] });
      expect(names(out)).toEqual(names(sample()));
    });
  });

  describe("layered filters", () => {
    test("read-only + deny: intersects correctly", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "read-only",
        deniedTools: ["grep"],
      });
      // read-only leaves [grep, invoke_agent, read_file]; deny removes grep
      expect(names(out)).toEqual(["invoke_agent", "read_file"]);
    });

    test("allow + deny: deny applied after allow", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        allowedTools: ["read_file", "grep", "write_file"],
        deniedTools: ["write_file"],
      });
      expect(names(out)).toEqual(["grep", "invoke_agent", "read_file"]);
    });

    test("restriction:none + allow: orchestration always wins over allow semantics", () => {
      const out = applyToolFilters(sample(), builtinDefs, {
        toolRestriction: "none",
        allowedTools: ["read_file"],
      });
      // "none" strips to orchestration-only BEFORE allow filter runs
      expect(names(out)).toEqual(["invoke_agent"]);
    });
  });

  test("ORCHESTRATION_TOOLS includes the expected delegation and task primitives", () => {
    expect(ORCHESTRATION_TOOLS.has("invoke_agent")).toBe(true);
    // The registry exposes the ask-user tool under the namespaced form
    // — that's what the filter must preserve so the LLM never sees a
    // restrictive scope strip its access to the human-in-the-loop tool.
    expect(ORCHESTRATION_TOOLS.has("ask-user__ask_user_question")).toBe(true);
    // ask_human was renamed/replaced by ask_user_question in the
    // ask-user migration; legacy and bare-name forms must NOT be in
    // the preserved set.
    expect(ORCHESTRATION_TOOLS.has("ask_human")).toBe(false);
    expect(ORCHESTRATION_TOOLS.has("ask_user_question")).toBe(false);
    expect(ORCHESTRATION_TOOLS.has("task_plan")).toBe(true);
    // Scratchpad moved to the `scratchpad` bundled extension in Phase 1 —
    // the filter now matches the namespaced form (`<ext>__<tool>`).
    expect(ORCHESTRATION_TOOLS.has("scratchpad__scratchpad_read")).toBe(true);
    expect(ORCHESTRATION_TOOLS.has("scratchpad__scratchpad_write")).toBe(true);
    // The bare (pre-conversion) names must NOT be preserved — a stray
    // built-in invocation should be blocked under restrictive filters.
    expect(ORCHESTRATION_TOOLS.has("scratchpad_read")).toBe(false);
    expect(ORCHESTRATION_TOOLS.has("scratchpad_write")).toBe(false);
    expect(ORCHESTRATION_TOOLS.has("read_file")).toBe(false);
  });
});

describe("forceDeniedTools — the only layer that strips orchestration tools", () => {
  test("removes orchestration tools (regular deniedTools cannot)", () => {
    const out = applyToolFilters(sample(), builtinDefs, {
      forceDeniedTools: ["invoke_agent"],
    });
    const names = out.map((t) => t.name);
    expect(names).not.toContain("invoke_agent");
    // Everything else untouched.
    expect(names).toContain("read_file");
    expect(names).toContain("extension_widget");
  });

  test("contrast pin: the same name via deniedTools is preserved", () => {
    const out = applyToolFilters(sample(), builtinDefs, {
      deniedTools: ["invoke_agent"],
    });
    expect(out.map((t) => t.name)).toContain("invoke_agent");
  });

  test("applies LAST: a tool surviving the allowlist via orchestration still drops", () => {
    const out = applyToolFilters(sample(), builtinDefs, {
      toolRestriction: "allowlist",
      allowedTools: ["read_file"],
      forceDeniedTools: ["invoke_agent"],
    });
    expect(out.map((t) => t.name)).toEqual(["read_file"]);
  });

  test("empty / absent forceDeniedTools is a no-op", () => {
    expect(applyToolFilters(sample(), builtinDefs, { forceDeniedTools: [] })).toHaveLength(6);
    expect(applyToolFilters(sample(), builtinDefs, {})).toHaveLength(6);
  });

  test("removes non-orchestration tools too (it is a superset of deny)", () => {
    const out = applyToolFilters(sample(), builtinDefs, {
      forceDeniedTools: ["write_file", "extension_widget"],
    });
    const names = out.map((t) => t.name);
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("extension_widget");
    expect(names).toContain("invoke_agent");
  });
});

// ── FU2: carve-out name normalization (namespaced vs bare) ─────────
//
// task-tracking wires its tools NAMESPACED (`task-tracking__task_plan`), but
// ORCHESTRATION_TOOLS lists them BARE (`task_plan`). Before normalization those
// bare entries were dead and the task tools were stripped under restrictive
// scopes — an orchestrator lost task_plan et al. The filter now matches both
// the raw name (namespaced set entries like `ask-user__ask_user_question`) and
// the namespace-stripped name (bare set entries for namespaced-wired tools).

describe("applyToolFilters — carve-out matches namespaced task-tracking tools", () => {
  const withTaskTracking = (): AgentTool[] => [
    tool("read_file"),
    tool("write_file"),
    tool("task-tracking__task_plan"), // namespaced-wired, bare set entry
    tool("task-tracking__task_complete"),
    tool("ask-user__ask_user_question"), // namespaced set entry (raw match)
    tool("some-ext__task_plan"), // NON-orchestration ext coincidence — still preserved (accepted)
    tool("some-ext__write_file"), // non-orchestration namespaced tool
  ];

  test("toolRestriction 'none' preserves namespaced task-tracking tools (were previously stripped)", () => {
    const out = names(applyToolFilters(withTaskTracking(), builtinDefs, { toolRestriction: "none" }));
    // Preserved: the namespaced task tools + the namespaced ask-user tool.
    expect(out).toContain("task-tracking__task_plan");
    expect(out).toContain("task-tracking__task_complete");
    expect(out).toContain("ask-user__ask_user_question");
    // Stripped: ordinary tools not in the carve-out.
    expect(out).not.toContain("read_file");
    expect(out).not.toContain("write_file");
    expect(out).not.toContain("some-ext__write_file");
  });

  test("deniedTools cannot strip a namespaced task tool (carve-out wins)", () => {
    const out = names(
      applyToolFilters(withTaskTracking(), builtinDefs, {
        deniedTools: ["task-tracking__task_plan", "some-ext__write_file"],
      }),
    );
    expect(out).toContain("task-tracking__task_plan"); // carve-out preserved
    expect(out).not.toContain("some-ext__write_file"); // ordinary tool denied
  });

  test("isPreservedOrchestrationTool: matches bare, namespaced-bare-entry, and namespaced set entries; not arbitrary tools", () => {
    // Bare orchestration tool (2d-wired invoke_agent / collect).
    expect(isPreservedOrchestrationTool("invoke_agent")).toBe(true);
    expect(isPreservedOrchestrationTool("collect_agent_result")).toBe(true);
    // Namespaced-wired, bare set entry (task-tracking).
    expect(isPreservedOrchestrationTool("task-tracking__task_plan")).toBe(true);
    expect(ORCHESTRATION_TOOLS.has("task_plan")).toBe(true); // the bare set entry it strips to
    // Namespaced set entry (raw match).
    expect(isPreservedOrchestrationTool("ask-user__ask_user_question")).toBe(true);
    // Arbitrary tool → not preserved.
    expect(isPreservedOrchestrationTool("myext__do_thing")).toBe(false);
    expect(isPreservedOrchestrationTool("write_file")).toBe(false);
  });
});

// ── policyForceDenyBare — the per-API-key tool policy layer ────────
//
// A NAMESPACE-STRIPPING deny, applied after `forceDeniedTools` and exempt
// from nothing. The three properties below are the layer: it catches the
// namespaced form (which exact-match `forceDeniedTools` misses, and which is
// how every spawn primitive except the orchestration trio is actually
// wired), it outranks the orchestration carve-out, and it lets a caller tool
// through. The wired-surface suite
// (`policy-force-deny-wired-surface.test.ts`) proves the same three against
// the REAL registry; these pin the filter itself.

describe("policyForceDenyBare", () => {
  const mixed = (): AgentTool[] => [
    tool("read_file"),
    tool("invoke_agent"),
    tool("task-tracking__task_add"),
    tool("task-tracking__task_complete"),
    tool("ez-code__dispatch_run"),
    tool("_caller__open_app"),
  ];

  test("matches a NAMESPACED tool by its stripped name", () => {
    const out = names(
      applyToolFilters(mixed(), builtinDefs, { policyForceDenyBare: ["task_add"] }),
    );
    expect(out).not.toContain("task-tracking__task_add");
    // The sibling that strips to a name NOT in the set is untouched.
    expect(out).toContain("task-tracking__task_complete");
  });

  test("contrast pin: forceDeniedTools is exact-match and MISSES the namespaced form", () => {
    // This is the defect the layer exists for. If this contrast ever stops
    // holding, `policyForceDenyBare` has become redundant — and if it holds
    // while the test above fails, the policy is not enforcing anything.
    const out = names(
      applyToolFilters(mixed(), builtinDefs, { forceDeniedTools: ["task_add"] }),
    );
    expect(out).toContain("task-tracking__task_add");
  });

  test("a BARE builtin self-matches (stripToolNamespace is identity on it)", () => {
    const out = names(
      applyToolFilters(mixed(), builtinDefs, { policyForceDenyBare: ["invoke_agent"] }),
    );
    expect(out).not.toContain("invoke_agent");
  });

  test("outranks the orchestration carve-out AND preservedTools", () => {
    // Both preservation mechanisms name the tool; neither may save it. A
    // credential confinement a mode could re-admit would not be one.
    const out = names(
      applyToolFilters(mixed(), builtinDefs, {
        toolRestriction: "none",
        preservedTools: ["task-tracking__task_add"],
        policyForceDenyBare: ["task_add", "invoke_agent"],
      }),
    );
    expect(out).not.toContain("task-tracking__task_add");
    expect(out).not.toContain("invoke_agent");
  });

  test("a caller tool SURVIVES — `_caller__open_app` strips to `open_app`", () => {
    const out = names(
      applyToolFilters(mixed(), builtinDefs, {
        policyForceDenyBare: [...POLICY_LEAF_SPAWN_DENY],
        preservedTools: ["_caller__open_app"],
      }),
    );
    expect(out).toContain("_caller__open_app");
    // …while the whole spawn surface went.
    expect(out).not.toContain("invoke_agent");
    expect(out).not.toContain("task-tracking__task_add");
    expect(out).not.toContain("ez-code__dispatch_run");
  });

  test("empty / absent is a no-op — an unpolicied key sees the old surface", () => {
    expect(applyToolFilters(mixed(), builtinDefs, { policyForceDenyBare: [] })).toHaveLength(6);
    expect(applyToolFilters(mixed(), builtinDefs, {})).toHaveLength(6);
  });

  test("the deliberately-KEPT task tools are not in the set", () => {
    for (const kept of ["task_start", "task_complete", "task_fail", "task_list"]) {
      expect({ tool: kept, denied: POLICY_LEAF_SPAWN_DENY.has(kept) }).toEqual({
        tool: kept,
        denied: false,
      });
    }
  });
});
