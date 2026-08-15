/**
 * Declaration validation for caller-executed tools.
 *
 * Every rule here exists because the failure it prevents is INVISIBLE at the
 * point it is made. `BuiltinToolDef.parameters` is `Type.Unsafe(...)`, so
 * TypeBox validates nothing on the way to the provider, and pi-agent-core
 * does not validate tool arguments at runtime either — a malformed schema is
 * accepted silently and then 400s the conversation's NEXT turn, and every
 * turn after that, from the provider. The declaration call is the last moment
 * the caller can be told which of its own fields is wrong.
 */
import { test, expect, describe } from "bun:test";
import {
  CALLER_TOOL_NAMESPACE,
  CALLER_TOOL_RESERVED_NAMES,
  MAX_CALLER_TOOLS,
  MAX_CALLER_TOOL_PARAMETERS_CHARS,
  MAX_CALLER_TOOL_PARAMETER_DEPTH,
  MAX_CALLER_TOOL_PROPERTIES,
  readCallerToolsFromMetadata,
  validateCallerToolDeclarations,
} from "../runtime/caller-tool-declarations";
import { ORCHESTRATION_TOOLS } from "../runtime/tools/filter";
import { getBuiltInToolMetadata } from "../runtime/tools/builtin-registry";

const OBJ = { type: "object", properties: { a: { type: "string" } } };
const tool = (over: Record<string, unknown> = {}) => ({
  name: "open_app",
  description: "Open an app",
  parameters: OBJ,
  ...over,
});

function reject(tools: unknown): { error: string; field?: string } {
  const res = validateCallerToolDeclarations(tools);
  if (res.ok) throw new Error(`expected a rejection, got ${JSON.stringify(res.tools)}`);
  return { error: res.error, field: res.field };
}

function accept(tools: unknown) {
  const res = validateCallerToolDeclarations(tools);
  if (!res.ok) throw new Error(`expected acceptance, got ${res.error} (${res.field})`);
  return res.tools;
}

describe("the reserved set", () => {
  test("covers every orchestration tool by its BARE name", () => {
    // `_caller__<name>` strips to `<name>`, and the orchestration set lists
    // some entries namespaced (`ask-user__ask_user_question`). Comparing the
    // raw set would let `_caller__ask_user_question` through.
    for (const orch of ORCHESTRATION_TOOLS) {
      const bare = orch.includes("__") ? orch.slice(orch.indexOf("__") + 2) : orch;
      expect(CALLER_TOOL_RESERVED_NAMES.has(bare)).toBe(true);
    }
  });

  test("covers the spawn primitives that are namespaced at runtime", () => {
    for (const name of ["run_workflow", "task_add", "task_resume", "dispatch_run"]) {
      expect(CALLER_TOOL_RESERVED_NAMES.has(name)).toBe(true);
    }
  });

  test("the namespace is the one the filter strips on", () => {
    expect(CALLER_TOOL_NAMESPACE).toBe("_caller__");
  });
});

describe("validateCallerToolDeclarations — the array itself", () => {
  test("a non-array is refused", () => {
    expect(reject(null).error).toBe("tools must be an array");
    expect(reject({ tools: [] }).error).toBe("tools must be an array");
  });

  test("an empty array is valid — declaring nothing is a legitimate state", () => {
    expect(accept([])).toEqual([]);
  });

  test(`more than ${MAX_CALLER_TOOLS} tools is refused`, () => {
    const many = Array.from({ length: MAX_CALLER_TOOLS + 1 }, (_, i) => tool({ name: `tool_${i}` }));
    expect(reject(many).error).toContain(String(MAX_CALLER_TOOLS));
    expect(accept(many.slice(0, MAX_CALLER_TOOLS))).toHaveLength(MAX_CALLER_TOOLS);
  });

  test("a non-object entry is refused", () => {
    expect(reject(["open_app"]).error).toBe("each tool must be an object");
    expect(reject([[tool()]]).error).toBe("each tool must be an object");
  });
});

