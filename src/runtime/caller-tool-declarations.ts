/**
 * Caller-executed tool DECLARATIONS: the shape an external application may
 * put on a conversation, and the rules it must satisfy.
 *
 * WHY VALIDATION IS NOT OPTIONAL. `BuiltinToolDef.parameters` is a
 * `Type.Unsafe(...)` — TypeBox checks nothing — and pi-agent-core does not
 * validate tool arguments at runtime either. So a malformed JSON Schema does
 * not fail here: it reaches the provider, which 400s the whole request, and
 * keeps 400-ing every subsequent turn of that conversation. The declaring
 * client is the only place the shape can be caught, and it has to be caught
 * on the way IN.
 *
 * Every rejection is 400-shaped — a declaration is data the caller controls,
 * so a bad one is a client error, never a server fault.
 *
 * Deliberately dependency-light: the declare route and the per-turn wire both
 * import this, and the reserved-name set is a plain data structure the
 * per-API-key policy addendum unions into rather than re-edits.
 */

import { ORCHESTRATION_TOOLS, stripToolNamespace } from "./tools/filter";

/** Wire prefix every caller tool is registered under. `manifest.ts` forbids
 *  an extension name starting with `_`, so no extension can ever produce a
 *  colliding namespace — which is why there is no registry-collision leg. */
export const CALLER_TOOL_NAMESPACE = "_caller__";

/** A single declared tool, after validation. */
export type CallerToolDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
};

/** Most tools a conversation may declare. */
export const MAX_CALLER_TOOLS = 16;
/** Longest a declaration's description may be. */
export const MAX_CALLER_TOOL_DESCRIPTION = 1024;
/** Serialized ceiling on one `parameters` schema, in UTF-16 code units. */
export const MAX_CALLER_TOOL_PARAMETERS_CHARS = 8_192;
/**
 * Deepest nesting allowed inside `parameters`, COUNTED THE WAY AN AUTHOR
 * READS IT: one level per schema, root = 1.
 *
 * `{type:"object", properties:{a:{type:"string"}}}` is 2, not 3 — a
 * `properties` / `patternProperties` map is a container the JSON Schema
 * grammar requires, not a level of the author's data, so it is walked
 * through rather than charged for. A naive value-walk charges two levels per
 * hop, which puts an ordinary two-deep argument object at 4 and then refuses
 * it the moment any member carries an `enum` or `anyOf`. Arrays DO count, so
 * no construct can nest without bound.
 */
export const MAX_CALLER_TOOL_PARAMETER_DEPTH = 5;
/** Most named properties allowed across the whole schema, all levels. */
export const MAX_CALLER_TOOL_PROPERTIES = 64;
/** Per-call wait bounds a declaration may ask for. */
export const MIN_CALLER_TOOL_TIMEOUT_MS = 5_000;
export const MAX_CALLER_TOOL_TIMEOUT_MS = 600_000;
export const DEFAULT_CALLER_TOOL_TIMEOUT_MS = 120_000;

/**
 * Names a caller tool may NOT take.
 *
 * The threat is not confusion, it is CAPABILITY. `filter.ts` decides what a
 * restrictive mode preserves by namespace-stripping the runtime tool name, so
 * a caller tool named `task_add` would be wired as `_caller__task_add`, strip
 * to `task_add`, match {@link ORCHESTRATION_TOOLS}, and thereby become both
 * auto-preserved under every mode AND immune to the deny layers — the exact
 * privileges the orchestration carve-out exists to grant real orchestration
 * tools. The extra four are spawn primitives that are not in that set but do
 * start agents or workflows.
 *
 * Built from spreads on purpose: this is the seed, and the per-API-key policy
 * addendum unions its own leaf-spawn deny set in as one more line rather than
 * re-editing a hand list. Keep it that way.
 */
export const CALLER_TOOL_RESERVED_NAMES: ReadonlySet<string> = new Set<string>([
  ...ORCHESTRATION_TOOLS,
  // ORCHESTRATION_TOOLS lists some members already namespaced
  // (`ask-user__ask_user_question`); the stripped form is what a caller name
  // would actually collide with.
  ...[...ORCHESTRATION_TOOLS].map(stripToolNamespace),
  "run_workflow",
  "task_add",
  "task_resume",
  "dispatch_run",
]);

/**
 * Names of the tools this server wires itself.
 *
 * Stated as data rather than derived from `getBuiltinToolDefs()` /
 * `getEzToolDefs()` so that declaring a tool costs a web route no more than
 * this leaf module — those factories reach the shell sandbox, the preview
 * orchestrator and the drafts tables. It cannot rot silently:
 * `caller-tool-declarations.test.ts` asserts this set equals the names those
 * two factories actually produce.
 */
