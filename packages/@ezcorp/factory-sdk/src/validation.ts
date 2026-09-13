import { canonicalizeJson, isUnsignedDecimal, jsonEqual, unicodeLength, validateIJson } from "./canonical.js";
import { isCompiledFactory, isFactoryRunnerRequest, isFactoryRunnerResult } from "./schema.js";
import {
  FACTORY_LIMITS,
  type CompiledFactory,
  type FactoryArtifactReference,
  type FactoryGraph,
  type FactoryRunnerOperationResult,
  type FactoryRunnerRequest,
  type FactoryRunnerResult,
  type FactoryUsage,
  type JsonValue,
  type PortSchema,
  type ValidationIssue,
  type ValidationResult,
} from "./types.js";

const PORT_SCHEMA_KEYS = new Set([
  "$defs", "$ref", "additionalProperties", "const", "description", "enum", "items",
  "maxItems", "maxLength", "maximum", "minItems", "minLength", "minimum",
  "properties", "required", "title", "type",
]);
const TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

function own(object: object, key: PropertyKey): boolean {
  return  Object.hasOwn(object, key);
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

export function resolveSchemaReference(root: PortSchema, reference: string): PortSchema | undefined {
  return resolveLocalReference(root, reference);
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validDigest(value: string, prefixed: boolean): boolean {
  const content = prefixed ? value.startsWith("sha256:") ? value.slice(7) : "" : value;
  if (content.length !== 64) return false;
  for (const character of content) {
    if (!((character >= "0" && character <= "9") || (character >= "a" && character <= "f"))) return false;
  }
  return true;
}

function safeCounter(value: number, minimum = 0): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

function boundedText(value: string, maximum = 256): boolean {
  if (value.length === 0 || unicodeLength(value) > maximum) return false;
  for (const character of value) if (character.charCodeAt(0) < 32) return false;
  return true;
}

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && compareText(values[index - 1] as string, values[index] as string) >= 0) return false;
  }
  return true;
}

function encodedBytes(value: JsonValue): number {
  return new TextEncoder().encode(canonicalizeJson(value)).byteLength;
}

function graphNodes(root: FactoryGraph): readonly { readonly id: string; readonly value: JsonValue }[] {
  const result: { id: string; value: JsonValue }[] = [];
  const pending: FactoryGraph[] = [root];
  while (pending.length > 0) {
    const graph = pending.pop() as FactoryGraph;
    for (let index = graph.nodes.length - 1; index >= 0; index -= 1) {
      const node = graph.nodes[index]!;
      result.push({ id: node.id, value: node as unknown as JsonValue });
      if (node.kind === "branch") {
        pending.push(node.else, node.then);
      } else if (node.kind === "map" || node.kind === "loop") {
        pending.push(node.body);
      }
    }
  }
  return result;
}

/**
 * Workflow-safe validation for an already compiled artifact. It checks the
 * generated schema and every bounded manifest relationship without hashing.
 */
