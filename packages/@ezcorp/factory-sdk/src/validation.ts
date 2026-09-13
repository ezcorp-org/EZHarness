import { jsonEqual, unicodeLength, validateIJson } from "./canonical";
import type { JsonValue, PortSchema, ValidationIssue, ValidationResult } from "./types";

const PORT_SCHEMA_KEYS = new Set([
  "$defs", "$ref", "additionalProperties", "const", "description", "enum", "items",
  "maxItems", "maxLength", "maximum", "minItems", "minLength", "minimum",
  "properties", "required", "title", "type",
]);
const TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

function own(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function issue(code: string, message: string, path: readonly (string | number)[]): ValidationResult {
  return { ok: false, issues: [{ code, message, path }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodePointerToken(token: string): string | undefined {
  let result = "";
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index] as string;
    if (character !== "~") {
      result += character;
      continue;
    }
    const escaped = token[index + 1];
    if (escaped === "0") result += "~";
    else if (escaped === "1") result += "/";
    else return undefined;
    index += 1;
  }
  return result;
}

function resolveLocalReference(root: PortSchema, reference: string): PortSchema | undefined {
  if (!reference.startsWith("#")) return undefined;
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const rawToken of reference.slice(2).split("/")) {
    const token = decodePointerToken(rawToken);
    if (token === undefined || !isRecord(value) || !own(value, token)) return undefined;
    value = value[token];
  }
  return isRecord(value) ? (value as PortSchema) : undefined;
}

function checkOptionalInteger(record: Record<string, unknown>, key: string, path: readonly (string | number)[]): ValidationResult {
  if (!own(record, key)) return { ok: true };
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { ok: true }
    : issue("SCHEMA_BOUND_INVALID", `${key} must be a nonnegative safe integer.`, [...path, key]);
}

function validateSchemaNode(input: unknown, root: PortSchema, path: readonly (string | number)[], ancestors: ReadonlySet<object>): ValidationResult {
  if (!isRecord(input)) return issue("SCHEMA_OBJECT_REQUIRED", "A port schema must be an object.", path);
  const schema = input as PortSchema;
  for (const key of Object.keys(input)) if (!PORT_SCHEMA_KEYS.has(key)) return issue("SCHEMA_KEYWORD_UNSUPPORTED", `Unsupported schema keyword: ${key}.`, [...path, key]);
  if (ancestors.has(input)) return issue("SCHEMA_RECURSIVE", "Recursive schemas are not supported.", path);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(input);

  if (own(input, "title") && typeof input.title !== "string") return issue("SCHEMA_DESCRIPTION_INVALID", "title must be a string.", [...path, "title"]);
  if (own(input, "description") && typeof input.description !== "string") return issue("SCHEMA_DESCRIPTION_INVALID", "description must be a string.", [...path, "description"]);
  if (own(input, "additionalProperties") && typeof input.additionalProperties !== "boolean") return issue("SCHEMA_ADDITIONAL_PROPERTIES_INVALID", "additionalProperties must be boolean.", [...path, "additionalProperties"]);
  if (own(input, "properties") && !isRecord(input.properties)) return issue("SCHEMA_PROPERTIES_INVALID", "properties must be an object.", [...path, "properties"]);
  if (own(input, "$defs") && !isRecord(input.$defs)) return issue("SCHEMA_DEFS_INVALID", "$defs must be an object.", [...path, "$defs"]);
  if (own(input, "items") && !isRecord(input.items)) return issue("SCHEMA_ITEMS_INVALID", "items must be one schema.", [...path, "items"]);
  if (own(input, "required") && (!Array.isArray(input.required) || input.required.some((name) => typeof name !== "string"))) return issue("SCHEMA_REQUIRED_INVALID", "required must be an array of strings.", [...path, "required"]);
  if (own(input, "enum") && (!Array.isArray(input.enum) || input.enum.length === 0)) return issue("SCHEMA_ENUM_INVALID", "enum must be a nonempty array.", [...path, "enum"]);
  for (const key of ["minItems", "maxItems", "minLength", "maxLength"]) {
    const result = checkOptionalInteger(input, key, path);
    if (!result.ok) return result;
  }
  for (const key of ["minimum", "maximum"]) if (own(input, key) && (typeof input[key] !== "number" || !Number.isFinite(input[key]))) return issue("SCHEMA_BOUND_INVALID", `${key} must be finite.`, [...path, key]);
  if (own(input, "const")) {
    const result = validateIJson(input.const);
    if (!result.ok) return issue("SCHEMA_CONST_INVALID", "const must be I-JSON.", [...path, "const", ...result.issues[0]!.path]);
  }
  if (Array.isArray(input.enum)) {
    const enumValues = input.enum as unknown[];
    for (let index = 0; index < enumValues.length; index += 1) {
      const result = validateIJson(enumValues[index]);
      if (!result.ok) return issue("SCHEMA_ENUM_INVALID", "Every enum value must be I-JSON.", [...path, "enum", index]);
      if (enumValues.slice(0, index).some((value) => jsonEqual(value as JsonValue, enumValues[index] as JsonValue))) return issue("SCHEMA_ENUM_INVALID", "Enum values must be unique.", [...path, "enum", index]);
    }
  }

  if (typeof input.$ref === "string") {
    if (Object.keys(input).some((key) => key !== "$ref" && key !== "$defs" && key !== "title" && key !== "description")) return issue("SCHEMA_REF_SIBLING", "A local reference cannot have execution siblings.", path);
    const target = resolveLocalReference(root, input.$ref);
    if (!target) return issue("SCHEMA_REF_INVALID", "Reference must resolve through a local JSON Pointer.", [...path, "$ref"]);
    const result = validateSchemaNode(target, root, [...path, "$ref"], nextAncestors);
    if (!result.ok) return result;
  } else {
    if (own(input, "$ref")) return issue("SCHEMA_REF_INVALID", "$ref must be a string.", [...path, "$ref"]);
    const type = input.type;
    const types = Array.isArray(type) ? type : typeof type === "string" ? [type] : [];
    const validNullable = types.length === 2 && types.includes("null") && types[0] !== types[1];
    if (types.length === 0) return issue("SCHEMA_TYPE_REQUIRED", "A port schema type is required.", [...path, "type"]);
    if (types.some((entry) => typeof entry !== "string" || !TYPES.has(entry)) || (types.length !== 1 && !validNullable)) return issue("SCHEMA_TYPE_UNSUPPORTED", "Type must be one supported type or a nullable union.", [...path, "type"]);
  }

  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) return issue("SCHEMA_BOUND_ORDER", "minItems cannot exceed maxItems.", path);
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) return issue("SCHEMA_BOUND_ORDER", "minLength cannot exceed maxLength.", path);
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) return issue("SCHEMA_BOUND_ORDER", "minimum cannot exceed maximum.", path);

  const properties = isRecord(input.properties) ? input.properties : undefined;
  if (properties) for (const [name, child] of Object.entries(properties)) {
    const result = validateSchemaNode(child, root, [...path, "properties", name], nextAncestors);
    if (!result.ok) return result;
  }
  if (Array.isArray(input.required)) {
    const seen = new Set<string>();
    for (const name of input.required) {
      if (seen.has(name) || !properties || !own(properties, name)) return issue("SCHEMA_REQUIRED_INVALID", "Required names must be unique declared properties.", [...path, "required"]);
      seen.add(name);
    }
  }
  if (isRecord(input.items)) {
    const result = validateSchemaNode(input.items, root, [...path, "items"], nextAncestors);
    if (!result.ok) return result;
  }
  if (isRecord(input.$defs)) for (const [name, child] of Object.entries(input.$defs)) {
    const result = validateSchemaNode(child, root, [...path, "$defs", name], nextAncestors);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function validatePortSchema(schema: PortSchema): ValidationResult {
  return validateSchemaNode(schema, schema, [], new Set());
}

function valueTypeMatches(type: string, value: JsonValue): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === type;
}