export const BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  // Project file tools (`runtime/tools/index.ts`). Four are camelCase and so
  // could never satisfy the name rule below anyway; they are listed because
  // "the built-ins" is the claim being made, not "the built-ins that happen
  // to be spellable".
  "readFile",
  "listFiles",
  "readDirectory",
  "editFile",
  "shell",
  "grep",
  "glob",
  // Ez concierge tools (`runtime/tools/ez/index.ts`)
  "propose_create_project",
  "propose_create_agent",
  "propose_install_extension",
  "summarize_conversation",
  "search_conversation",
  "find_agents",
  "fill_form",
  "navigate_to",
  "read_page",
]);

/**
 * Legal declaration name: lowercase, 3–48 chars, starts with a letter, no
 * consecutive underscores.
 *
 * The `__` ban is structural, not cosmetic — `__` is the namespace separator
 * the whole tools layer splits on, so a name containing it would strip to
 * something other than itself and slip past every set membership test that
 * matters (preservation, force-deny, the reserved check below).
 */
const CALLER_TOOL_NAME_RE = /^[a-z](?!.*__)[a-z0-9_]{2,47}$/;

/** JSON Schema keywords a declaration may not use anywhere in `parameters`.
 *  Each either points outside the document (`$ref`, `$id`), or defines a
 *  target for something that does (`$defs`, `definitions`), or asserts a
 *  dialect we do not resolve (`$schema`). None can be honoured here, and a
 *  schema whose meaning depends on one is a schema we would be guessing at. */
const FORBIDDEN_SCHEMA_KEYS = ["$ref", "$defs", "definitions", "$schema", "$id"] as const;

/** Keys whose value is a MAP OF SCHEMAS rather than a schema — walked through
 *  for depth (see {@link MAX_CALLER_TOOL_PARAMETER_DEPTH}) and counted for the
 *  property budget. */
const PROPERTY_MAP_KEYS = new Set(["properties", "patternProperties"]);

/** Failure shape. `field` names the offending declaration when one entry is
 *  at fault, so the client can point at the tool it got wrong. */
export type CallerToolValidationResult =
  | { ok: true; tools: CallerToolDeclaration[] }
  | { ok: false; error: string; field?: string };

function fail(error: string, field?: string): CallerToolValidationResult {
  return field === undefined ? { ok: false, error } : { ok: false, error, field };
}

/** A JSON object, as opposed to an array or null (both `typeof "object"`). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface SchemaScan {
  /** Deepest nesting reached, per {@link MAX_CALLER_TOOL_PARAMETER_DEPTH}:
   *  schemas and arrays count, `properties` maps and scalar leaves do not. */
  depth: number;
  /** Named properties across every `properties` map in the tree. */
  properties: number;
  /** First forbidden keyword encountered, if any. */
  forbidden?: string;
}

/**
 * Walk the whole schema once, collecting every structural fact the rules
 * below need. One traversal rather than three: the three limits are all
 * about the same tree, and three walks would be three chances for one of
 * them to disagree about what "inside `parameters`" means.
 */
function scanSchema(node: unknown, depth: number, acc: SchemaScan): void {
  if (Array.isArray(node)) {
    if (depth > acc.depth) acc.depth = depth;
    for (const item of node) scanSchema(item, depth + 1, acc);
    return;
  }
  // Scalars contribute no depth: a string leaf must not make an otherwise
  // flat schema read one level deeper than the author wrote it.
  if (!isPlainObject(node)) return;
  if (depth > acc.depth) acc.depth = depth;
  for (const key of Object.keys(node)) {
    if (acc.forbidden === undefined && (FORBIDDEN_SCHEMA_KEYS as readonly string[]).includes(key)) {
      acc.forbidden = key;
    }
  }
  for (const [key, value] of Object.entries(node)) {
    // A `properties` / `patternProperties` map is grammar, not a level the
    // author wrote — walk THROUGH it to its members at the same depth its
    // owning schema would have charged them. Its member count is the other
    // budget, and it is counted here because this is where the map is known
    // to be one.
    if (PROPERTY_MAP_KEYS.has(key) && isPlainObject(value)) {
      acc.properties += Object.keys(value).length;
      for (const member of Object.values(value)) scanSchema(member, depth + 1, acc);
      continue;
    }
    scanSchema(value, depth + 1, acc);
  }
}

/** Validate one declaration's `parameters`, or describe why it is refused. */
function validateParameters(parameters: unknown, name: string): string | undefined {
  if (!isPlainObject(parameters)) return `${name}.parameters must be an object schema`;
  if (parameters.type !== "object") {
    return `${name}.parameters.type must be exactly "object"`;
  }
  // ABSENT `properties` is accepted and means the same as `{}`. A
  // zero-argument tool (`capture_screen`) is spelled `{type:"object"}` in
  // ordinary JSON Schema, and the provider accepts it; demanding an explicit
  // empty map would 400 a correct declaration for no security gain, since an
  // absent map constrains nothing exactly as an empty one does. Present-but-
  // not-an-object is still refused — that is a malformed schema, not a terse one.
  if (parameters.properties !== undefined && !isPlainObject(parameters.properties)) {
    return `${name}.parameters.properties must be an object (it may be empty)`;
  }
  // Cheapest ceiling first: a schema over the byte cap need not be walked.
  if (JSON.stringify(parameters).length > MAX_CALLER_TOOL_PARAMETERS_CHARS) {
    return `${name}.parameters exceeds ${MAX_CALLER_TOOL_PARAMETERS_CHARS} characters`;
  }
  const scan: SchemaScan = { depth: 0, properties: 0 };
  scanSchema(parameters, 1, scan);
  if (scan.forbidden !== undefined) {
    return `${name}.parameters must not use "${scan.forbidden}"`;
  }
  if (scan.depth > MAX_CALLER_TOOL_PARAMETER_DEPTH) {
    return `${name}.parameters nests deeper than ${MAX_CALLER_TOOL_PARAMETER_DEPTH} levels`;
  }
  if (scan.properties > MAX_CALLER_TOOL_PROPERTIES) {
    return `${name}.parameters declares more than ${MAX_CALLER_TOOL_PROPERTIES} properties`;
  }
  return undefined;
}

