// ── @ezcorp/sdk entities — JSON Schema validator ────────────────
//
// Hand-rolled validator for the locked subset (see types.ts):
//   - object: properties, required, additionalProperties
//   - string: minLength, maxLength, pattern, enum
//   - number: minimum, maximum, integer
//   - boolean
//   - array: items, minItems, maxItems
//
// Two entry points:
//   - validateRecord(schema, data)         → soft (returns issues[])
//   - assertRecord(schema, data, ctx)      → hard (throws EntityValidationError)
//
// Locked decision #7: writes are hard-fail; reads are soft (warn).
// The two entry points share a single recursive walker `walk()` that
// pushes issues to an accumulator — `assertRecord` re-throws after the
// walk if any issue accumulated. Keeping a single walker keeps the
// soft/hard branches honest with each other (same error messages, same
// path-encoding rules).
//
// Path encoding: dotted keys for objects, `[i]` for arrays. Examples:
//   "name"
//   "defaults.titlePrefix"
//   "tags[2]"
//   "matrix[0][3].value"
//
// Pattern compilation is per-call. The subset is small, schemas are
// stable across an extension's lifetime, and the JIT will memoize
// hot patterns — no LRU needed in v1.

import {
  EntityValidationError,
  type EntityValidationIssue,
  type JsonSchema,
  type JsonSchemaArray,
  type JsonSchemaBoolean,
  type JsonSchemaNumber,
  type JsonSchemaObject,
  type JsonSchemaString,
} from "./types";

// ── Path helpers ────────────────────────────────────────────────

function joinPath(parent: string, child: string): string {
  if (parent === "") return child;
  return `${parent}.${child}`;
}

function joinIndex(parent: string, idx: number): string {
  return `${parent}[${idx}]`;
}

// ── Type checks ─────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    // Reject Date, RegExp, etc. — only POJOs survive JSON round-trips
    // anyway, but the runtime check protects callers that hand us
    // pre-deserialized blobs.
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// ── Per-primitive walkers ───────────────────────────────────────

function walkString(
  schema: JsonSchemaString,
  value: unknown,
  path: string,
  issues: EntityValidationIssue[],
): void {
  if (typeof value !== "string") {
    issues.push({ path, message: `expected string, got ${typeOfRich(value)}` });
    return;
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    issues.push({
      path,
      message: `string length ${value.length} below minLength ${schema.minLength}`,
    });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    issues.push({
      path,
      message: `string length ${value.length} above maxLength ${schema.maxLength}`,
    });
  }
  if (schema.pattern !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(schema.pattern);
    } catch (err) {
      issues.push({
        path,
        message: `schema pattern is not a valid regex: ${(err as Error).message}`,
      });
      return;
    }
    if (!re.test(value)) {
      issues.push({
        path,
        message: `string does not match pattern /${schema.pattern}/`,
      });
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    issues.push({
      path,
      message: `expected one of [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}], got ${JSON.stringify(value)}`,
    });
  }
}

function walkNumber(
  schema: JsonSchemaNumber,
  value: unknown,
  path: string,
  issues: EntityValidationIssue[],
): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    issues.push({ path, message: `expected number, got ${typeOfRich(value)}` });
    return;
  }
  if (!Number.isFinite(value)) {
    issues.push({ path, message: `number must be finite, got ${value}` });
    return;
  }
  if (schema.integer === true && !Number.isInteger(value)) {
    issues.push({ path, message: `expected integer, got ${value}` });
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    issues.push({
      path,
      message: `number ${value} below minimum ${schema.minimum}`,
    });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    issues.push({
      path,
      message: `number ${value} above maximum ${schema.maximum}`,
    });
  }
}

function walkBoolean(
  _schema: JsonSchemaBoolean,
  value: unknown,
  path: string,
  issues: EntityValidationIssue[],
): void {
  if (typeof value !== "boolean") {
    issues.push({ path, message: `expected boolean, got ${typeOfRich(value)}` });
  }
}