export function validateCompiledFactory(value: unknown): ValidationResult {
  if (!isCompiledFactory(value)) return issue("COMPILED_SCHEMA", "Value does not match the generated CompiledFactory schema.", []);
  const factory = value as CompiledFactory;
  if (!validDigest(factory.digest, true) || (factory.presentationDigest !== undefined && !validDigest(factory.presentationDigest, true))) return issue("COMPILED_DIGEST", "Compiled digests must be lowercase sha256 values.", ["digest"]);
  if (encodedBytes({ definition: factory.definition, lock: factory.lock } as unknown as JsonValue) > FACTORY_LIMITS.maxDefinitionBytes) return issue("COMPILED_BYTES", "Compiled definition and lock exceed 16 MiB.", []);
  if (!safeCounter(factory.definition.bounds.maxExpandedNodes, 1) || factory.definition.bounds.maxExpandedNodes > FACTORY_LIMITS.maxExpandedNodes || !safeCounter(factory.definition.bounds.maxScopeDepth, 1) || factory.definition.bounds.maxScopeDepth > FACTORY_LIMITS.maxScopeDepth) return issue("COMPILED_BOUND", "Compiled definition bounds exceed launch limits.", ["definition", "bounds"]);
  if ((factory.definition.presentation === undefined) !== (factory.presentationDigest === undefined)) return issue("COMPILED_PRESENTATION", "Presentation content and digest must be present together.", ["presentationDigest"]);

  const expectedLock = {
    packages: [...factory.definition.packages].sort((left, right) => compareText(left.name, right.name)),
    factories: [...(factory.definition.factories ?? [])].sort((left, right) => compareText(left.id, right.id)),
    interpreter: factory.definition.interpreterCompatibility,
  } as unknown as JsonValue;
  if (!jsonEqual(factory.lock as unknown as JsonValue, expectedLock)) return issue("COMPILED_LOCK", "Dependency lock does not match the embedded definition.", ["lock"]);

  const nodes = graphNodes(factory.definition.graph);
  if (nodes.length > FACTORY_LIMITS.maxExpandedNodes) return issue("COMPILED_NODES", "Compiled node count exceeds launch limits.", ["indexes", "nodeById"]);
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (!boundedText(node.id) || nodeIds.has(node.id)) return issue("COMPILED_NODE_ID", "Compiled node IDs must be bounded and unique.", ["indexes", "nodeById", node.id]);
    nodeIds.add(node.id);
    if (!own(factory.indexes.nodeById, node.id) || !jsonEqual(factory.indexes.nodeById[node.id] as unknown as JsonValue, node.value)) return issue("COMPILED_NODE_INDEX", "Node index differs from the embedded graph.", ["indexes", "nodeById", node.id]);
  }
  const indexKeys = Object.keys(factory.indexes.nodeById);
  const successorKeys = Object.keys(factory.indexes.successors);
  const dependencyKeys = Object.keys(factory.indexes.dependencyCounts);
  if (indexKeys.length !== nodeIds.size || successorKeys.length !== nodeIds.size || dependencyKeys.length !== nodeIds.size || [...indexKeys, ...successorKeys, ...dependencyKeys].some((id) => !nodeIds.has(id))) return issue("COMPILED_INDEX_KEYS", "Every compiled index must contain exactly the graph node IDs.", ["indexes"]);
  const inbound = new Map<string, number>([...nodeIds].map((id) => [id, 0]));
  for (const id of nodeIds) {
    const successors = factory.indexes.successors[id] as readonly string[];
    if (!isSortedUnique(successors) || successors.some((successor) => !nodeIds.has(successor))) return issue("COMPILED_SUCCESSORS", "Successor indexes must be sorted, unique, and local.", ["indexes", "successors", id]);
    for (const successor of successors) inbound.set(successor, (inbound.get(successor) ?? 0) + 1);
  }
  for (const id of nodeIds) if (!safeCounter(factory.indexes.dependencyCounts[id] as number) || factory.indexes.dependencyCounts[id] !== inbound.get(id)) return issue("COMPILED_DEPENDENCIES", "Dependency counts do not match successor indexes.", ["indexes", "dependencyCounts", id]);

  const partitionByNode = new Map<string, string>();
  const partitionIds = new Set<string>();
  for (let index = 0; index < factory.partitions.length; index += 1) {
    const partition = factory.partitions[index]!;
    if (partition.id !== `partition-${index}` || partitionIds.has(partition.id) || partition.nodeIds.length === 0 || partition.nodeIds.length > FACTORY_LIMITS.maxPartitionNodes) return issue("COMPILED_PARTITION", "Partitions need canonical IDs and bounded nonempty node lists.", ["partitions", index]);
    partitionIds.add(partition.id);
    if (!isSortedUnique(partition.dependsOn)) return issue("COMPILED_PARTITION_DEPENDENCIES", "Partition dependencies must be sorted and unique.", ["partitions", index, "dependsOn"]);
    for (const dependency of partition.dependsOn) {
      const dependencyIndex = factory.partitions.findIndex((candidate) => candidate.id === dependency);
      if (dependencyIndex < 0 || dependencyIndex >= index) return issue("COMPILED_PARTITION_DEPENDENCIES", "Partition dependencies must point to an earlier partition.", ["partitions", index, "dependsOn"]);
    }
    for (const id of partition.nodeIds) {
      if (!nodeIds.has(id) || partitionByNode.has(id)) return issue("COMPILED_PARTITION_NODE", "Each compiled node must occur in one partition.", ["partitions", index, "nodeIds"]);
      partitionByNode.set(id, partition.id);
    }
  }
  if (partitionByNode.size !== nodeIds.size) return issue("COMPILED_PARTITION_COVERAGE", "Partitions must cover every compiled node.", ["partitions"]);

  const pagedNodes = new Map<string, string[]>();
  const pageIds = new Set<string>();
  for (let index = 0; index < factory.pages.length; index += 1) {
    const page = factory.pages[index]!;
    if (page.id !== `page-${index}` || pageIds.has(page.id) || !partitionIds.has(page.partitionId) || page.nodeIds.length === 0 || !safeCounter(page.encodedBytes, 2) || page.encodedBytes > 32 * 1024 || !validDigest(page.digest, true)) return issue("COMPILED_PAGE", "Pages need canonical IDs, bounded bytes, valid digests, and a partition.", ["pages", index]);
    pageIds.add(page.id);
    const list = pagedNodes.get(page.partitionId) ?? [];
    for (const id of page.nodeIds) {
      if (partitionByNode.get(id) !== page.partitionId) return issue("COMPILED_PAGE_NODE", "Page nodes must belong to the page partition.", ["pages", index, "nodeIds"]);
      list.push(id);
    }
    pagedNodes.set(page.partitionId, list);
  }
  for (const partition of factory.partitions) {
    const actual = pagedNodes.get(partition.id) ?? [];
    if (actual.length !== partition.nodeIds.length || actual.some((id, index) => id !== partition.nodeIds[index])) return issue("COMPILED_PAGE_COVERAGE", "Pages must cover each partition in node order.", ["pages"]);
  }
  return { ok: true };
}

