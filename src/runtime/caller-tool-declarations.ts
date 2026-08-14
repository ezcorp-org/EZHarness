/**
 * Caller-executed tool DECLARATIONS — the shared contract between the HTTP
 * boundary (`web/src/routes/api/conversations/[id]/caller-tools`) and the
 * runtime that wires them into a turn.
 *
 * ── WHY VALIDATION LIVES HERE AND NOT IN THE ZOD SCHEMA ─────────────────
 *
 * `BuiltinToolDef.parameters` is `Type.Unsafe(...)`, so TypeBox validates
 * NOTHING on the way to the provider, and pi-agent-core does not validate
 * tool arguments at runtime either. A malformed JSON Schema therefore does
 * not fail at the point it was written — it fails on the provider's next
 * request, and then on every subsequent turn of that conversation, as an
 * opaque 400. The declaration is the last place the caller can be told
 * which of ITS fields is wrong, so this is where the structural rules are
 * enforced, and it is deliberately reachable from anything that reads
 * declarations back out of `conversations.metadata` rather than only from
 * the route.
 */
import { ORCHESTRATION_TOOLS } from "./tools/filter";
import { getBuiltInToolMetadata } from "./tools/builtin-registry";

/** Prefix under which a declared tool is wired: `_caller__<name>`. */
export const CALLER_TOOL_NAMESPACE = "_caller__";

/** Applied when a declaration omits `timeoutMs`. */
export const CALLER_TOOL_DEFAULT_TIMEOUT_MS = 120_000;

/** Per-conversation declaration ceiling. */
export const MAX_CALLER_TOOLS = 16;

/** `JSON.stringify(parameters)` byte ceiling. */
export const MAX_PARAMETERS_BYTES = 8_192;

/** Deepest nesting `parameters` may reach. */
export const MAX_PARAMETERS_DEPTH = 5;

/** Total `properties` entries allowed across the whole schema. */
export const MAX_PARAMETERS_PROPERTIES = 64;

/** Mirrors the HTTP schema. See that file's header for the `__` ban. */
const CALLER_TOOL_NAME_RE = /^[a-z](?!.*__)[a-z0-9_]{2,47}$/;

/** JSON-Schema keywords a declaration may not use: each one either points
 *  outside the document (`$ref`, `$schema`, `$id`) or defines a subschema
 *  the depth/property walk cannot see through (`$defs`, `definitions`). */
const FORBIDDEN_SCHEMA_KEYWORDS = ["$ref", "$defs", "definitions", "$schema", "$id"] as const;

function stripNamespace(name: string): string {
  const i = name.indexOf("__");
  return i === -1 ? name : name.slice(i + 2);
}

/**
 * Names a declaration may not take, because `_caller__<name>` strips to the
 * same bare name a spawn/orchestration primitive is matched on — a caller
 * tool called `invoke_agent` would answer a namespace-stripping deny rule
 * meant for the real one, in either direction.
 *
 * EXPORTED AND EXTENSIBLE ON PURPOSE: the per-API-key tool policy unions its
 * own spawn set into this one, and that must be an import rather than an
 * edit of this file, so no declaration silently changes meaning between the
 * two changes.
 */
export const CALLER_TOOL_RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...[...ORCHESTRATION_TOOLS].map(stripNamespace),
  "run_workflow",
  "task_add",
  "task_resume",
  "dispatch_run",
]);

export interface CallerToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
}

