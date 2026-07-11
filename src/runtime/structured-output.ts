/**
 * Host-side structured-output validation for `invoke_agent`'s
 * `outputSchema` (Phase B1 — Claude-Code-style structured sub-agent
 * results).
 *
 * When an orchestrator asks a sub-agent for JSON conforming to a schema,
 * the host validates the child's FINAL text against that schema before
 * releasing the result to the orchestrator LLM. This module owns three
 * pure concerns so `start-assignment.ts` stays lean and this logic is
 * independently unit-tested:
 *
 *   1. `extractJsonCandidate` — pull the JSON value out of a final
 *      message that may be raw JSON, a ```json fence, or JSON with
 *      surrounding prose.
 *   2. `validateAgainstSchema` / `validateStructuredOutput` — a minimal
 *      **standard** JSON-Schema validator over a documented subset.
 *   3. `buildSchemaInstruction` / `buildSchemaCorrection` — the prompt
 *      fragments that tell the sub-agent what to emit (initial) and how
 *      to fix it (on a validation failure).
 *
 * ── Why a bespoke validator (not the SDK's entity validator) ─────────
 * `@ezcorp/sdk/entities/validate.ts` exists but models a DIFFERENT
 * schema dialect: integers are `{type:"number", integer:true}`, there is
 * no `null` type, and `enum` is string-only. An orchestrator LLM writes
 * *standard* JSON Schema — `{"type":"integer"}`, `{"type":"null"}`, and
 * `enum` over any type — so the entity validator would reject the most
 * natural schemas as "unsupported". This module validates the standard
 * dialect directly.
 *
 * ── Supported subset (everything else is a documented no-op) ─────────
 *   - `type`: "object" | "array" | "string" | "number" | "integer" |
 *     "boolean" | "null"  (single string only — union `type: []` arrays
 *     are reported as unsupported)
 *   - object: `properties`, `required`, `additionalProperties` (standard
 *     default is TRUE — only an explicit `false` rejects unknown keys)
 *   - array: `items`
 *   - `enum` (on any node; the tightest constraint — when present the
 *     value must deep-equal one of the listed literals)
 *   - arbitrary nesting of the above
 *
 * Constraint keywords NOT in the subset (minimum/maximum/minLength/
 * pattern/…) are intentionally ignored — they do not cause a failure,
 * they simply are not enforced.
 */

export interface SchemaIssue {
  /** Dotted/indexed path into the candidate value; "" for the root. */
  path: string;
  message: string;
}

export type StructuredOutcome =
  | { ok: true; value: unknown }
  | { ok: false; issues: SchemaIssue[]; summary: string };

/** Cap on how many issues the human/LLM-facing summary enumerates. */
const MAX_SUMMARY_ISSUES = 8;

// ── JSON extraction ──────────────────────────────────────────────────

/**
 * Extract the JSON value from a sub-agent's final message. Tries, in
 * order: the LAST ```json (or bare ```) fenced block (an agent's final
 * answer is usually last), then the whole trimmed text, then the widest
 * `{ … }` brace-delimited substring (handles leading/trailing prose).
 * The first candidate that `JSON.parse`s wins.
 */
export function extractJsonCandidate(
  text: string,
): { found: true; value: unknown } | { found: false } {
  const trimmed = text.trim();
  if (!trimmed) return { found: false };

  const candidates: string[] = [];

  // Fenced blocks — collect every ```json … ``` (or ``` … ```) block and
  // prefer the LAST one (the final answer in a multi-block message).
  const fenceRe = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;
  const fences: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    const inner = (m[1] ?? "").trim();
    if (inner) fences.push(inner);
  }
  for (let i = fences.length - 1; i >= 0; i--) candidates.push(fences[i]!);

  // Whole text (raw-JSON case).
  candidates.push(trimmed);

  // Widest brace-delimited substring (a JSON object embedded in prose).
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  // Widest bracket-delimited substring (a top-level JSON array in prose).
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  }

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      return { found: true, value };
    } catch {
      // Not this candidate — try the next.
    }
  }
  return { found: false };
}

// ── Validator ────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOfRich(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function pushTypeIssue(
  issues: SchemaIssue[],
  path: string,
  expected: string,
  value: unknown,
): void {
  issues.push({ path, message: `expected ${expected}, got ${typeOfRich(value)}` });
}

/** Recursively sort object keys so structural equality is
 *  key-order-insensitive (`{a,b}` === `{b,a}`). Arrays keep their order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/** Structural equality for enum membership (primitive `===`, else a
 *  key-order-insensitive canonical-JSON comparison). Both sides are JSON
 *  values, so `JSON.stringify` never throws. */
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

