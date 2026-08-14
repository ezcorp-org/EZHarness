/**
 * Caller-executed tool DECLARATION rules
 * (`runtime/caller-tool-declarations.ts`).
 *
 * Why every rule below is worth a test rather than a code read:
 *
 *   - `BuiltinToolDef.parameters` is a `Type.Unsafe(...)` and pi-agent-core
 *     does not validate tool arguments at runtime, so a malformed schema does
 *     not fail here — it reaches the provider, which 400s the request, and
 *     keeps 400-ing every subsequent turn of that conversation. This module is
 *     the only place that can catch it, and only on the way in.
 *   - The RESERVED NAMES are a capability boundary, not a style rule.
 *     `filter.ts` decides preservation by namespace-stripping, so a caller
 *     tool named `task_add` would strip to `task_add`, match
 *     ORCHESTRATION_TOOLS, and become both auto-preserved under every mode and
 *     immune to the deny layers.
 *   - `readCallerToolsFromMetadata` REVALIDATES: `metadata` is one shared jsonb
 *     bag with several independent writers, and its value goes straight into
 *     the model's tool surface.
 */
import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_TOOL_NAMES,
  CALLER_TOOL_NAMESPACE,
  CALLER_TOOL_RESERVED_NAMES,
  CALLER_TOOL_SCOPE_KEY,
  MAX_CALLER_TOOLS,
  MAX_CALLER_TOOL_DESCRIPTION,
  MAX_CALLER_TOOL_PARAMETERS_CHARS,
  callerToolWireName,
  readCallerToolsFromMetadata,
  validateCallerToolDeclarations,
} from "../runtime/caller-tool-declarations";
import { ORCHESTRATION_TOOLS, isPreservedOrchestrationTool } from "../runtime/tools/filter";

const OK_PARAMS = {
  type: "object",
  properties: { app: { type: "string", description: "App to open" } },
  required: ["app"],
};

function decl(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "open_app", description: "Open an app", parameters: OK_PARAMS, ...overrides };
}

/**
 * A schema whose deepest CONTAINER sits exactly `levels` deep (root = 1).
 *
 * The chain alternates: root(1) → its `properties` map(2) → a property
 * schema(3) → that schema's `properties` map(4) → … so one wrap adds two
 * levels, and the parity of the target picks the innermost node — a scalar
 * leaf (odd, contributes no depth) or an empty `properties` map (even).
 */
function nested(levels: number): Record<string, unknown> {
  const even = levels % 2 === 0;
  let node: Record<string, unknown> = even
    ? { type: "object", properties: {} }
    : { type: "string" };
  for (let current = even ? 2 : 1; current < levels; current += 2) {
    node = { type: "object", properties: { child: node } };
  }
  return node;
}

// ── Accepted declarations ──────────────────────────────────────────────

describe("accepted", () => {
  test("a minimal declaration round-trips with its fields intact", () => {
    const r = validateCallerToolDeclarations([decl()]);
    expect(r).toEqual({
      ok: true,
      tools: [{ name: "open_app", description: "Open an app", parameters: OK_PARAMS }],
    });
  });

  test("an empty properties map is legal — a no-argument tool is a real tool", () => {
    const r = validateCallerToolDeclarations([
      decl({ parameters: { type: "object", properties: {} } }),
    ]);
    expect(r.ok).toBe(true);
  });

  test("an empty tools array is legal — it is how a client declares nothing", () => {
    expect(validateCallerToolDeclarations([])).toEqual({ ok: true, tools: [] });
  });

  test("timeoutMs is carried through only when supplied", () => {
    const withT = validateCallerToolDeclarations([decl({ timeoutMs: 30_000 })]);
    expect(withT.ok && withT.tools[0]).toEqual({
      name: "open_app",
      description: "Open an app",
      parameters: OK_PARAMS,
      timeoutMs: 30_000,
    });
    const without = validateCallerToolDeclarations([decl()]);
    expect(without.ok && "timeoutMs" in without.tools[0]!).toBe(false);
  });

  test("the boundary values are inside, not outside", () => {
    expect(
      validateCallerToolDeclarations(
        Array.from({ length: MAX_CALLER_TOOLS }, (_, i) => decl({ name: `tool_${i}` })),
      ).ok,
    ).toBe(true);
    expect(validateCallerToolDeclarations([decl({ timeoutMs: 5_000 })]).ok).toBe(true);
    expect(validateCallerToolDeclarations([decl({ timeoutMs: 600_000 })]).ok).toBe(true);
    expect(
      validateCallerToolDeclarations([decl({ description: "d".repeat(MAX_CALLER_TOOL_DESCRIPTION) })])
        .ok,
    ).toBe(true);
    expect(validateCallerToolDeclarations([decl({ name: "abc" })]).ok).toBe(true);
    expect(validateCallerToolDeclarations([decl({ name: `a${"b".repeat(47)}` })]).ok).toBe(true);
    expect(validateCallerToolDeclarations([decl({ parameters: nested(5) })]).ok).toBe(true);
  });
});