function walkArray(
  schema: JsonSchemaArray,
  value: unknown,
  path: string,
  issues: EntityValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: `expected array, got ${typeOfRich(value)}` });
    return;
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    issues.push({
      path,
      message: `array length ${value.length} below minItems ${schema.minItems}`,
    });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    issues.push({
      path,
      message: `array length ${value.length} above maxItems ${schema.maxItems}`,
    });
  }
  if (schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      walk(schema.items, value[i], joinIndex(path, i), issues);
    }
  }
}

function walkObject(
  schema: JsonSchemaObject,
  value: unknown,
  path: string,
  issues: EntityValidationIssue[],
): void {
  if (!isPlainObject(value)) {
    issues.push({ path, message: `expected object, got ${typeOfRich(value)}` });
    return;
  }
  // required
  if (schema.required !== undefined) {
    for (const key of schema.required) {
      if (!(key in value)) {
        issues.push({
          path: joinPath(path, key),
          message: `required property is missing`,
        });
      }
    }
  }
  // additionalProperties (default true at JSON-Schema level, but the
  // SDK treats omission as false when the manifest doesn't say
  // otherwise — locked decision: extra keys are noise we don't want.
  // Authors who need open-ended bodies must opt in explicitly.)
  const allowAdditional = schema.additionalProperties === true;
  const props = schema.properties ?? {};
  for (const key of Object.keys(value)) {
    if (key in props) continue;
    if (!allowAdditional) {
      issues.push({
        path: joinPath(path, key),
        message: `unknown property (additionalProperties=false)`,
      });
    }
  }
  // walk declared properties
  for (const [key, childSchema] of Object.entries(props)) {
    if (!(key in value)) continue; // required-check already covers absence
    walk(childSchema, value[key], joinPath(path, key), issues);
  }
}

function walk(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: EntityValidationIssue[],
): void {
  switch (schema.type) {
    case "string":
      walkString(schema, value, path, issues);
      return;
    case "number":
      walkNumber(schema, value, path, issues);
      return;
    case "boolean":
      walkBoolean(schema, value, path, issues);
      return;
    case "array":
      walkArray(schema, value, path, issues);
      return;
    case "object":
      walkObject(schema, value, path, issues);
      return;
    default: {
      // Exhaustiveness — unreachable when callers respect the type.
      // Treat as a structural issue rather than throwing, so soft-read
      // can surface "we don't understand this schema" rather than
      // crashing the read.
      const exhaustiveCheck: never = schema;
      issues.push({
        path,
        message: `unsupported schema type: ${JSON.stringify((exhaustiveCheck as { type?: unknown })?.type ?? null)}`,
      });
    }
  }
}

// ── typeof with array + null discrimination ─────────────────────

function typeOfRich(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ── Public surface ──────────────────────────────────────────────

/**
 * Validate `data` against `schema`. Returns the issue list (empty on
 * success). Never throws. Used by soft-read paths and by manifest
 * pre-checks.
 */
export function validateRecord(
  schema: JsonSchema,
  data: unknown,
): EntityValidationIssue[] {
  const issues: EntityValidationIssue[] = [];
  walk(schema, data, "", issues);
  return issues;
}

/**
 * Hard-fail variant for write paths. Throws `EntityValidationError`
 * with the full issue list when validation fails.
 *
 * `ctx` prefixes the thrown error message — e.g. `create_post_type` —
 * so call-sites don't have to wrap.
 */
export function assertRecord(
  schema: JsonSchema,
  data: unknown,
  ctx = "record",
): void {
  const issues = validateRecord(schema, data);
  if (issues.length === 0) return;
  const summary = issues
    .slice(0, 5)
    .map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.message}`)
    .join("; ");
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : "";
  throw new EntityValidationError(
    `${ctx} failed schema validation: ${summary}${more}`,
    issues,
  );
}
