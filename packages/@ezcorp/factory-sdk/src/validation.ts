import { canonicalizeJson, isUnsignedDecimal, jsonEqual, unicodeLength, validateIJson } from "./canonical.js";
import { validateFactoryApiPayloadDigest } from "./api.js";
import { validateExpression } from "./expressions.js";
import { isCompiledExecutionManifest, isCompiledFactory, isCompiledPartitionArtifact, isFactoryApiRequest, isFactoryApiResponse, isFactoryRunnerRequest, isFactoryRunnerResult } from "./schema.js";
import {
  FACTORY_LIMITS,
  type CompiledExecutionManifest,
  type CompiledArtifactDescriptor,
  type CompiledFactory,
  type CompiledPartition,
  type CompiledPartitionArtifact,
  type CompiledPartitionInboundEdge,
  type CompiledPartitionOutboundEdge,
  type FactoryArtifactReference,
  type FactoryApiRequest,
  type FactoryApiResponse,
  type FactoryGraph,
  type FactoryNode,
  type FactoryRunnerOperationResult,
  type FactoryRunnerRequest,
  type FactoryRunnerResult,
  type FactoryTransportValue,
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

function compareInbound(left: CompiledPartitionInboundEdge, right: CompiledPartitionInboundEdge): number {
  return compareText(left.nodeId, right.nodeId) || compareText(left.fromNodeId, right.fromNodeId) || compareText(left.fromPartitionId, right.fromPartitionId);
}

function compareOutbound(left: CompiledPartitionOutboundEdge, right: CompiledPartitionOutboundEdge): number {
  return compareText(left.nodeId, right.nodeId) || compareText(left.toNodeId, right.toNodeId) || compareText(left.toPartitionId, right.toPartitionId);
}

function encodedBytes(value: JsonValue): number {
  return new TextEncoder().encode(canonicalizeJson(value)).byteLength;
}

function partitionPayload(partition: CompiledPartition, factory: CompiledFactory): CompiledPartitionArtifact {
  const { encodedBytes: _encodedBytes, digest: _digest, ...manifest } = partition;
  return {
    schemaVersion: "factory.partition.v1",
    factoryDigest: factory.digest,
    ...manifest,
    nodes: partition.nodeIds.map((id) => factory.indexes.nodeById[id]!),
  };
}

function executionManifest(factory: CompiledFactory): CompiledExecutionManifest {
  return {
    schemaVersion: "factory.execution-manifest.v1",
    factoryDigest: factory.digest,
    inputPorts: factory.definition.inputPorts,
    outputPorts: factory.definition.outputPorts,
    bounds: {
      runDeadlineMs: factory.definition.bounds.runDeadlineMs!,
      maxExpandedNodes: factory.definition.bounds.maxExpandedNodes,
      maxScopeDepth: factory.definition.bounds.maxScopeDepth,
    },
    outputs: factory.definition.graph.outputs,
  };
}

function graphNodes(root: FactoryGraph): readonly { readonly id: string; readonly node: FactoryNode; readonly value: JsonValue; readonly depth: number }[] {
  const result: { id: string; node: FactoryNode; value: JsonValue; depth: number }[] = [];
  const pending: { graph: FactoryGraph; depth: number }[] = [{ graph: root, depth: 1 }];
  while (pending.length > 0) {
    const { graph, depth } = pending.pop()!;
    for (let index = graph.nodes.length - 1; index >= 0; index -= 1) {
      const node = graph.nodes[index]!;
      result.push({ id: node.id, node, value: node as unknown as JsonValue, depth });
      if (node.kind === "branch") {
        pending.push({ graph: node.else, depth: depth + 1 }, { graph: node.then, depth: depth + 1 });
      } else if (node.kind === "map" || node.kind === "loop") {
        pending.push({ graph: node.body, depth: depth + 1 });
      }
    }
  }
  return result;
}

function expandedNodeCount(graph: FactoryGraph, limit: number): number {
  let count = 0;
  for (const node of graph.nodes) {
    count += 1;
    if (node.kind === "branch") count += Math.max(expandedNodeCount(node.then, limit), expandedNodeCount(node.else, limit));
    else if (node.kind === "map") count += node.maxItems * expandedNodeCount(node.body, limit);
    else if (node.kind === "loop") count += node.maxIterations * expandedNodeCount(node.body, limit);
    if (!Number.isSafeInteger(count) || count > limit) return limit + 1;
  }
  return count;
}

function validateSchemaRecord(record: Readonly<Record<string, PortSchema>>, path: readonly (string | number)[]): ValidationResult {
  for (const [name, schema] of Object.entries(record)) {
    const checked = validatePortSchema(schema);
    if (!checked.ok) return issue("COMPILED_PORT_SCHEMA", "Compiled port schema is outside the supported subset.", [...path, name]);
  }
  return { ok: true };
}

function sameKeys(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean {
  const leftKeys = Object.keys(left).sort(compareText);
  const rightKeys = Object.keys(right).sort(compareText);
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}

function validateNodeSemantics(factory: CompiledFactory, node: FactoryNode, depth: number): ValidationResult {
  if (depth > factory.definition.bounds.maxScopeDepth || depth > FACTORY_LIMITS.maxScopeDepth) return issue("COMPILED_SCOPE_DEPTH", "Compiled graph exceeds its scope-depth bound.", ["definition", "graph"]);
  const inputs = validateSchemaRecord(node.inputPorts ?? {}, ["indexes", "nodeById", node.id, "inputPorts"]);
  if (!inputs.ok) return inputs;
  const outputs = validateSchemaRecord(node.outputPorts ?? {}, ["indexes", "nodeById", node.id, "outputPorts"]);
  if (!outputs.ok) return outputs;
  if (node.deadlineMs !== undefined && (!safeCounter(node.deadlineMs, 1) || node.deadlineMs > FACTORY_LIMITS.maximumNodeDeadlineMs || node.deadlineMs > factory.definition.bounds.runDeadlineMs!)) return issue("COMPILED_NODE_DEADLINE", "Node deadline exceeds launch or run bounds.", ["indexes", "nodeById", node.id, "deadlineMs"]);
  if (node.retry !== undefined && (node.kind !== "task" || !safeCounter(node.retry.maxAttempts, 1) || node.retry.maxAttempts > 3 || !safeCounter(node.retry.initialDelayMs) || !safeCounter(node.retry.maximumDelayMs) || node.retry.maximumDelayMs < node.retry.initialDelayMs)) return issue("COMPILED_RETRY", "Compiled retry policy is invalid.", ["indexes", "nodeById", node.id, "retry"]);
  if (node.kind === "task" && node.maxIterations !== undefined && !safeCounter(node.maxIterations, 1)) return issue("COMPILED_TASK_BOUND", "Task iteration bound must be positive.", ["indexes", "nodeById", node.id, "maxIterations"]);
  if (node.kind === "branch") {
    if (!validateExpression(node.condition).ok || !sameKeys(node.then.outputs, node.outputPorts ?? {}) || !sameKeys(node.else.outputs, node.outputPorts ?? {})) return issue("COMPILED_BRANCH", "Branch expression and explicit outputs must be valid.", ["indexes", "nodeById", node.id]);
  } else if (node.kind === "map") {
    if (!safeCounter(node.maxItems) || node.maxItems > factory.definition.bounds.maxExpandedNodes || !safeCounter(node.maxConcurrency, 1) || node.maxConcurrency > FACTORY_LIMITS.maxConcurrentActivities || !validatePortSchema(node.itemSchema).ok || !sameKeys(node.body.outputs, node.outputPorts ?? {})) return issue("COMPILED_MAP", "Map bounds, item schema, or explicit outputs are invalid.", ["indexes", "nodeById", node.id]);
  } else if (node.kind === "loop") {
    if (!safeCounter(node.maxIterations, 1) || node.maxIterations > factory.definition.bounds.maxExpandedNodes || !safeCounter(node.maxElapsedMs, 1) || node.maxElapsedMs > factory.definition.bounds.runDeadlineMs! || !validatePortSchema(node.carriedSchema).ok || !validatePortSchema(node.resultSchema).ok || !validateExpression(node.until).ok || !validateExpression(node.nextInput).ok || !sameKeys(node.body.outputs, node.outputPorts ?? {})) return issue("COMPILED_LOOP", "Loop bounds, schemas, expressions, or explicit outputs are invalid.", ["indexes", "nodeById", node.id]);
  } else if (node.kind === "join") {
    if (node.predecessors.length === 0 || new Set(node.predecessors).size !== node.predecessors.length || Object.keys(node.outputPorts ?? {}).length !== 1 || !node.outputPorts?.winners) return issue("COMPILED_JOIN", "Join predecessors and winners output are invalid.", ["indexes", "nodeById", node.id]);
  } else if (node.kind === "approval") {
    if (!safeCounter(node.expiresInMs, 1) || node.expiresInMs > FACTORY_LIMITS.maximumApprovalWaitMs || node.choices.length === 0 || new Set(node.choices).size !== node.choices.length || Object.keys(node.outputPorts ?? {}).length !== 1 || !node.outputPorts?.choice) return issue("COMPILED_APPROVAL", "Approval bounds, choices, or choice output are invalid.", ["indexes", "nodeById", node.id]);
  } else if (node.kind === "acceptance" && node.maxRepairs !== undefined && (!safeCounter(node.maxRepairs) || node.maxRepairs >= factory.definition.bounds.maxExpandedNodes)) return issue("COMPILED_REPAIR", "Acceptance repair bound is invalid.", ["indexes", "nodeById", node.id, "maxRepairs"]);
  return { ok: true };
}

export function validateCompiledExecutionManifest(value: unknown, expectedFactoryDigest?: string, descriptor?: CompiledArtifactDescriptor): ValidationResult {
  if (!isCompiledExecutionManifest(value)) return issue("EXECUTION_MANIFEST_SCHEMA", "Value does not match the generated execution manifest schema.", []);
  const manifest = value as CompiledExecutionManifest;
  const bytes = encodedBytes(manifest as unknown as JsonValue);
  if (bytes > FACTORY_LIMITS.maxRecordedPageBytes || (descriptor !== undefined && descriptor.encodedBytes !== bytes)) return issue("EXECUTION_MANIFEST_BYTES", "Execution manifest bytes exceed or differ from its descriptor.", []);
  if (!validDigest(manifest.factoryDigest, true) || (expectedFactoryDigest !== undefined && manifest.factoryDigest !== expectedFactoryDigest) || (descriptor !== undefined && !validDigest(descriptor.digest, true))) return issue("EXECUTION_MANIFEST_DIGEST", "Execution manifest digests are invalid or refer to another factory.", ["factoryDigest"]);
  const inputs = validateSchemaRecord(manifest.inputPorts, ["inputPorts"]);
  if (!inputs.ok) return inputs;
  const outputs = validateSchemaRecord(manifest.outputPorts, ["outputPorts"]);
  if (!outputs.ok) return outputs;
  if (!safeCounter(manifest.bounds.runDeadlineMs, 1) || manifest.bounds.runDeadlineMs > FACTORY_LIMITS.maximumRunDeadlineMs || !safeCounter(manifest.bounds.maxExpandedNodes, 1) || manifest.bounds.maxExpandedNodes > FACTORY_LIMITS.maxExpandedNodes || !safeCounter(manifest.bounds.maxScopeDepth, 1) || manifest.bounds.maxScopeDepth > FACTORY_LIMITS.maxScopeDepth || !sameKeys(manifest.outputPorts, manifest.outputs)) return issue("EXECUTION_MANIFEST_BOUND", "Execution manifest bounds and output bindings must match launch limits.", ["bounds"]);
  return { ok: true };
}

export function validateCompiledPartitionArtifact(value: unknown, expectedFactoryDigest?: string, partition?: CompiledPartition): ValidationResult {
  if (!isCompiledPartitionArtifact(value)) return issue("PARTITION_ARTIFACT_SCHEMA", "Value does not match the generated partition artifact schema.", []);
  const artifact = value as CompiledPartitionArtifact;
  const bytes = encodedBytes(artifact as unknown as JsonValue);
  if (bytes > FACTORY_LIMITS.maxRecordedPageBytes || (partition !== undefined && partition.encodedBytes !== bytes)) return issue("PARTITION_ARTIFACT_BYTES", "Partition artifact bytes exceed or differ from its manifest.", []);
  if (!validDigest(artifact.factoryDigest, true) || (expectedFactoryDigest !== undefined && artifact.factoryDigest !== expectedFactoryDigest) || (partition !== undefined && !validDigest(partition.digest, true))) return issue("PARTITION_ARTIFACT_DIGEST", "Partition digests are invalid or refer to another factory.", ["factoryDigest"]);
  if (!boundedText(artifact.id) || artifact.nodeIds.length === 0 || artifact.nodeIds.length > FACTORY_LIMITS.maxPartitionNodes || artifact.nodes.length !== artifact.nodeIds.length || !isSortedUnique(artifact.dependsOn)) return issue("PARTITION_ARTIFACT_MANIFEST", "Partition identity, node count, or dependencies are invalid.", []);
  const nodeIds = new Set<string>();
  for (let index = 0; index < artifact.nodes.length; index += 1) {
    const id = artifact.nodeIds[index]!;
    if (!boundedText(id) || id.includes("/") || nodeIds.has(id) || artifact.nodes[index]!.id !== id) return issue("PARTITION_ARTIFACT_NODE", "Partition nodes must exactly match unique bounded node IDs.", ["nodes", index]);
    nodeIds.add(id);
  }
  const sortedInbound = [...artifact.inbound].sort(compareInbound);
  const sortedOutbound = [...artifact.outbound].sort(compareOutbound);
  const invalidInbound = artifact.inbound.some((edge, index) => !nodeIds.has(edge.nodeId) || nodeIds.has(edge.fromNodeId) || !artifact.dependsOn.includes(edge.fromPartitionId) || !boundedText(edge.fromNodeId) || !boundedText(edge.fromPartitionId) || (index > 0 && compareInbound(artifact.inbound[index - 1]!, edge) >= 0));
  const invalidOutbound = artifact.outbound.some((edge, index) => !nodeIds.has(edge.nodeId) || nodeIds.has(edge.toNodeId) || edge.toPartitionId === artifact.id || !boundedText(edge.toNodeId) || !boundedText(edge.toPartitionId) || (index > 0 && compareOutbound(artifact.outbound[index - 1]!, edge) >= 0));
  if (!jsonEqual(artifact.inbound as unknown as JsonValue, sortedInbound as unknown as JsonValue) || !jsonEqual(artifact.outbound as unknown as JsonValue, sortedOutbound as unknown as JsonValue) || invalidInbound || invalidOutbound) return issue("PARTITION_ARTIFACT_EDGES", "Partition boundary edges must be canonical and anchored to local nodes.", ["inbound"]);
  if (partition !== undefined) {
    const { encodedBytes: _encodedBytes, digest: _digest, ...expected } = partition;
    const { schemaVersion: _schemaVersion, factoryDigest: _factoryDigest, nodes: _nodes, ...actual } = artifact;
    if (!jsonEqual(actual as unknown as JsonValue, expected as unknown as JsonValue)) return issue("PARTITION_ARTIFACT_MANIFEST", "Partition artifact differs from its compiled manifest.", []);
  }
  return { ok: true };
}

/**
 * Workflow-safe validation for an already compiled artifact. It checks the
 * generated schema and every bounded manifest relationship without hashing.
 */
export function validateCompiledFactory(value: unknown): ValidationResult {
  if (!isCompiledFactory(value)) return issue("COMPILED_SCHEMA", "Value does not match the generated CompiledFactory schema.", []);
  const factory = value as CompiledFactory;
  if (!validDigest(factory.digest, true) || (factory.presentationDigest !== undefined && !validDigest(factory.presentationDigest, true))) return issue("COMPILED_DIGEST", "Compiled digests must be lowercase sha256 values.", ["digest"]);
  if (encodedBytes(factory as unknown as JsonValue) > FACTORY_LIMITS.maxDefinitionBytes) return issue("COMPILED_BYTES", "Compiled IR exceeds 16 MiB.", []);
  if (!safeCounter(factory.definition.bounds.maxExpandedNodes, 1) || factory.definition.bounds.maxExpandedNodes > FACTORY_LIMITS.maxExpandedNodes || !safeCounter(factory.definition.bounds.maxScopeDepth, 1) || factory.definition.bounds.maxScopeDepth > FACTORY_LIMITS.maxScopeDepth || !safeCounter(factory.definition.bounds.runDeadlineMs!, 1) || factory.definition.bounds.runDeadlineMs! > FACTORY_LIMITS.maximumRunDeadlineMs) return issue("COMPILED_BOUND", "Compiled definition bounds exceed launch limits.", ["definition", "bounds"]);
  if ((factory.definition.presentation === undefined) !== (factory.presentationDigest === undefined)) return issue("COMPILED_PRESENTATION", "Presentation content and digest must be present together.", ["presentationDigest"]);

  const expectedLock = {
    packages: [...factory.definition.packages].sort((left, right) => compareText(left.name, right.name)),
    factories: [...(factory.definition.factories ?? [])].sort((left, right) => compareText(left.id, right.id)),
    interpreter: factory.definition.interpreterCompatibility,
  } as unknown as JsonValue;
  if (!jsonEqual(factory.lock as unknown as JsonValue, expectedLock)) return issue("COMPILED_LOCK", "Dependency lock does not match the embedded definition.", ["lock"]);

  const nodes = graphNodes(factory.definition.graph);
  if (nodes.length > FACTORY_LIMITS.maxExpandedNodes || expandedNodeCount(factory.definition.graph, factory.definition.bounds.maxExpandedNodes) > factory.definition.bounds.maxExpandedNodes) return issue("COMPILED_NODES", "Compiled node expansion exceeds launch limits.", ["indexes", "nodeById"]);
  const inputSchemas = validateSchemaRecord(factory.definition.inputPorts, ["definition", "inputPorts"]);
  if (!inputSchemas.ok) return inputSchemas;
  const outputSchemas = validateSchemaRecord(factory.definition.outputPorts, ["definition", "outputPorts"]);
  if (!outputSchemas.ok) return outputSchemas;
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (!boundedText(node.id) || node.id.includes("/") || nodeIds.has(node.id)) return issue("COMPILED_NODE_ID", "Compiled node IDs must be bounded unique instance-path segments.", ["indexes", "nodeById", node.id]);
    nodeIds.add(node.id);
    if (!own(factory.indexes.nodeById, node.id) || !jsonEqual(factory.indexes.nodeById[node.id] as unknown as JsonValue, node.value)) return issue("COMPILED_NODE_INDEX", "Node index differs from the embedded graph.", ["indexes", "nodeById", node.id]);
    const semantics = validateNodeSemantics(factory, node.node, node.depth);
    if (!semantics.ok) return semantics;
  }
  const indexKeys = Object.keys(factory.indexes.nodeById);
  const successorKeys = Object.keys(factory.indexes.successors);
  const dependencyKeys = Object.keys(factory.indexes.dependencyCounts);
  if (indexKeys.length !== nodeIds.size || successorKeys.length !== nodeIds.size || dependencyKeys.length !== nodeIds.size || [...indexKeys, ...successorKeys, ...dependencyKeys].some((id) => !nodeIds.has(id))) return issue("COMPILED_INDEX_KEYS", "Every compiled index must contain exactly the graph node IDs.", ["indexes"]);
  const expectedSuccessors = new Map<string, string[]>([...nodeIds].map((id) => [id, []]));
  const dependencies = new Map<string, readonly string[]>();
  for (const { node } of nodes) {
    const declared = [...(node.dependsOn ?? []), ...(node.kind === "join" ? node.predecessors : [])];
    if (new Set(declared).size !== declared.length || declared.some((id) => id === node.id || !nodeIds.has(id))) return issue("COMPILED_DEPENDENCIES", "Declared dependencies must be unique existing nodes.", ["indexes", "dependencyCounts", node.id]);
    dependencies.set(node.id, declared);
    for (const dependency of declared) expectedSuccessors.get(dependency)!.push(node.id);
  }
  for (const id of nodeIds) {
    const successors = factory.indexes.successors[id] as readonly string[];
    const expected = expectedSuccessors.get(id)!.sort(compareText);
    if (!isSortedUnique(successors) || successors.length !== expected.length || successors.some((successor, index) => successor !== expected[index])) return issue("COMPILED_SUCCESSORS", "Successor indexes must exactly match declared graph edges.", ["indexes", "successors", id]);
  }
  for (const id of nodeIds) if (!safeCounter(factory.indexes.dependencyCounts[id] as number) || factory.indexes.dependencyCounts[id] !== dependencies.get(id)!.length) return issue("COMPILED_DEPENDENCIES", "Dependency counts do not match declared graph edges.", ["indexes", "dependencyCounts", id]);
  const checkedManifest = validateCompiledExecutionManifest(executionManifest(factory), factory.digest, factory.executionManifest);
  if (!checkedManifest.ok) return issue("COMPILED_EXECUTION_MANIFEST", "Compiled execution manifest is invalid.", ["executionManifest"]);

  const partitionNodeIds = new Set(factory.definition.graph.nodes.map((node) => node.id));
  const partitionByNode = new Map<string, string>();
  const partitionIds = new Set<string>();
  for (let index = 0; index < factory.partitions.length; index += 1) {
    const partition = factory.partitions[index]!;
    if (partition.id !== `partition-${index}` || partitionIds.has(partition.id) || partition.nodeIds.length === 0 || partition.nodeIds.length > FACTORY_LIMITS.maxPartitionNodes || !safeCounter(partition.encodedBytes, 2) || partition.encodedBytes > FACTORY_LIMITS.maxRecordedPageBytes || !validDigest(partition.digest, true)) return issue("COMPILED_PARTITION", "Partitions need canonical IDs, bytes, digests, and bounded nonempty node lists.", ["partitions", index]);
    partitionIds.add(partition.id);
    if (!isSortedUnique(partition.dependsOn)) return issue("COMPILED_PARTITION_DEPENDENCIES", "Partition dependencies must be sorted and unique.", ["partitions", index, "dependsOn"]);
    for (const dependency of partition.dependsOn) {
      const dependencyIndex = factory.partitions.findIndex((candidate) => candidate.id === dependency);
      if (dependencyIndex < 0 || dependencyIndex >= index) return issue("COMPILED_PARTITION_DEPENDENCIES", "Partition dependencies must point to an earlier partition.", ["partitions", index, "dependsOn"]);
    }
    for (const id of partition.nodeIds) {
      if (!partitionNodeIds.has(id) || partitionByNode.has(id)) return issue("COMPILED_PARTITION_NODE", "Each top-level compiled node must occur in one partition.", ["partitions", index, "nodeIds"]);
      partitionByNode.set(id, partition.id);
    }
  }
  if (partitionByNode.size !== partitionNodeIds.size) return issue("COMPILED_PARTITION_COVERAGE", "Partitions must cover every top-level compiled node.", ["partitions"]);
  const inboundByPartition = new Map<string, CompiledPartitionInboundEdge[]>(factory.partitions.map(({ id }) => [id, []]));
  const outboundByPartition = new Map<string, CompiledPartitionOutboundEdge[]>(factory.partitions.map(({ id }) => [id, []]));
  for (let index = 0; index < factory.partitions.length; index += 1) {
    const partition = factory.partitions[index]!;
    const expected = new Set<string>();
    for (const nodeId of partition.nodeIds) for (const dependency of dependencies.get(nodeId) ?? []) {
      const dependencyPartition = partitionByNode.get(dependency)!;
      if (dependencyPartition !== partition.id) {
        expected.add(dependencyPartition);
        inboundByPartition.get(partition.id)!.push({ nodeId, fromNodeId: dependency, fromPartitionId: dependencyPartition });
        outboundByPartition.get(dependencyPartition)!.push({ nodeId: dependency, toNodeId: nodeId, toPartitionId: partition.id });
      }
    }
    const expectedIds = [...expected].sort(compareText);
    if (partition.dependsOn.length !== expectedIds.length || partition.dependsOn.some((id, dependencyIndex) => id !== expectedIds[dependencyIndex])) return issue("COMPILED_PARTITION_DEPENDENCIES", "Partition dependencies must exactly match cross-partition graph edges.", ["partitions", index, "dependsOn"]);
  }
  for (let index = 0; index < factory.partitions.length; index += 1) {
    const partition = factory.partitions[index]!;
    const inbound = inboundByPartition.get(partition.id)!.sort(compareInbound);
    const outbound = outboundByPartition.get(partition.id)!.sort(compareOutbound);
    if (!jsonEqual(partition.inbound as unknown as JsonValue, inbound as unknown as JsonValue) || !jsonEqual(partition.outbound as unknown as JsonValue, outbound as unknown as JsonValue)) return issue("COMPILED_PARTITION_EDGES", "Partition edge manifests must exactly match cross-partition graph edges.", ["partitions", index]);
    if (partition.encodedBytes !== encodedBytes(partitionPayload(partition, factory) as unknown as JsonValue)) return issue("COMPILED_PARTITION_BYTES", "Partition bytes must exactly match its canonical manifest and node records.", ["partitions", index, "encodedBytes"]);
  }

  const pagedNodes = new Map<string, string[]>();
  const pageIds = new Set<string>();
  for (let index = 0; index < factory.pages.length; index += 1) {
    const page = factory.pages[index]!;
    if (page.id !== `page-${index}` || pageIds.has(page.id) || !partitionIds.has(page.partitionId) || page.nodeIds.length === 0 || !safeCounter(page.encodedBytes, 2) || page.encodedBytes > FACTORY_LIMITS.maxRecordedPageBytes || !validDigest(page.digest, true)) return issue("COMPILED_PAGE", "Pages need canonical IDs, bounded bytes, valid digests, and a partition.", ["pages", index]);
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

function validateRunnerReference(reference: FactoryRunnerRequest["runner"], path: readonly (string | number)[]): ValidationResult {
  if (!boundedText(reference.package) || !boundedText(reference.export) || !boundedText(reference.version) || reference.version === "latest" || reference.version.includes("*") || !validDigest(reference.digest, true)) {
    return issue("RUNNER_PIN", "Runner package, exact version, export, and digest are required.", path);
  }
  if (reference.model !== undefined && !boundedText(reference.model)) return issue("RUNNER_MODEL_PIN", "Runner model must be a bounded identity.", [...path, "model"]);
  if (reference.configurationDigest !== undefined && !validDigest(reference.configurationDigest, true)) return issue("RUNNER_MODEL_PIN", "Runner configuration digest must be a prefixed lowercase sha256 value.", [...path, "configurationDigest"]);
  return { ok: true };
}

function validateUsage(usage: FactoryUsage, path: readonly (string | number)[]): ValidationResult {
  if (usage.kind === "unknown") return boundedText(usage.reason, 1_024) && isUnsignedDecimal(usage.heldCostMicros) ? { ok: true } : issue("RUNNER_USAGE", "Unknown usage needs a reason and unsigned held cost.", path);
  return safeCounter(usage.inputTokens) && safeCounter(usage.outputTokens) && safeCounter(usage.computeMs) && isUnsignedDecimal(usage.costMicros) ? { ok: true } : issue("RUNNER_USAGE", "Measured usage counters and cost must be nonnegative integers.", path);
}

function validateOperation(operation: FactoryRunnerOperationResult, path: readonly (string | number)[]): ValidationResult {
  const resultDigestInvalid = operation.state === "uncertain"
    ? operation.resultDigest !== undefined && !validDigest(operation.resultDigest, false)
    : !validDigest(operation.resultDigest, false);
  if (!boundedText(operation.operationId, 1_024) || !operation.operationId.endsWith(`:${operation.operationIndex}`) || !safeCounter(operation.operationIndex) || !validDigest(operation.requestDigest, false) || resultDigestInvalid || operation.providerReceiptDigest !== undefined && !validDigest(operation.providerReceiptDigest, false)) return issue("RUNNER_OPERATION", "Runner operation identity or digest is invalid.", path);
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
  const runner = validateRunnerReference(request.runner, ["runner"]);
  if (!runner.ok) return runner;
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
  const expectedOperationIndex = (request.checkpoint?.journalCursor ?? -1) + 1;
  if (request.authority.nextOperationIndex !== expectedOperationIndex) return issue("RUNNER_CURSOR", "Next operation index must continue the supplied checkpoint.", ["authority", "nextOperationIndex"]);
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
    if (operation.state === "uncertain" ? operation.operationIndex <= result.journalCursor : operation.operationIndex > result.journalCursor) return issue("RUNNER_OPERATION_CURSOR", "Settled operations cannot exceed the cursor and uncertain operations cannot advance it.", ["operations", index, "operationIndex"]);
    if (operation.state === "completed" && operation.workspaceCheckpoint.journalCursor !== operation.operationIndex) return issue("RUNNER_OPERATION_CURSOR", "Completed operation checkpoint must equal its operation index.", ["operations", index, "workspaceCheckpoint", "journalCursor"]);
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

function validateApiPreconditions(request: Extract<FactoryApiRequest, { preconditions: unknown }>): ValidationResult {
  const { idempotencyKey, expectedRevision } = request.preconditions;
  if (!boundedText(idempotencyKey, FACTORY_LIMITS.maxApiIdempotencyKeyLength)) return issue("API_IDEMPOTENCY_KEY", "Idempotency-Key must be a nonempty bounded value without control characters.", ["preconditions", "idempotencyKey"]);
  if (!validDigest(request.preconditions.payloadDigest, false)) return issue("API_PAYLOAD_DIGEST", "Mutation payload digest must be lowercase sha256.", ["preconditions", "payloadDigest"]);
  const allowsZero = request.kind === "draft.create" || request.kind === "draft.import" || request.kind === "grant.set" || request.kind === "run.start" || request.kind === "service-credential.issue" || request.kind === "release.trust.publish" || request.kind === "release.control.set" || request.kind === "release.contract.put" || request.kind === "release.prepare" || request.kind === "release.approval.request" || request.kind === "release.approval.decide" || request.kind === "release.policy.put";
  if (!safeCounter(expectedRevision, allowsZero ? 0 : 1) || (!allowsZero && expectedRevision === 0)) return issue("API_EXPECTED_REVISION", "If-Match must contain a supported safe revision.", ["preconditions", "expectedRevision"]);
  if ((request.kind === "draft.create" || request.kind === "draft.import" || request.kind === "run.start" || request.kind === "release.prepare" || request.kind === "release.approval.decide" || request.kind === "release.policy.put") && expectedRevision !== 0) return issue("API_EXPECTED_REVISION", "Resource creation or pending-state mutation requires revision 0.", ["preconditions", "expectedRevision"]);
  return { ok: true };
}

function validateApiPath(request: FactoryApiRequest): ValidationResult {
  for (const [key, value] of Object.entries(request.path)) {
    if ((key.endsWith("Id") || key === "version") && (!boundedText(value as string, FACTORY_LIMITS.maxApiIdentifierLength) || (value as string).includes("\0"))) return issue("API_PATH_IDENTITY", "Path identity must be nonempty, bounded, and free of control characters.", ["path", key]);
  }
  return { ok: true };
}

function validateApiTransportValues(parameters: Readonly<Record<string, FactoryTransportValue>>, path: readonly (string | number)[] = ["body", "parameters"]): ValidationResult {
  for (const [name, transport] of Object.entries(parameters)) {
    if (!boundedText(name, FACTORY_LIMITS.maxApiIdentifierLength)) return issue("API_PARAMETER_NAME", "Parameter names must be nonempty bounded values.", [...path, name]);
    if (transport.kind === "inline") {
      if (encodedBytes(transport.value) > FACTORY_LIMITS.maxInlineValueBytes) return issue("API_PARAMETER_BYTES", "Inline parameter exceeds 64 KiB.", [...path, name]);
    } else {
      const artifact = validateArtifactReference(transport.artifact, [...path, name, "artifact"]);
      if (!artifact.ok) return artifact;
    }
  }
  return { ok: true };
}

/** Strict, workflow-safe validation for trusted C09 route inputs. */
export function validateFactoryApiRequest(value: unknown): ValidationResult {
  if (!isFactoryApiRequest(value)) return issue("API_REQUEST_SCHEMA", "Value does not match the generated FactoryApiRequest schema.", []);
  const request = value as FactoryApiRequest;
  const path = validateApiPath(request);
  if (!path.ok) return path;
  if ("query" in request) {
    const query = request.query as { cursor?: string; search?: string };
    if ((query.cursor !== undefined && !boundedText(query.cursor, 2_048)) || (query.search !== undefined && !boundedText(query.search, FACTORY_LIMITS.maxApiIdentifierLength))) return issue("API_QUERY", "Cursor and search values must be bounded and free of control characters.", ["query"]);
  }
  if ("preconditions" in request) {
    const preconditions = validateApiPreconditions(request);
    if (!preconditions.ok) return preconditions;
  }
  if ((request.kind === "draft.update" || request.kind === "draft.validate") && request.body.source.id !== request.path.factoryId) return issue("API_FACTORY_ID", "The definition ID must match the trusted factory path.", ["body", "source", "id"]);
  if ((request.kind === "draft.create" || request.kind === "draft.update" || request.kind === "draft.validate") && encodedBytes(request.body.source as unknown as JsonValue) > FACTORY_LIMITS.maxDefinitionBytes) return issue("API_DEFINITION_BYTES", "Factory definition exceeds 16 MiB.", ["body", "source"]);
  if (request.kind === "draft.import" && new TextEncoder().encode(request.body.source).byteLength > FACTORY_LIMITS.maxDefinitionBytes) return issue("API_IMPORT_BYTES", "Imported source exceeds 16 MiB.", ["body", "source"]);
  if (request.kind === "run.start") {
    if (!validDigest(request.body.definitionDigest, true)) return issue("API_DEFINITION_DIGEST", "Run start needs a prefixed lowercase sha256 definition digest.", ["body", "definitionDigest"]);
    if (!boundedText(request.body.factoryVersion, FACTORY_LIMITS.maxApiIdentifierLength)) return issue("API_VERSION", "Run start needs a bounded factory version.", ["body", "factoryVersion"]);
    const parameters = validateApiTransportValues(request.body.parameters);
    if (!parameters.ok) return parameters;
    if (encodedBytes(request as unknown as JsonValue) > FACTORY_LIMITS.maxWireBytes) return issue("API_RUN_START_BYTES", "Run start exceeds the 64 KiB durable command bound.", []);
  }
  if (request.kind === "run.control" && request.body.action !== "cancel") {
    if (!boundedText(request.body.nodeId, FACTORY_LIMITS.maxApiIdentifierLength)) return issue("API_CONTROL_NODE", "Repair and replan need a bounded node target.", ["body", "nodeId"]);
    const parameters = validateApiTransportValues(request.body.parameters, ["body", "parameters"]);
    if (!parameters.ok) return parameters;
  }
  if (request.kind === "run.control" && encodedBytes(request as unknown as JsonValue) > FACTORY_LIMITS.maxWireBytes) return issue("API_CONTROL_BYTES", "Run control exceeds the 64 KiB durable command bound.", []);
  if (request.kind === "approval.decide" && !validDigest(request.body.contextDigest, false)) return issue("API_CONTEXT_DIGEST", "Approval decision needs a lowercase sha256 context digest.", ["body", "contextDigest"]);
  if (request.kind === "grant.set" && request.path.principalKind === "service" && request.body.expiresAtMs === null) return issue("API_GRANT_EXPIRY", "Service grants require an expiry.", ["body", "expiresAtMs"]);
  if (request.kind === "service-credential.issue") {
    const order = ["read", "write", "chat"] as const;
    const canonical = order.filter(scope => request.body.scopes.includes(scope));
    if (request.preconditions.expectedRevision !== 0) return issue("API_EXPECTED_REVISION", "Credential issuance requires revision zero.", ["preconditions", "expectedRevision"]);
    if (request.body.expiresAtMs % 1_000 !== 0) return issue("API_CREDENTIAL_EXPIRY", "Credential expiry must be a whole second.", ["body", "expiresAtMs"]);
    if (new Set(request.body.scopes).size !== request.body.scopes.length
      || request.body.scopes.some((scope, index) => canonical[index] !== scope)) {
      return issue("API_CREDENTIAL_SCOPES", "Credential scopes must be unique and in canonical order.", ["body", "scopes"]);
    }
  }
  if (request.kind === "release.trust.publish") {
    const runner = validateRunnerReference(request.body.packageLock, ["body", "packageLock"]);
    if (!runner.ok) return runner;
    if (!validDigest(request.body.validatorTrustDigest, true)) return issue("API_RELEASE_TRUST_DIGEST", "Release trust needs a prefixed lowercase sha256 validator digest.", ["body", "validatorTrustDigest"]);
  }
  if (request.kind === "release.contract.put") {
    if (!validDigest(request.body.contractDigest, true) || !validDigest(request.body.validatorLockDigest, true)) return issue("API_RELEASE_CONTRACT_DIGEST", "Release contract digests must be prefixed lowercase sha256 values.", ["body"]);
    const claimIds = new Set(request.body.mandatoryClaims.map(claim => claim.id));
    if (claimIds.size !== request.body.mandatoryClaims.length || request.body.mandatoryClaims.some(claim => !boundedText(claim.id) || !boundedText(claim.validatorId) || !safeCounter(claim.freshnessMs, 1))) return issue("API_RELEASE_CONTRACT_CLAIM", "Release contract claims must be unique, bounded, and fresh for a positive interval.", ["body", "mandatoryClaims"]);
    const groupIds = new Set(request.body.claimGroups.map(group => group.id));
    if (groupIds.size !== request.body.claimGroups.length || request.body.claimGroups.some(group => !boundedText(group.id) || group.minimumPasses < 1 || group.minimumPasses > group.claimIds.length || group.claimIds.some(id => !claimIds.has(id)))) return issue("API_RELEASE_CONTRACT_GROUP", "Release contract groups must be unique and reference valid claims.", ["body", "claimGroups"]);
  }
  if (request.kind === "release.prepare") {
    if (!validDigest(request.body.candidateDigest, true) || !safeCounter(request.body.candidateGeneration) || !safeCounter(request.body.estimatedSpendMicros) || !safeCounter(request.body.deadlineMs, 1) || encodedBytes(request.body.request) > 1_048_576) return issue("API_RELEASE_PREPARE", "Release preparation needs an exact candidate, bounded counters, and a request no larger than 1 MiB.", ["body"]);
  }
  if (request.kind === "release.approval.decide" && !validDigest(request.body.contextDigest, false)) return issue("API_CONTEXT_DIGEST", "Release approval needs a lowercase sha256 context digest.", ["body", "contextDigest"]);
  if (request.kind === "release.policy.put" && (!validDigest(request.body.contractDigest, true) || !safeCounter(request.body.maxOperations, 1) || !safeCounter(request.body.maxSpendMicros) || !safeCounter(request.body.expiresAtMs, 1))) return issue("API_RELEASE_POLICY", "Release policy bounds and contract digest are invalid.", ["body"]);
  if (request.kind === "release.reconcile") {
    if (request.preconditions.expectedRevision < 1 || request.body.providerEvidence === null || typeof request.body.providerEvidence !== "object" || Array.isArray(request.body.providerEvidence) || Object.keys(request.body.providerEvidence).length === 0 || encodedBytes(request.body.providerEvidence) > 1_048_576) return issue("API_RELEASE_RECONCILIATION", "Reconciliation needs an executing generation and bounded structured provider evidence.", ["body"]);
    if ((request.body.action === "attach_receipt") !== (request.body.receipt !== undefined)) return issue("API_RELEASE_RECONCILIATION", "Only receipt attachment accepts an exact provider receipt.", ["body", "receipt"]);
    if (request.body.receipt !== undefined && !validReleaseReceipt(request.body.receipt)) return issue("API_RELEASE_RECONCILIATION", "The provider receipt is invalid.", ["body", "receipt"]);
  }
  const payloadDigest = "preconditions" in request ? validateFactoryApiPayloadDigest(request) : { ok: true } as const;
  if (!payloadDigest.ok) return payloadDigest;
  return { ok: true };
}

function validDraftSummary(resource: { availability: string; availabilityReason?: string; sourceDigest: string }): boolean {
  return validDigest(resource.sourceDigest, false)
    && (resource.availability === "unavailable" ? boundedText(resource.availabilityReason ?? "", 2_048) : resource.availabilityReason === undefined);
}

function validApprovalResource(resource: Extract<FactoryApiResponse, { kind: "approval.resource" }>["resource"]): boolean {
  const decided = resource.status === "approved" || resource.status === "denied";
  return validDigest(resource.contextDigest, false) && decided === (resource.decidedBy !== undefined && resource.decidedAtMs !== undefined);
}

function validReleaseNotification(resource: Extract<FactoryApiResponse, { kind: "release.notification.page" }>["page"]["items"][number]): boolean {
  if (resource.kind === "approval_requested") return validDigest(resource.contextDigest, false) && safeCounter(resource.expiresAtMs, 1);
  return safeCounter(resource.dispatchGeneration, 1) && boundedText(resource.outcomeCode);
}

function validServiceCredentialToken(token: string): boolean {
  if (!token.startsWith("ezkfsvc_")) return false;
  const parts = token.slice(8).split(".");
  return parts.length === 3 && parts.every(part => part.length > 0 && [...part].every(character =>
    character >= "A" && character <= "Z" || character >= "a" && character <= "z"
    || character >= "0" && character <= "9" || character === "_" || character === "-"));
}

function validVersion(resource: Extract<FactoryApiResponse, { kind: "version.summary" }>["resource"]): boolean {
  return validDigest(resource.definitionDigest, true)
    && validDigest(resource.compiledBlobDigest, false)
    && safeCounter(resource.compiledBytes, 1)
    && resource.compiledBytes <= FACTORY_LIMITS.maxDefinitionBytes;
}

function validReleaseReceipt(receipt: { requestDigest: string; effectDigest: string; dispatchGeneration: number }): boolean {
  return validDigest(receipt.requestDigest, true) && validDigest(receipt.effectDigest, true) && safeCounter(receipt.dispatchGeneration, 1);
}

function validReleaseOperation(resource: Extract<FactoryApiResponse, { kind: "release.operation.resource" }>["resource"]): boolean {
  return validDigest(resource.candidateDigest, true) && validDigest(resource.contractDigest, true)
    && validDigest(resource.destinationDigest, true) && validDigest(resource.requestDigest, true)
    && safeCounter(resource.candidateGeneration) && safeCounter(resource.executionEpoch, 1)
    && safeCounter(resource.cancellationEpoch) && safeCounter(resource.releaseEnableEpoch, 1)
    && safeCounter(resource.dispatchGeneration) && (resource.receipt === undefined || validReleaseReceipt(resource.receipt));
}

/** Strict, workflow-safe validation for C09 route responses. */
export function validateFactoryApiResponse(value: unknown): ValidationResult {
  if (!isFactoryApiResponse(value)) return issue("API_RESPONSE_SCHEMA", "Value does not match the generated FactoryApiResponse schema.", []);
  const response = value as FactoryApiResponse;
  if (response.kind === "draft.summary" || response.kind === "draft.details") {
    if (!validDraftSummary(response.resource)) return issue("API_DRAFT_RESOURCE", "Draft digest or availability detail is invalid.", ["resource"]);
    if (response.kind === "draft.details" && response.resource.source.id !== response.resource.factoryId) return issue("API_FACTORY_ID", "Draft definition ID must match its resource ID.", ["resource", "source", "id"]);
  }
  if (response.kind === "draft.page" && response.page.items.some((item) => !validDraftSummary(item))) return issue("API_DRAFT_RESOURCE", "Draft page contains an invalid digest or availability detail.", ["page", "items"]);
  if ((response.kind === "version.summary" || response.kind === "version.details") && !validVersion(response.resource)) return issue("API_VERSION_DIGEST", "Published version digests and artifacts must be valid.", ["resource"]);
  if (response.kind === "version.details" && (response.resource.source.id !== response.resource.factoryId || response.resource.source.version !== response.resource.version)) return issue("API_VERSION_IDENTITY", "Published definition identity must match its version resource.", ["resource", "source"]);
  if (response.kind === "version.page" && response.page.items.some((item) => !validVersion(item))) return issue("API_VERSION_DIGEST", "Published version page contains an invalid digest or artifact.", ["page", "items"]);
  if (response.kind === "run.details" && !validDigest(response.resource.definitionDigest, true)) return issue("API_RUN_DIGEST", "Run definition digest must be prefixed lowercase sha256.", ["resource", "definitionDigest"]);
  if (response.kind === "run.details") {
    const parameters = validateApiTransportValues(response.resource.parameters, ["resource", "parameters"]);
    if (!parameters.ok) return parameters;
    if (response.resource.output !== undefined) {
      const output = validateApiTransportValues({ output: response.resource.output }, ["resource"]);
      if (!output.ok) return output;
    }
  }
  if (response.kind === "run.page" && response.page.items.some((item) => !validDigest(item.definitionDigest, true))) return issue("API_RUN_DIGEST", "Run page contains an invalid definition digest.", ["page", "items"]);
  if (response.kind === "approval.resource") {
    if (!validApprovalResource(response.resource)) return issue("API_APPROVAL_RESOURCE", "Approval context and decision evidence are inconsistent.", ["resource"]);
  }
  if (response.kind === "approval.page" && response.page.items.some((item) => !validApprovalResource(item))) return issue("API_APPROVAL_RESOURCE", "Approval page contains inconsistent context or decision evidence.", ["page", "items"]);
  if (response.kind === "grant.resource" && response.resource.principalKind === "service" && response.resource.expiresAtMs === null) return issue("API_GRANT_EXPIRY", "Service grant resources require an expiry.", ["resource", "expiresAtMs"]);
  if (response.kind === "grant.page" && response.page.items.some((item) => item.principalKind === "service" && item.expiresAtMs === null)) return issue("API_GRANT_EXPIRY", "Service grant page contains a missing expiry.", ["page", "items"]);
  if (response.kind === "service-credential.issued" || response.kind === "service-credential.resource") {
    const resource = response.resource;
    const canonical = ["read", "write", "chat"].filter(scope => resource.scopes.includes(scope as typeof resource.scopes[number]));
    if (resource.scopes.length !== new Set(resource.scopes).size || resource.scopes.some((scope, index) => scope !== canonical[index])
      || resource.issuedAtMs % 1_000 !== 0 || resource.expiresAtMs % 1_000 !== 0 || resource.expiresAtMs <= resource.issuedAtMs) {
      return issue("API_CREDENTIAL_RESOURCE", "Service credential metadata is invalid.", ["resource"]);
    }
    if (response.kind === "service-credential.issued" && !validServiceCredentialToken(response.token)) {
      return issue("API_CREDENTIAL_TOKEN", "Issued service credential token is invalid.", ["token"]);
    }
  }
  if (response.kind === "release.trust.resource") {
    const runner = validateRunnerReference(response.resource.packageLock, ["resource", "packageLock"]);
    if (!runner.ok) return runner;
    if (!validDigest(response.resource.packageTrustDigest, true) || !validDigest(response.resource.validatorTrustDigest, true)) return issue("API_RELEASE_TRUST_DIGEST", "Release trust resource digests must be prefixed lowercase sha256 values.", ["resource"]);
  }
  if (response.kind === "release.contract.resource" && (!validDigest(response.resource.contractDigest, true) || !validDigest(response.resource.validatorLockDigest, true))) return issue("API_RELEASE_CONTRACT_DIGEST", "Release contract response contains an invalid digest.", ["resource"]);
  if (response.kind === "release.operation.resource" && !validReleaseOperation(response.resource)) return issue("API_RELEASE_OPERATION", "Release operation response contains invalid protected coordinates.", ["resource"]);
  if (response.kind === "release.approval.resource" && !validDigest(response.resource.contextDigest, false)) return issue("API_CONTEXT_DIGEST", "Release approval response contains an invalid context digest.", ["resource", "contextDigest"]);
  if (response.kind === "release.notification.page" && response.page.items.some(item => !validReleaseNotification(item))) return issue("API_RELEASE_NOTIFICATION", "Release notification page contains invalid authority or outcome details.", ["page", "items"]);
  if (response.kind === "release.policy.resource" && !response.resource.revoked && !validDigest(response.resource.contractDigest, true)) return issue("API_RELEASE_POLICY", "Release policy response contains an invalid contract digest.", ["resource", "contractDigest"]);
  if (response.kind === "mutation.accepted" && (!boundedText(response.receipt.resourceId, FACTORY_LIMITS.maxApiIdentifierLength) || !boundedText(response.receipt.commandId, FACTORY_LIMITS.maxApiIdentifierLength) || !boundedText(response.receipt.statusUrl, 2_048) || !response.receipt.statusUrl.startsWith("/api/factories/"))) return issue("API_RECEIPT", "Durable receipt identities and status URL are invalid.", ["receipt"]);
  if (response.kind === "error" && (!boundedText(response.error.code, FACTORY_LIMITS.maxApiIdentifierLength) || !boundedText(response.error.message, 4_096))) return issue("API_ERROR", "Factory API error code and message must be bounded.", ["error"]);
  if (encodedBytes(response as unknown as JsonValue) > FACTORY_LIMITS.maxDefinitionBytes) return issue("API_RESPONSE_BYTES", "Factory API response exceeds 16 MiB.", []);
  return { ok: true };
}