// ── Rejected declarations (all 400-shaped) ─────────────────────────────

const REJECTED: Array<[label: string, input: unknown, errorMatch: RegExp, field?: string]> = [
  ["tools is not an array", { tools: [] }, /must be an array/],
  ["an entry is not an object", ["open_app"], /must be an object/],
  [
    "more than the cap",
    Array.from({ length: MAX_CALLER_TOOLS + 1 }, (_, i) => decl({ name: `tool_${i}` })),
    /at most 16/,
  ],
  // Names.
  ["a double underscore", [decl({ name: "open__app" })], /double underscore/, "open__app"],
  ["a leading underscore", [decl({ name: "_open_app" })], /3–48 chars/],
  ["a leading digit", [decl({ name: "1open" })], /3–48 chars/],
  ["uppercase", [decl({ name: "openApp" })], /3–48 chars/, "openApp"],
  ["a hyphen", [decl({ name: "open-app" })], /3–48 chars/, "open-app"],
  ["too short", [decl({ name: "ab" })], /3–48 chars/, "ab"],
  ["too long", [decl({ name: `a${"b".repeat(48)}` })], /3–48 chars/],
  ["a non-string name", [decl({ name: 7 })], /3–48 chars/],
  // Reserved + built-in collisions.
  ["an orchestration tool", [decl({ name: "invoke_agent" })], /reserved/, "invoke_agent"],
  ["a task-tracking spawn tool", [decl({ name: "task_add" })], /reserved/, "task_add"],
  ["a namespaced orchestration tool, stripped", [decl({ name: "ask_user_question" })], /reserved/],
  ["a workflow starter", [decl({ name: "run_workflow" })], /reserved/],
  ["an ez-code spawn tool", [decl({ name: "dispatch_run" })], /reserved/],
  ["a project built-in", [decl({ name: "shell" })], /built-in/, "shell"],
  ["an Ez built-in", [decl({ name: "read_page" })], /built-in/, "read_page"],
  ["the same name twice", [decl(), decl()], /declared twice/, "open_app"],
  // Description.
  ["a missing description", [decl({ description: undefined })], /description is required/],
  ["an empty description", [decl({ description: "" })], /description is required/],
  ["a non-string description", [decl({ description: 3 })], /description is required/],
  [
    "an over-long description",
    [decl({ description: "d".repeat(MAX_CALLER_TOOL_DESCRIPTION + 1) })],
    /exceeds 1024/,
  ],
  // timeoutMs.
  ["a fractional timeout", [decl({ timeoutMs: 10_000.5 })], /timeoutMs must be an integer/],
  ["a timeout under the floor", [decl({ timeoutMs: 4_999 })], /timeoutMs must be an integer/],
  ["a timeout over the ceiling", [decl({ timeoutMs: 600_001 })], /timeoutMs must be an integer/],
  ["a non-numeric timeout", [decl({ timeoutMs: "60000" })], /timeoutMs must be an integer/],
  // Parameters.
  ["non-object parameters", [decl({ parameters: "nope" })], /must be an object schema/],
  ["array parameters", [decl({ parameters: [] })], /must be an object schema/],
  ["null parameters", [decl({ parameters: null })], /must be an object schema/],
  [
    "a non-object type",
    [decl({ parameters: { type: "string", properties: {} } })],
    /type must be exactly "object"/,
  ],
  [
    "a missing properties map",
    [decl({ parameters: { type: "object" } })],
    /properties must be an object/,
  ],
  [
    "an array properties map",
    [decl({ parameters: { type: "object", properties: [] } })],
    /properties must be an object/,
  ],
  [
    "a $ref",
    [decl({ parameters: { type: "object", properties: { a: { $ref: "#/$defs/X" } } } })],
    /must not use "\$ref"/,
  ],
  [
    "a $defs block",
    [decl({ parameters: { type: "object", properties: {}, $defs: { X: { type: "string" } } } })],
    /must not use "\$defs"/,
  ],
  [
    "a legacy definitions block",
    [decl({ parameters: { type: "object", properties: {}, definitions: {} } })],
    /must not use "definitions"/,
  ],
  [
    "a $schema dialect claim",
    [decl({ parameters: { type: "object", properties: {}, $schema: "https://json-schema.org/draft/2020-12/schema" } })],
    /must not use "\$schema"/,
  ],
  [
    "an $id",
    [decl({ parameters: { type: "object", properties: {}, $id: "urn:x" } })],
    /must not use "\$id"/,
  ],
  [
    "a $ref buried inside an array",
    [decl({ parameters: { type: "object", properties: {}, anyOf: [{ $ref: "#/x" }] } })],
    /must not use "\$ref"/,
  ],
  ["six levels of nesting", [decl({ parameters: nested(6) })], /nests deeper than 5/],
];