function validateValueNode(schema: PortSchema, root: PortSchema, value: JsonValue, path: readonly (string | number)[]): ValidationResult {
  if (schema.$ref) {
    const target = resolveLocalReference(root, schema.$ref);
    return target ? validateValueNode(target, root, value, path) : issue("SCHEMA_REF_INVALID", "The local schema reference is invalid.", path);
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type as string];
  if (!types.some((type) => valueTypeMatches(type, value))) return issue("VALUE_TYPE", `Expected ${types.join(" or ")}.`, path);
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) return issue("VALUE_CONST", "Value does not match const.", path);
  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(candidate, value))) return issue("VALUE_ENUM", "Value is not in enum.", path);
  if (typeof value === "string") {
    const length = unicodeLength(value);
    if (schema.minLength !== undefined && length < schema.minLength) return issue("VALUE_MIN_LENGTH", "String is shorter than minLength.", path);
    if (schema.maxLength !== undefined && length > schema.maxLength) return issue("VALUE_MAX_LENGTH", "String is longer than maxLength.", path);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return issue("VALUE_MINIMUM", "Number is below minimum.", path);
    if (schema.maximum !== undefined && value > schema.maximum) return issue("VALUE_MAXIMUM", "Number is above maximum.", path);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return issue("VALUE_MIN_ITEMS", "Array has fewer items than minItems.", path);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return issue("VALUE_MAX_ITEMS", "Array has more items than maxItems.", path);
    if (schema.items) for (let index = 0; index < value.length; index += 1) {
      const result = validateValueNode(schema.items, root, value[index] as JsonValue, [...path, index]);
      if (!result.ok) return result;
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) if (!own(value, required)) return issue("VALUE_REQUIRED", `Missing required property: ${required}.`, [...path, required]);
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = schema.properties && own(schema.properties, key) ? schema.properties[key] : undefined;
      if (!propertySchema) {
        if (schema.additionalProperties === false) return issue("VALUE_ADDITIONAL_PROPERTY", `Unexpected property: ${key}.`, [...path, key]);
      } else {
        const result = validateValueNode(propertySchema, root, child, [...path, key]);
        if (!result.ok) return result;
      }
    }
  }
  return { ok: true };
}