function validateArtifactReference(reference: FactoryArtifactReference, path: readonly (string | number)[]): ValidationResult {
  if (!boundedText(reference.artifactId) || reference.artifactId.includes("/") || reference.artifactId.includes("\\")) return issue("RUNNER_ARTIFACT_ID", "Artifact IDs must be bounded opaque identifiers, not paths.", [...path, "artifactId"]);
  if (!validDigest(reference.digest, true)) return issue("RUNNER_DIGEST", "Artifact digest must be a lowercase sha256 value.", [...path, "digest"]);
  return safeCounter(reference.encodedBytes) ? { ok: true } : issue("RUNNER_ARTIFACT_BYTES", "Artifact bytes must be a nonnegative safe integer.", [...path, "encodedBytes"]);
}

function validateUsage(usage: FactoryUsage, path: readonly (string | number)[]): ValidationResult {
  if (usage.kind === "unknown") return boundedText(usage.reason, 1_024) && isUnsignedDecimal(usage.heldCostMicros) ? { ok: true } : issue("RUNNER_USAGE", "Unknown usage needs a reason and unsigned held cost.", path);
  return safeCounter(usage.inputTokens) && safeCounter(usage.outputTokens) && safeCounter(usage.computeMs) && isUnsignedDecimal(usage.costMicros) ? { ok: true } : issue("RUNNER_USAGE", "Measured usage counters and cost must be nonnegative integers.", path);
}