describe("rejected", () => {
  for (const [label, input, errorMatch, field] of REJECTED) {
    test(label, () => {
      const r = validateCallerToolDeclarations(input);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable — asserted above");
      expect(r.error).toMatch(errorMatch);
      if (field !== undefined) expect(r.field).toBe(field);
    });
  }

  test("65 properties across the schema", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 65; i++) properties[`p${i}`] = { type: "string" };
    const r = validateCallerToolDeclarations([decl({ parameters: { type: "object", properties } })]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable — asserted above");
    expect(r.error).toMatch(/more than 64 properties/);
    // 64 is inside the line.
    delete properties.p64;
    expect(
      validateCallerToolDeclarations([decl({ parameters: { type: "object", properties } })]).ok,
    ).toBe(true);
  });

  test("the property budget is counted across NESTED schemas, not per level", () => {
    // 40 + 40 split over two levels is still 80, and a per-level count would
    // wave it through.
    const inner: Record<string, unknown> = {};
    const outer: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) inner[`i${i}`] = { type: "string" };
    for (let i = 0; i < 40; i++) outer[`o${i}`] = { type: "string" };
    outer.nested = { type: "object", properties: inner };
    const r = validateCallerToolDeclarations([
      decl({ parameters: { type: "object", properties: outer } }),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable — asserted above");
    expect(r.error).toMatch(/more than 64 properties/);
  });

  test("one byte over the serialized ceiling", () => {
    // Pad a description until the schema is exactly one char too long.
    const build = (padding: number) => ({
      type: "object",
      properties: { app: { type: "string", description: "x".repeat(padding) } },
    });
    let padding = MAX_CALLER_TOOL_PARAMETERS_CHARS;
    while (JSON.stringify(build(padding)).length > MAX_CALLER_TOOL_PARAMETERS_CHARS) padding--;
    const atCap = build(padding);
    expect(JSON.stringify(atCap).length).toBe(MAX_CALLER_TOOL_PARAMETERS_CHARS);
    expect(validateCallerToolDeclarations([decl({ parameters: atCap })]).ok).toBe(true);

    const overCap = build(padding + 1);
    expect(JSON.stringify(overCap).length).toBe(MAX_CALLER_TOOL_PARAMETERS_CHARS + 1);
    const r = validateCallerToolDeclarations([decl({ parameters: overCap })]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable — asserted above");
    expect(r.error).toMatch(/exceeds 8192 characters/);
    expect(r.field).toBe("open_app");
  });

  test("the first problem is reported, and nothing partial is accepted", () => {
    const r = validateCallerToolDeclarations([decl({ name: "good_one" }), decl({ name: "task_add" })]);
    expect(r).toEqual({
      ok: false,
      error: '"task_add" is a reserved tool name',
      field: "task_add",
    });
  });
});

// ── The reserved set, and why it holds ─────────────────────────────────

describe("the reserved set", () => {
  test("covers every orchestration tool in both its bare and namespaced forms", () => {
    for (const name of ORCHESTRATION_TOOLS) {
      expect(CALLER_TOOL_RESERVED_NAMES.has(name)).toBe(true);
      const bare = name.includes("__") ? name.slice(name.indexOf("__") + 2) : name;
      expect(CALLER_TOOL_RESERVED_NAMES.has(bare)).toBe(true);
    }
  });

  test("covers the four spawn primitives outside that set", () => {
    for (const name of ["run_workflow", "task_add", "task_resume", "dispatch_run"]) {
      expect(CALLER_TOOL_RESERVED_NAMES.has(name)).toBe(true);
    }
  });

  test("THE reason it exists: a reserved name would win the preservation carve-out", () => {
    // This is the defect the set prevents, demonstrated rather than asserted.
    // `_caller__task_add` strips to `task_add`, which the filter treats as an
    // always-preserved orchestration tool — so the caller would have earned
    // immunity from every mode restriction by choosing a name.
    expect(isPreservedOrchestrationTool(callerToolWireName("task_plan"))).toBe(true);
    // …and an accepted name never does.
    expect(isPreservedOrchestrationTool(callerToolWireName("open_app"))).toBe(false);
  });
});

describe("the built-in name list cannot rot", () => {
  test("it is exactly the names the two host factories produce", async () => {
    // Stated as data in the leaf module so a web route need not import the
    // shell sandbox and the drafts tables to validate a declaration — but
    // checked here against the real thing, because a hand list that nothing
    // compares is a hand list that goes stale.
    const { getBuiltinToolDefs } = await import("../runtime/tools");
    const { getEzToolDefs } = await import("../runtime/tools/ez");
    const actual = [
      ...getBuiltinToolDefs("/tmp").map((d) => d.name),
      ...getEzToolDefs({ userId: "u", conversationId: "c" }).map((d) => d.name),
    ].sort();
    expect([...BUILT_IN_TOOL_NAMES].sort()).toEqual(actual);
  });
});

// ── Reading declarations back off a conversation ───────────────────────

describe("readCallerToolsFromMetadata", () => {
  test("returns the declarations a well-formed bag holds", () => {
    expect(readCallerToolsFromMetadata({ callerTools: [decl()] })).toEqual([
      { name: "open_app", description: "Open an app", parameters: OK_PARAMS },
    ]);
  });

  test("yields nothing for a bag without the key, or no bag at all", () => {
    expect(readCallerToolsFromMetadata({ goal: { condition: "x" } })).toEqual([]);
    expect(readCallerToolsFromMetadata(null)).toEqual([]);
    expect(readCallerToolsFromMetadata(undefined)).toEqual([]);
    expect(readCallerToolsFromMetadata("not a bag")).toEqual([]);
    expect(readCallerToolsFromMetadata([])).toEqual([]);
  });

  test("FAILS CLOSED on a bag that disagrees with the rules", () => {
    // A hand-edited row, a partial write, a future writer that skipped the
    // validator: whatever the cause, the model gets no caller tools rather
    // than a schema the provider will reject for the rest of the turn.
    expect(readCallerToolsFromMetadata({ callerTools: [decl({ name: "invoke_agent" })] })).toEqual([]);
    expect(readCallerToolsFromMetadata({ callerTools: "nope" })).toEqual([]);
    expect(
      readCallerToolsFromMetadata({ callerTools: [decl(), decl({ parameters: { type: "array" } })] }),
    ).toEqual([]);
  });
});

describe("the wire name", () => {
  test("is the namespace plus the declared name", () => {
    expect(CALLER_TOOL_NAMESPACE).toBe("_caller__");
    expect(callerToolWireName("open_app")).toBe("_caller__open_app");
  });

  test("the scope key is the one literal shared by category, toggle and listing", () => {
    expect(CALLER_TOOL_SCOPE_KEY).toBe("caller");
  });
});