function joinKey(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

/**
 * Validate `value` against `schema`, pushing every violation onto
 * `issues`. Recurses through object properties and array items.
 */
export function validateAgainstSchema(
  schema: unknown,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): void {
  if (!isPlainObject(schema)) {
    issues.push({ path, message: "invalid schema node (expected an object)" });
    return;
  }

  // enum — validated ADDITIVELY per standard JSON Schema: a value must be
  // one of the listed literals AND still satisfy any sibling `type`/etc.
  // (no short-circuit). Membership is key-order-insensitive for objects.
  if (Array.isArray(schema.enum)) {
    const options = schema.enum as unknown[];
    if (!options.some((option) => sameJsonValue(option, value))) {
      issues.push({
        path,
        message: `value not in enum [${options.map((o) => JSON.stringify(o)).join(", ")}]`,
      });
    }
  }

  const type = schema.type;
  if (type === undefined) {
    // Typeless schema (e.g. `{}` or enum-only) imposes no type constraint.
    return;
  }
  if (typeof type !== "string") {
    // Union `type: ["string","null"]` and other non-string forms are
    // outside the supported subset.
    issues.push({ path, message: `unsupported schema "type": ${JSON.stringify(type)}` });
    return;
  }

  switch (type) {
    case "object":
      walkObject(schema, value, path, issues);
      return;
    case "array":
      walkArray(schema, value, path, issues);
      return;
    case "string":
      if (typeof value !== "string") pushTypeIssue(issues, path, "string", value);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        pushTypeIssue(issues, path, "number", value);
      }
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        pushTypeIssue(issues, path, "integer", value);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") pushTypeIssue(issues, path, "boolean", value);
      return;
    case "null":
      if (value !== null) pushTypeIssue(issues, path, "null", value);
      return;
    default:
      issues.push({ path, message: `unsupported schema "type": ${JSON.stringify(type)}` });
  }
}

function walkObject(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): void {
  if (!isPlainObject(value)) {
    pushTypeIssue(issues, path, "object", value);
    return;
  }
  // Object.hasOwn (not `in`) throughout: a value parsed from JSON only ever
  // carries OWN keys, and `in` would spuriously match inherited proto keys
  // like `constructor`/`toString` — making a `required: ["constructor"]`
  // pass or an `additionalProperties:false` miss a proto-named extra key.
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  for (const rawKey of required) {
    const key = String(rawKey);
    if (!Object.hasOwn(value, key)) {
      issues.push({ path: joinKey(path, key), message: "required property is missing" });
    }
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  // additionalProperties defaults to TRUE in standard JSON Schema; only an
  // explicit `false` rejects keys not in `properties`.
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        issues.push({
          path: joinKey(path, key),
          message: "unknown property (additionalProperties is false)",
        });
      }
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) continue; // absence handled by the required-check
    validateAgainstSchema(childSchema, value[key], joinKey(path, key), issues);
  }
}

function walkArray(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): void {
  if (!Array.isArray(value)) {
    pushTypeIssue(issues, path, "array", value);
    return;
  }
  if (schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      validateAgainstSchema(schema.items, value[i], `${path}[${i}]`, issues);
    }
  }
}

/** Render an issue list into a compact, LLM-readable summary. */
export function summarizeIssues(issues: SchemaIssue[]): string {
  const shown = issues
    .slice(0, MAX_SUMMARY_ISSUES)
    .map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.message}`)
    .join("; ");
  const more =
    issues.length > MAX_SUMMARY_ISSUES ? ` (+${issues.length - MAX_SUMMARY_ISSUES} more)` : "";
  return shown + more;
}

/**
 * Extract JSON from `text` and validate it against `schema`. Returns the
 * parsed value on success, or the issue list + a summary on failure
 * (including "no JSON found").
 */
export function validateStructuredOutput(
  schema: Record<string, unknown>,
  text: string,
): StructuredOutcome {
  const extracted = extractJsonCandidate(text);
  if (!extracted.found) {
    const issues: SchemaIssue[] = [
      { path: "", message: "no JSON value found in the response" },
    ];
    return { ok: false, issues, summary: summarizeIssues(issues) };
  }
  const issues: SchemaIssue[] = [];
  validateAgainstSchema(schema, extracted.value, "", issues);
  if (issues.length === 0) return { ok: true, value: extracted.value };
  return { ok: false, issues, summary: summarizeIssues(issues) };
}

// ── Prompt fragments ─────────────────────────────────────────────────

function serializeSchema(schema: Record<string, unknown>): string {
  return JSON.stringify(schema, null, 2);
}

/**
 * Instruction appended to the sub-agent's FIRST message when an
 * `outputSchema` is set: emit a single JSON object satisfying the schema.
 */
export function buildSchemaInstruction(schema: Record<string, unknown>): string {
  return (
    "\n\n## Required Output Format\n" +
    "When you have finished the task, your FINAL message MUST be a single " +
    "JSON object that satisfies the JSON Schema below. Output only that JSON " +
    "— either inside a ```json code fence or as raw JSON — with no other " +
    "prose after it.\n\n" +
    "```json\n" +
    serializeSchema(schema) +
    "\n```"
  );
}

/**
 * Corrective re-prompt after a validation failure: quote the violations
 * and restate the schema.
 *
 * `opts.autonomous` — when the child is running under autonomous
 * self-continuation it has been told to emit `<<TASK_DONE>>` sentinels;
 * the host gates this correction run out of the autonomous loop, so tell
 * the child explicitly NOT to emit a completion sentinel here (just the
 * JSON), removing the conflicting instruction.
 */
export function buildSchemaCorrection(
  schema: Record<string, unknown>,
  summary: string,
  opts?: { autonomous?: boolean },
): string {
  const sentinelNote = opts?.autonomous
    ? " Do NOT emit a completion sentinel (e.g. <<TASK_DONE>>) in this message — reply with the JSON only."
    : "";
  return (
    "Your previous response did not satisfy the required output schema.\n\n" +
    `Validation errors: ${summary}\n\n` +
    "Respond again with a SINGLE JSON object that satisfies this schema " +
    "(inside a ```json code fence or as raw JSON, with no other prose)." +
    sentinelNote +
    "\n\n" +
    "```json\n" +
    serializeSchema(schema) +
    "\n```"
  );
}