function validateOperation(operation: FactoryRunnerOperationResult, path: readonly (string | number)[]): ValidationResult {
  const resultDigestInvalid = operation.state === "uncertain"
    ? operation.resultDigest !== undefined && !validDigest(operation.resultDigest, false)
    : !validDigest(operation.resultDigest, false);
  if (!boundedText(operation.operationId, 1_024) || !safeCounter(operation.operationIndex) || !validDigest(operation.requestDigest, false) || resultDigestInvalid || operation.providerReceiptDigest !== undefined && !validDigest(operation.providerReceiptDigest, false)) return issue("RUNNER_OPERATION", "Runner operation identity or digest is invalid.", path);
  if (operation.usage !== undefined) {
    const usage = validateUsage(operation.usage, [...path, "usage"]);
    if (!usage.ok) return usage;
  }
  if (operation.workspaceCheckpoint !== undefined) return validateArtifactReference(operation.workspaceCheckpoint, [...path, "workspaceCheckpoint"]);
  return { ok: true };
}

function validateRunnerEnvelope(value: unknown, kind: "request" | "result"): ValidationResult {
  if (encodedBytes(value as JsonValue) > FACTORY_LIMITS.maxWireBytes) return issue("RUNNER_WIRE_BYTES", `Factory runner ${kind} exceeds 64 KiB.`, []);
  return { ok: true };
}

export function validateFactoryRunnerRequest(value: unknown): ValidationResult {
  if (!isFactoryRunnerRequest(value)) return issue("RUNNER_REQUEST_SCHEMA", "Value does not match the generated FactoryRunnerRequest schema.", []);
  const request = value as FactoryRunnerRequest;
  const envelope = validateRunnerEnvelope(request, "request");
  if (!envelope.ok) return envelope;
  const authority = request.authority;
  for (const [key, field] of Object.entries(authority)) {
    if (typeof field === "string" ? !boundedText(field, 1_024) : !safeCounter(field)) return issue("RUNNER_AUTHORITY", "Runner authority fields must be bounded identities and nonnegative safe counters.", ["authority", key]);
  }
  if (authority.deadlineAtMs < 1) return issue("RUNNER_DEADLINE", "Runner deadline must be a positive epoch millisecond.", ["authority", "deadlineAtMs"]);
  if (!boundedText(request.runner.package) || !boundedText(request.runner.export) || !boundedText(request.runner.version) || request.runner.version === "latest" || request.runner.version.includes("*") || !validDigest(request.runner.digest, true)) return issue("RUNNER_PIN", "Runner package, exact version, export, and digest are required.", ["runner"]);
  if (request.model !== undefined && (!boundedText(request.model.provider) || !boundedText(request.model.model) || !validDigest(request.model.configurationDigest, true) || !validDigest(request.model.policyDigest, true) || request.runner.model !== undefined && request.runner.model !== request.model.model || request.runner.configurationDigest !== undefined && request.runner.configurationDigest !== request.model.configurationDigest)) return issue("RUNNER_MODEL_PIN", "Model and policy pins must match the runner reference.", ["model"]);
  if (!boundedText(request.broker.attemptToken, 4_096) || !boundedText(request.broker.audience) || request.grants.some((grant) => !boundedText(grant)) || new Set(request.grants).size !== request.grants.length) return issue("RUNNER_GRANT", "Broker authority and grants must be bounded and unique.", ["grants"]);
  if (request.resources.maxCostMicros !== undefined && !isUnsignedDecimal(request.resources.maxCostMicros) || request.resources.resourceClass !== undefined && !boundedText(request.resources.resourceClass) || [request.resources.maxTokens, request.resources.maxComputeMs, request.resources.memoryBytes].some((bound) => bound !== undefined && !safeCounter(bound))) return issue("RUNNER_RESOURCES", "Runner resource bounds must use safe counters and unsigned decimal cost.", ["resources"]);
  if (request.input.kind === "artifact") {
    const artifact = validateArtifactReference(request.input.artifact, ["input", "artifact"]);
    if (!artifact.ok) return artifact;
  } else if (encodedBytes(request.input.value) > FACTORY_LIMITS.maxInlineValueBytes) return issue("RUNNER_INLINE_BYTES", "Inline runner input exceeds 64 KiB.", ["input", "value"]);
  if (request.checkpoint !== undefined) {
    const checkpoint = validateArtifactReference(request.checkpoint, ["checkpoint"]);
    if (!checkpoint.ok || !safeCounter(request.checkpoint.journalCursor, -1)) return checkpoint.ok ? issue("RUNNER_CURSOR", "Checkpoint cursor must be a safe integer.", ["checkpoint", "journalCursor"]) : checkpoint;
  }
  const toolNames = new Set<string>();
  for (let index = 0; index < request.tools.length; index += 1) {
    const tool = request.tools[index]!;
    if (!boundedText(tool.name) || toolNames.has(tool.name) || tool.description !== undefined && !boundedText(tool.description, 4_096)) return issue("RUNNER_TOOL", "Tool declarations must have unique bounded names.", ["tools", index]);
    toolNames.add(tool.name);
    const input = validatePortSchema(tool.inputSchema);
    if (!input.ok) return issue("RUNNER_TOOL_SCHEMA", "Tool input schema is invalid.", ["tools", index, "inputSchema"]);
    if (tool.outputSchema !== undefined && !validatePortSchema(tool.outputSchema).ok) return issue("RUNNER_TOOL_SCHEMA", "Tool output schema is invalid.", ["tools", index, "outputSchema"]);
  }
  return { ok: true };
}