export function validateValue(schema: PortSchema, value: JsonValue): ValidationResult {
  const schemaResult = validatePortSchema(schema);
  if (!schemaResult.ok) return schemaResult;
  const valueResult = validateIJson(value);
  if (!valueResult.ok) return valueResult;
  return validateValueNode(schema, schema, value, []);
}

function dereference(schema: PortSchema, root: PortSchema): PortSchema | undefined {
  let current: PortSchema | undefined = schema;
  const seen = new Set<PortSchema>();
  while (current?.$ref) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    current = resolveLocalReference(root, current.$ref);
  }
  return current;
}
function typeSet(schema: PortSchema): ReadonlySet<string> {
  return new Set(Array.isArray(schema.type) ? schema.type : [schema.type as string]);
}
function contained(producerInput: PortSchema, consumerInput: PortSchema, producerRoot: PortSchema, consumerRoot: PortSchema): boolean {
  const producer = dereference(producerInput, producerRoot);
  const consumer = dereference(consumerInput, consumerRoot);
  if (!producer || !consumer) return false;
  const producerTypes = typeSet(producer);
  const consumerTypes = typeSet(consumer);
  for (const type of producerTypes) if (!consumerTypes.has(type) && !(type === "integer" && consumerTypes.has("number"))) return false;
  if (consumer.const !== undefined && (producer.const === undefined || !jsonEqual(producer.const, consumer.const))) return false;
  if (consumer.enum) {
    const values = producer.const !== undefined ? [producer.const] : producer.enum;
    if (!values || values.some((value) => !consumer.enum?.some((candidate) => jsonEqual(value, candidate)))) return false;
  }
  if (consumer.minimum !== undefined && (producer.minimum === undefined || producer.minimum < consumer.minimum)) return false;
  if (consumer.maximum !== undefined && (producer.maximum === undefined || producer.maximum > consumer.maximum)) return false;
  if (consumer.minLength !== undefined && (producer.minLength === undefined || producer.minLength < consumer.minLength)) return false;
  if (consumer.maxLength !== undefined && (producer.maxLength === undefined || producer.maxLength > consumer.maxLength)) return false;
  if (consumer.minItems !== undefined && (producer.minItems === undefined || producer.minItems < consumer.minItems)) return false;
  if (consumer.maxItems !== undefined && (producer.maxItems === undefined || producer.maxItems > consumer.maxItems)) return false;
  if (consumer.items && (!producer.items || !contained(producer.items, consumer.items, producerRoot, consumerRoot))) return false;
  for (const required of consumer.required ?? []) if (!producer.required?.includes(required)) return false;
  for (const [key, property] of Object.entries(producer.properties ?? {})) {
    const target = consumer.properties && own(consumer.properties, key) ? consumer.properties[key] : undefined;
    if (target ? !contained(property, target, producerRoot, consumerRoot) : consumer.additionalProperties === false) return false;
  }
  if (producer.additionalProperties !== false) {
    for (const key of Object.keys(consumer.properties ?? {})) if (!producer.properties || !own(producer.properties, key)) return false;
  }
  return !(producer.additionalProperties !== false && consumer.additionalProperties === false);
}

export function isSchemaContained(producer: PortSchema, consumer: PortSchema): boolean {
  return validatePortSchema(producer).ok && validatePortSchema(consumer).ok && contained(producer, consumer, producer, consumer);
}

export function firstValidationIssue(result: ValidationResult): ValidationIssue | undefined {
  return result.ok ? undefined : result.issues[0];
}