describe("validateCallerToolDeclarations — names", () => {
  test.each([
    ["abc", true],
    ["open_app", true],
    ["a_b_c_9", true],
    [`a${"b".repeat(47)}`, true],
    ["ab", false],
    [`a${"b".repeat(48)}`, false],
    ["Open_app", false],
    ["1open", false],
    ["_open", false],
    ["open-app", false],
    ["open__app", false],
    ["__open", false],
  ])("%s → %s", (name, ok) => {
    const res = validateCallerToolDeclarations([tool({ name })]);
    expect(res.ok).toBe(ok);
  });

  test("a non-string name is refused without throwing", () => {
    expect(reject([tool({ name: 42 })])).toEqual({ error: "invalid tool name", field: "42" });
  });

  test("a duplicate name is refused — the map would silently keep one", () => {
    expect(reject([tool(), tool()])).toEqual({ error: "duplicate tool name", field: "open_app" });
  });

  test("a reserved name is refused and named", () => {
    expect(reject([tool({ name: "invoke_agent" })])).toEqual({
      error: "tool name is reserved",
      field: "invoke_agent",
    });
    expect(reject([tool({ name: "dispatch_run" })]).error).toBe("tool name is reserved");
  });

  test("a built-in tool's name is refused", () => {
    const builtIn = getBuiltInToolMetadata()[0];
    // The built-in registry is the ez concierge tools; if it ever empties,
    // this assertion must not silently pass on nothing.
    expect(typeof builtIn?.name).toBe("string");
    expect(reject([tool({ name: builtIn.name })])).toEqual({
      error: "tool name collides with a built-in tool",
      field: builtIn.name,
    });
  });
});

describe("validateCallerToolDeclarations — description", () => {
  test("a missing or empty description is refused", () => {
    expect(reject([tool({ description: "" })]).error).toBe("description is required");
    expect(reject([tool({ description: undefined })]).error).toBe("description is required");
    expect(reject([tool({ description: 7 })]).field).toBe("open_app");
  });
});