export type CallerToolValidation =
  | { ok: true; tools: CallerToolDeclaration[] }
  | { ok: false; error: string; field?: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keywords whose value is a MAP of subschemas keyed by property name, not a
 *  subschema itself. Descending through one costs a single nesting level. */
const SUBSCHEMA_MAPS = ["properties", "patternProperties"];

/**
 * Walk the schema counting `properties` entries and nesting depth, refusing
 * the forbidden keywords anywhere in the tree. Returns an error string or
 * null.
 *
 * `depth` counts SCHEMA levels the way an author would: the root is 1, a
 * property's subschema is 2, its own property's subschema is 3. Two
 * corrections to a naive value-walk make that true, and both matter because
 * getting them wrong rejects ordinary schemas.
 *
 *   - A `properties` map is a container, not a level. Walking `{properties:
 *     {a: {...}}}` value-by-value would charge two levels to reach `a`, so a
 *     plainly two-deep schema would read as four.
 *   - An array (`anyOf`, `required`, `enum`) is likewise a container, so its
 *     members are scanned at the SAME depth as the array itself.
 *
 * The depth guard sits AFTER the scalar early-return so a `"type": "object"`
 * string at the boundary is not itself reported as too deep.
 */
function scanSchema(node: unknown, depth: number, counter: { n: number }): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const err = scanSchema(item, depth, counter);
      if (err) return err;
    }
    return null;
  }
  if (!isPlainObject(node)) return null;
  if (depth > MAX_PARAMETERS_DEPTH) return `parameters nests deeper than ${MAX_PARAMETERS_DEPTH}`;
  for (const keyword of FORBIDDEN_SCHEMA_KEYWORDS) {
    if (keyword in node) return `parameters may not use ${keyword}`;
  }
  const props = node.properties;
  if (isPlainObject(props)) {
    counter.n += Object.keys(props).length;
    if (counter.n > MAX_PARAMETERS_PROPERTIES) {
      return `parameters declares more than ${MAX_PARAMETERS_PROPERTIES} properties`;
    }
  }
  for (const [key, value] of Object.entries(node)) {
    const members = SUBSCHEMA_MAPS.includes(key) && isPlainObject(value)
      ? Object.values(value)
      : [value];
    for (const member of members) {
      const err = scanSchema(member, depth + 1, counter);
      if (err) return err;
    }
  }
  return null;
}

function validateParameters(parameters: unknown): string | null {
  if (!isPlainObject(parameters)) return "parameters must be an object schema";
  if (parameters.type !== "object") return 'parameters.type must be "object"';
  if ("properties" in parameters && !isPlainObject(parameters.properties)) {
    return "parameters.properties must be an object";
  }
  if (JSON.stringify(parameters).length > MAX_PARAMETERS_BYTES) {
    return `parameters exceeds ${MAX_PARAMETERS_BYTES} bytes`;
  }
  return scanSchema(parameters, 1, { n: 0 });
}

/**
 * Validate a caller's declaration array. Every rejection names the offending
 * tool in `field` so an app can point at its own definition rather than
 * bisecting the batch.
 */
export function validateCallerToolDeclarations(tools: unknown): CallerToolValidation {
  if (!Array.isArray(tools)) return { ok: false, error: "tools must be an array" };
  if (tools.length > MAX_CALLER_TOOLS) {
    return { ok: false, error: `at most ${MAX_CALLER_TOOLS} caller tools may be declared` };
  }
  const builtInNames = new Set(getBuiltInToolMetadata().map((t) => t.name));
  const seen = new Set<string>();
  const out: CallerToolDeclaration[] = [];
  for (const raw of tools) {
    if (!isPlainObject(raw)) return { ok: false, error: "each tool must be an object" };
    const { name, description, parameters, timeoutMs } = raw;
    if (typeof name !== "string" || !CALLER_TOOL_NAME_RE.test(name)) {
      return { ok: false, error: "invalid tool name", field: String(name) };
    }
    if (seen.has(name)) return { ok: false, error: "duplicate tool name", field: name };
    seen.add(name);
    if (CALLER_TOOL_RESERVED_NAMES.has(name)) {
      return { ok: false, error: "tool name is reserved", field: name };
    }
    if (builtInNames.has(name)) {
      return { ok: false, error: "tool name collides with a built-in tool", field: name };
    }
    if (typeof description !== "string" || description.length === 0) {
      return { ok: false, error: "description is required", field: name };
    }
    const paramErr = validateParameters(parameters);
    if (paramErr) return { ok: false, error: paramErr, field: name };
    out.push({
      name,
      description,
      parameters: parameters as Record<string, unknown>,
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    });
  }
  return { ok: true, tools: out };
}

/**
 * Read declarations back out of a `conversations.metadata` value. Tolerant
 * by design: metadata is a shared bag written by several owners, so an
 * absent, null, or malformed `callerTools` reads as "none declared" rather
 * than throwing on a path (turn setup) that has no way to report it.
 */
export function readCallerToolsFromMetadata(metadata: unknown): CallerToolDeclaration[] {
  if (!isPlainObject(metadata)) return [];
  const checked = validateCallerToolDeclarations(metadata.callerTools);
  return checked.ok ? checked.tools : [];
}