export function validateFactoryRunnerResult(value: unknown): ValidationResult {
  if (!isFactoryRunnerResult(value)) return issue("RUNNER_RESULT_SCHEMA", "Value does not match the generated FactoryRunnerResult schema.", []);
  const result = value as FactoryRunnerResult;
  const envelope = validateRunnerEnvelope(result, "result");
  if (!envelope.ok) return envelope;
  if (!safeCounter(result.journalCursor, -1)) return issue("RUNNER_CURSOR", "Result cursor must be a safe integer.", ["journalCursor"]);
  let previousIndex = -1;
  for (let index = 0; index < result.operations.length; index += 1) {
    const operation = result.operations[index]!;
    if (operation.operationIndex <= previousIndex) return issue("RUNNER_OPERATION_ORDER", "Operation results must be strictly ordered by index.", ["operations", index, "operationIndex"]);
    previousIndex = operation.operationIndex;
    const operationResult = validateOperation(operation, ["operations", index]);
    if (!operationResult.ok) return operationResult;
  }
  if (result.usage !== undefined) {
    const usage = validateUsage(result.usage, ["usage"]);
    if (!usage.ok) return usage;
  }
  if (result.workspaceCheckpoint !== undefined) {
    const checkpoint = validateArtifactReference(result.workspaceCheckpoint, ["workspaceCheckpoint"]);
    if (!checkpoint.ok || result.workspaceCheckpoint.journalCursor !== result.journalCursor) return checkpoint.ok ? issue("RUNNER_CURSOR", "Workspace checkpoint must match the result cursor.", ["workspaceCheckpoint", "journalCursor"]) : checkpoint;
  }
  if (result.status === "completed") {
    if (!validDigest(result.resultDigest, false)) return issue("RUNNER_DIGEST", "Completed result digest is invalid.", ["resultDigest"]);
    const output = validateArtifactReference(result.output, ["output"]);
    if (!output.ok) return output;
  } else if (result.status === "failed") {
    if (!validDigest(result.resultDigest, false) || !boundedText(result.error.code) || !boundedText(result.error.message, 4_096)) return issue("RUNNER_FAILURE", "Failed result needs a digest and structured bounded error.", ["error"]);
  } else if (result.status === "uncertain" && (!validDigest(result.providerReceiptDigest, false) || result.resultDigest !== undefined && !validDigest(result.resultDigest, false))) return issue("RUNNER_UNCERTAIN", "Uncertain result receipt or result digest is invalid.", ["providerReceiptDigest"]);
  return { ok: true };
}