/**
 * Validate a whole `tools` array as submitted by a declaring client.
 *
 * Returns the accepted declarations on success. On failure returns the FIRST
 * problem found rather than a list — the client is a program, it will fix one
 * and resubmit, and a partial accept would leave the conversation in a state
 * neither side asked for.
 */
export function validateCallerToolDeclarations(
  tools: unknown,
): CallerToolValidationResult {
  if (!Array.isArray(tools)) return fail("tools must be an array");
  if (tools.length > MAX_CALLER_TOOLS) {
    return fail(`at most ${MAX_CALLER_TOOLS} caller tools may be declared`);
  }

  const accepted: CallerToolDeclaration[] = [];
  const seen = new Set<string>();
  for (const entry of tools) {
    if (!isPlainObject(entry)) return fail("each tool must be an object");

    const { name, description, parameters, timeoutMs } = entry;
    if (typeof name !== "string" || !CALLER_TOOL_NAME_RE.test(name)) {
      return fail(
        "name must be 3–48 chars, lowercase letters/digits/underscores, " +
          "start with a letter, and contain no double underscore",
        typeof name === "string" ? name : undefined,
      );
    }
    // Computed through the same strip the filter layer uses, so the check
    // stays correct if the namespace itself is ever changed.
    if (CALLER_TOOL_RESERVED_NAMES.has(stripToolNamespace(CALLER_TOOL_NAMESPACE + name))) {
      return fail(`"${name}" is a reserved tool name`, name);
    }
    if (BUILT_IN_TOOL_NAMES.has(name)) {
      return fail(`"${name}" collides with a built-in tool`, name);
    }
    if (seen.has(name)) return fail(`"${name}" is declared twice`, name);
    seen.add(name);

    if (typeof description !== "string" || description.length === 0) {
      return fail("description is required", name);
    }
    if (description.length > MAX_CALLER_TOOL_DESCRIPTION) {
      return fail(
        `description exceeds ${MAX_CALLER_TOOL_DESCRIPTION} characters`,
        name,
      );
    }

    if (timeoutMs !== undefined) {
      if (
        typeof timeoutMs !== "number" ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < MIN_CALLER_TOOL_TIMEOUT_MS ||
        timeoutMs > MAX_CALLER_TOOL_TIMEOUT_MS
      ) {
        return fail(
          `timeoutMs must be an integer between ${MIN_CALLER_TOOL_TIMEOUT_MS} and ` +
            `${MAX_CALLER_TOOL_TIMEOUT_MS}`,
          name,
        );
      }
    }

    const paramError = validateParameters(parameters, name);
    if (paramError !== undefined) return fail(paramError, name);

    accepted.push({
      name,
      description,
      parameters: parameters as Record<string, unknown>,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }
  return { ok: true, tools: accepted };
}

/**
 * Read the declarations off a conversation's `metadata` bag.
 *
 * REVALIDATES rather than trusting the row. The declarations were validated
 * when written, but `metadata` is one shared jsonb column with several
 * independent writers, and this value goes straight into the tool surface the
 * model is handed — so the read side does its own check and yields NOTHING
 * when the bag disagrees with the rules. Fail-closed: a conversation with a
 * damaged declaration loses its caller tools for the turn; it does not get a
 * schema the provider will reject.
 */
export function readCallerToolsFromMetadata(metadata: unknown): CallerToolDeclaration[] {
  if (!isPlainObject(metadata)) return [];
  const declared = metadata.callerTools;
  if (declared === undefined) return [];
  const result = validateCallerToolDeclarations(declared);
  return result.ok ? result.tools : [];
}

/** The runtime tool name a declaration is wired under. */
export function callerToolWireName(name: string): string {
  return CALLER_TOOL_NAMESPACE + name;
}

/**
 * Key the caller tools appear under in a conversation's `extensionTools`
 * toggle map, in the `/api/tools` listing's `extension` field, and as the
 * `ToolCategory`. One literal for all three so the composer's Tools dropdown
 * can toggle them through the unmodified per-extension path.
 *
 * A real extension cannot collide: registry and toggle keys are extension
 * UUIDs, never names.
 */
export const CALLER_TOOL_SCOPE_KEY = "caller";