describe("validateCallerToolDeclarations — the parameters schema", () => {
  test("must be an object schema of type 'object'", () => {
    expect(reject([tool({ parameters: "nope" })]).error).toBe("parameters must be an object schema");
    expect(reject([tool({ parameters: [] })]).error).toBe("parameters must be an object schema");
    expect(reject([tool({ parameters: { type: "string" } })]).error).toBe(
      'parameters.type must be "object"',
    );
  });

  test("`properties` may be absent or empty, but must be an object when present", () => {
    expect(accept([tool({ parameters: { type: "object" } })])).toHaveLength(1);
    expect(accept([tool({ parameters: { type: "object", properties: {} } })])).toHaveLength(1);
    expect(reject([tool({ parameters: { type: "object", properties: [] } })]).error).toBe(
      "parameters.properties must be an object",
    );
  });

  test.each(["$ref", "$defs", "definitions", "$schema", "$id"])(
    "%s is refused anywhere in the tree",
    (keyword) => {
      const top = { type: "object", [keyword]: "x" };
      expect(reject([tool({ parameters: top })]).error).toBe(`parameters may not use ${keyword}`);
      const nested = {
        type: "object",
        properties: { a: { type: "object", properties: { b: { [keyword]: "x" } } } },
      };
      expect(reject([tool({ parameters: nested })]).error).toBe(
        `parameters may not use ${keyword}`,
      );
    },
  );

  test("a forbidden keyword hiding inside an ARRAY member is still caught", () => {
    const params = { type: "object", anyOf: [{ type: "object" }, { $ref: "#/x" }] };
    expect(reject([tool({ parameters: params })]).error).toBe("parameters may not use $ref");
  });

  test("clean arrays pass — `required` and `anyOf` are ordinary JSON Schema", () => {
    const params = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      anyOf: [{ type: "object" }, { type: "object", properties: { b: { type: "number" } } }],
    };
    expect(accept([tool({ parameters: params })])).toHaveLength(1);
  });

  test(`nesting is counted as an author would read it, and stops at ${MAX_CALLER_TOOL_PARAMETER_DEPTH}`, () => {
    // One `properties` hop = ONE level: a `properties` map is a container,
    // not a schema. Charging two would reject plainly-shallow schemas.
    const nest = (levels: number) => {
      let node: Record<string, unknown> = { type: "object" };
      for (let i = 1; i < levels; i++) node = { type: "object", properties: { a: node } };
      return node;
    };
    expect(accept([tool({ parameters: nest(MAX_CALLER_TOOL_PARAMETER_DEPTH) })])).toHaveLength(1);
    expect(reject([tool({ parameters: nest(MAX_CALLER_TOOL_PARAMETER_DEPTH + 1) })]).error).toContain(
      String(MAX_CALLER_TOOL_PARAMETER_DEPTH),
    );
  });

  test(`more than ${MAX_CALLER_TOOL_PROPERTIES} properties in total is refused`, () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_CALLER_TOOL_PROPERTIES; i++) props[`p${i}`] = { type: "string" };
    expect(reject([tool({ parameters: { type: "object", properties: props } })]).error).toContain(
      String(MAX_CALLER_TOOL_PROPERTIES),
    );
  });

  test("the property budget is counted RECURSIVELY, not per level", () => {
    const half = (n: number) => {
      const p: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) p[`p${i}`] = { type: "string" };
      return { type: "object", properties: p };
    };
    // 40 + 40 = 80 > 64, though neither level exceeds the budget alone.
    const params = { type: "object", properties: { a: half(40), ...half(40).properties } };
    expect(reject([tool({ parameters: params })]).error).toContain(
      String(MAX_CALLER_TOOL_PROPERTIES),
    );
  });

  test(`a schema over ${MAX_CALLER_TOOL_PARAMETERS_CHARS} bytes is refused`, () => {
    const params = { type: "object", description: "x".repeat(MAX_CALLER_TOOL_PARAMETERS_CHARS) };
    expect(reject([tool({ parameters: params })]).error).toContain(String(MAX_CALLER_TOOL_PARAMETERS_CHARS));
  });

  test("a null subschema is walked without throwing", () => {
    expect(accept([tool({ parameters: { type: "object", properties: { a: null } } })])).toHaveLength(1);
  });
});

describe("validateCallerToolDeclarations — what comes back", () => {
  test("only the four known fields survive, and timeoutMs only when numeric", () => {
    expect(accept([tool({ timeoutMs: 30_000 })])[0]).toEqual({
      name: "open_app",
      description: "Open an app",
      parameters: OBJ,
      timeoutMs: 30_000,
    });
    expect(accept([tool()])[0]).toEqual({
      name: "open_app",
      description: "Open an app",
      parameters: OBJ,
    });
    // A non-numeric timeoutMs is dropped rather than persisted as garbage the
    // runtime would have to re-check at wire time.
    expect(accept([tool({ timeoutMs: "30s" })])[0]!.timeoutMs).toBeUndefined();
  });
});

describe("readCallerToolsFromMetadata", () => {
  test("reads the declarations back out of a metadata bag", () => {
    expect(readCallerToolsFromMetadata({ callerTools: [tool()], goal: "x" })).toEqual([
      { name: "open_app", description: "Open an app", parameters: OBJ },
    ]);
  });

  test("absent, null, non-object and malformed all read as none", () => {
    // Tolerant on purpose: this runs during turn setup, which has no channel
    // to report an error on, and metadata is a bag with several owners.
    expect(readCallerToolsFromMetadata(null)).toEqual([]);
    expect(readCallerToolsFromMetadata(undefined)).toEqual([]);
    expect(readCallerToolsFromMetadata("not-an-object")).toEqual([]);
    expect(readCallerToolsFromMetadata([])).toEqual([]);
    expect(readCallerToolsFromMetadata({ goal: "x" })).toEqual([]);
    expect(readCallerToolsFromMetadata({ callerTools: "corrupt" })).toEqual([]);
    expect(readCallerToolsFromMetadata({ callerTools: [{ name: "BAD NAME" }] })).toEqual([]);
  });
});
