import { createHash } from "node:crypto";
import { canonicalizeJson, isUnsignedDecimal } from "./canonical.js";
import { isFactoryDefinition } from "./schema.js";
import { validateExpression } from "./expressions.js";
import {
  FACTORY_EXECUTION_MANIFEST_SCHEMA_VERSION,
  FACTORY_IR_SCHEMA_VERSION,
  FACTORY_LIMITS,
  FACTORY_PARTITION_SCHEMA_VERSION,
  type CompileResult,
  type CompiledExecutionManifest,
  type CompiledFactory,
  type CompiledIndexes,
  type CompiledPage,
  type CompiledPartition,
  type CompiledPartitionArtifact,
  type CompiledPartitionInboundEdge,
  type CompiledPartitionOutboundEdge,
  type CompilerDiagnostic,
  type FactoryDefinition,
  type FactoryGraph,
  type FactoryNode,
  type Expression,
  type JsonValue,
  type PortSchema,
  type ValueSource,
  type BudgetBounds,
  type ValidationResult,
} from "./types.js";
import { isSchemaContained, resolveSchemaReference, validateCompiledFactory, validatePortSchema, validateValue } from "./validation.js";

const DIGEST_PREFIX = "sha256:";

function own(object: object, key: PropertyKey): boolean {
  return  Object.hasOwn(object, key);
}

function sha256(value: string): string {
  return `${DIGEST_PREFIX}${createHash("sha256").update(value).digest("hex")}`;
}

function validDigest(value: string): boolean {
  if (!value.startsWith(DIGEST_PREFIX) || value.length !== DIGEST_PREFIX.length + 64) return false;
  for (const character of value.slice(DIGEST_PREFIX.length)) {
    if (!((character >= "0" && character <= "9") || (character >= "a" && character <= "f"))) return false;
  }
  return true;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneDefinition(value: FactoryDefinition): FactoryDefinition {
  return JSON.parse(canonicalizeJson(value as unknown as JsonValue)) as FactoryDefinition;
}

function joinOutputPorts(): Readonly<Record<string, PortSchema>> {
  return { winners: { type: "array", items: { type: "object", properties: { nodeId: { type: "string", minLength: 1 }, outputs: { type: "object", additionalProperties: true } }, required: ["nodeId", "outputs"], additionalProperties: false } } };
}

function approvalOutputPorts(choices: readonly string[]): Readonly<Record<string, PortSchema>> {
  return { choice: { type: "string", enum: choices } };
}

function diagnostic(code: string, message: string, path: readonly (string | number)[], nodeId?: string): CompilerDiagnostic {
  return { code, message, path, ...(nodeId === undefined ? {} : { nodeId }) };
}

function materializeGraph(graph: FactoryGraph): FactoryGraph {
  return {
    nodes: graph.nodes.map((node) => {
      const common = {
        ...node,
        deadlineMs: node.deadlineMs ?? FACTORY_LIMITS.defaultNodeDeadlineMs,
        dependsOn: node.dependsOn ?? [],
        capabilities: node.capabilities ?? [],
        effects: node.effects ?? ["none"],
        bindings: node.bindings ?? {},
        inputPorts: node.inputPorts ?? {},
        outputPorts: node.outputPorts ?? (node.kind === "join" ? joinOutputPorts() : node.kind === "approval" ? approvalOutputPorts(node.choices) : {}),
      };
      if (node.kind === "task") return { ...common, retry: node.retry ?? { maxAttempts: 3, initialDelayMs: 1_000, maximumDelayMs: 2_000 } };
      if (node.kind === "branch") return { ...common, then: materializeGraph(node.then), else: materializeGraph(node.else) };
      if (node.kind === "map") return { ...common, body: materializeGraph(node.body) };
      if (node.kind === "loop") return { ...common, body: materializeGraph(node.body) };
      return common;
    }),
    outputs: graph.outputs,
  };
}

function materializeDefinition(definition: FactoryDefinition): FactoryDefinition {
  return {
    ...definition,
    graph: materializeGraph(definition.graph),
    factories: definition.factories ?? [],
    bounds: {
      ...definition.bounds,
      runDeadlineMs: definition.bounds.runDeadlineMs ?? FACTORY_LIMITS.defaultRunDeadlineMs,
    },
  };
}

interface CompileContext {
  readonly definition: FactoryDefinition;
  readonly diagnostics: CompilerDiagnostic[];
  readonly nodes: Map<string, FactoryNode>;
  readonly successors: Map<string, Set<string>>;
  readonly dependencies: Map<string, Set<string>>;
  readonly orderedIds: string[];
}

function addDiagnostic(context: CompileContext, code: string, message: string, path: readonly (string | number)[], nodeId?: string): void {
  context.diagnostics.push(diagnostic(code, message, path, nodeId));
}

function validateSchemas(record: Readonly<Record<string, PortSchema>>, context: CompileContext, path: readonly (string | number)[]): void {
  for (const [name, schema] of Object.entries(record)) {
    if (name.length === 0) addDiagnostic(context, "PORT_NAME", "Port names cannot be empty.", [...path, name]);
    const result = validatePortSchema(schema);
    if (!result.ok) addDiagnostic(context, result.issues[0]?.code ?? "SCHEMA_INVALID", result.issues[0]?.message ?? "Invalid port schema.", [...path, name, ...(result.issues[0]?.path ?? [])]);
  }
}

function validateBudget(value: BudgetBounds | undefined, context: CompileContext, path: readonly (string | number)[], nodeId?: string): void {
  if (!value) return;
  if (value.maxCostMicros !== undefined && !isUnsignedDecimal(value.maxCostMicros)) addDiagnostic(context, "BOUND_COST", "Cost micros must be a canonical unsigned decimal string.", [...path, "maxCostMicros"], nodeId);
  for (const field of ["maxTokens", "maxComputeMs"] as const) {
    const limit = value[field];
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) addDiagnostic(context, "BOUND_RESOURCE", `${field} must be a nonnegative safe integer.`, [...path, field], nodeId);
  }
}

function validatePin(name: string, version: string, digest: string, context: CompileContext, path: readonly (string | number)[]): void {
  if (name.length === 0) addDiagnostic(context, "REFERENCE_NAME", "Reference name cannot be empty.", [...path, "name"]);
  if (version.length === 0 || version === "latest" || version.includes("*")) addDiagnostic(context, "REFERENCE_VERSION", "References require an exact immutable version.", [...path, "version"]);
  if (!validDigest(digest)) addDiagnostic(context, "REFERENCE_DIGEST", "References require a lowercase sha256 digest.", [...path, "digest"]);
}

function validateRunner(reference: { package: string; version: string; digest: string; export: string; configurationDigest?: string }, context: CompileContext, path: readonly (string | number)[]): void {
  validatePin(reference.package, reference.version, reference.digest, context, path);
  if (reference.export.length === 0) addDiagnostic(context, "REFERENCE_EXPORT", "Runner export cannot be empty.", [...path, "export"]);
  if (reference.configurationDigest !== undefined && !validDigest(reference.configurationDigest)) addDiagnostic(context, "REFERENCE_CONFIGURATION", "Runner configuration requires a lowercase sha256 digest.", [...path, "configurationDigest"]);
}

function checkRunnerLock(reference: { package: string; version: string; digest: string }, context: CompileContext, path: readonly (string | number)[]): void {
  const locked = context.definition.packages.find((item) => item.name === reference.package);
  if (!locked || locked.version !== reference.version || locked.digest !== reference.digest) addDiagnostic(context, "REFERENCE_UNLOCKED", `Runner is absent or differs from the dependency lock: ${reference.package}.`, path);
}

function checkFactoryLock(reference: { id: string; version: string; digest: string }, context: CompileContext, path: readonly (string | number)[]): void {
  const locked = context.definition.factories?.find((item) => item.id === reference.id);
  if (!locked || locked.version !== reference.version || locked.digest !== reference.digest) addDiagnostic(context, "REFERENCE_UNLOCKED", `Subfactory is absent or differs from the dependency lock: ${reference.id}.`, path);
}

function checkAuthority(node: FactoryNode, context: CompileContext, path: readonly (string | number)[]): void {
  for (const capability of node.capabilities ?? []) if (!context.definition.capabilities.includes(capability)) addDiagnostic(context, "AUTHORITY_CAPABILITY", `Node capability widens factory authority: ${capability}.`, [...path, "capabilities"], node.id);
  for (const effect of node.effects ?? []) if (!context.definition.effects.includes(effect)) addDiagnostic(context, "AUTHORITY_EFFECT", `Node effect widens factory authority: ${effect}.`, [...path, "effects"], node.id);
  validateBudget(node.resources, context, [...path, "resources"], node.id);
  if (node.resources?.memoryBytes !== undefined && (!Number.isSafeInteger(node.resources.memoryBytes) || node.resources.memoryBytes < 0)) addDiagnostic(context, "BOUND_RESOURCE", "memoryBytes must be a nonnegative safe integer.", [...path, "resources", "memoryBytes"], node.id);
  if (node.resources?.resourceClass !== undefined && node.resources.resourceClass.length === 0) addDiagnostic(context, "BOUND_RESOURCE", "resourceClass cannot be empty.", [...path, "resources", "resourceClass"], node.id);
  if (node.kind === "subfactory") for (const grant of node.grants) if (!context.definition.capabilities.includes(grant)) addDiagnostic(context, "AUTHORITY_CHILD", `Child grant widens parent authority: ${grant}.`, [...path, "grants"], node.id);
}

function containsPublication(graph: FactoryGraph): boolean {
  return graph.nodes.some((node) => node.kind === "release" || node.effects?.includes("publish") || (node.kind === "branch" && (containsPublication(node.then) || containsPublication(node.else))) || ((node.kind === "map" || node.kind === "loop") && containsPublication(node.body)));
}

function inferLiteralSchema(value: JsonValue): PortSchema {
  if (value === null) return { type: "null", const: null };
  if (Array.isArray(value)) return { type: "array", minItems: value.length, maxItems: value.length, items: value.length === 0 ? { type: "null" } : inferLiteralSchema(value[0] as JsonValue), const: value };
  if (typeof value === "object") {
    const properties = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inferLiteralSchema(child)]));
    return { type: "object", properties, required: Object.keys(properties), additionalProperties: false, const: value };
  }
  return { type: Number.isInteger(value) ? "integer" : typeof value as "boolean" | "number" | "string", const: value };
}

type ScopeSchemas = Readonly<Partial<Record<"map" | "loop", Readonly<Record<string, PortSchema>>>>>;

function schemaAtPath(schemaInput: PortSchema, pathSegments: readonly (string | number)[], context: CompileContext, path: readonly (string | number)[]): PortSchema | undefined {
  const root = schemaInput;
  let schema = schemaInput;
  for (const segment of pathSegments) {
    const visited = new Set<PortSchema>();
    while (schema.$ref) {
      if (visited.has(schema)) return undefined;
      visited.add(schema);
      const resolved = resolveSchemaReference(root, schema.$ref);
      if (!resolved) return undefined;
      schema = resolved;
    }
    if (typeof segment === "number") {
      if (!schema.items) {
        addDiagnostic(context, "BINDING_PATH", "Numeric reference path requires an array item schema.", path);
        return undefined;
      }
      schema = schema.items;
    } else {
      if (!schema.properties || !own(schema.properties, segment)) {
        addDiagnostic(context, "BINDING_PATH", `Reference path is not declared by its schema: ${segment}.`, path);
        return undefined;
      }
      schema = schema.properties[segment] as PortSchema;
    }
  }
  const finalVisited = new Set<PortSchema>();
  while (schema.$ref) {
    if (finalVisited.has(schema)) return undefined;
    finalVisited.add(schema);
    const resolved = resolveSchemaReference(root, schema.$ref);
    if (!resolved) return undefined;
    schema = resolved;
  }
  return schema;
}

function sourceSchema(source: ValueSource, graphNodes: ReadonlyMap<string, FactoryNode>, scopes: ScopeSchemas, context: CompileContext, path: readonly (string | number)[]): PortSchema | undefined {
  if (source.kind === "literal") return inferLiteralSchema(source.value);
  if (source.root === "input") {
    const schema = own(context.definition.inputPorts, source.name) ? context.definition.inputPorts[source.name] : undefined;
    if (!schema) addDiagnostic(context, "BINDING_INPUT", `Unknown factory input: ${source.name}.`, path);
    return schema ? schemaAtPath(schema, source.path ?? [], context, path) : undefined;
  }
  if (source.root === "node") {
    const node = graphNodes.get(source.name);
    if (!node) {
      addDiagnostic(context, "BINDING_NODE", `Unknown source node: ${source.name}.`, path);
      return undefined;
    }
    const port = source.path?.[0];
    if (typeof port !== "string" || !node.outputPorts || !own(node.outputPorts, port)) {
      addDiagnostic(context, "BINDING_PORT", "Node references must start with a declared output port.", path, source.name);
      return undefined;
    }
    return schemaAtPath(node.outputPorts[port] as PortSchema, source.path?.slice(1) ?? [], context, path);
  }
  const scoped = scopes[source.root];
  const schema = scoped && own(scoped, source.name) ? scoped[source.name] : undefined;
  if (!schema) {
    addDiagnostic(context, "BINDING_SCOPE", `Reference is unavailable in this ${source.root} scope: ${source.name}.`, path);
    return undefined;
  }
  return schemaAtPath(schema, source.path ?? [], context, path);
}

function isAncestor(ancestor: string, nodeId: string, context: CompileContext): boolean {
  const pending = [...(context.dependencies.get(nodeId) ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(context.dependencies.get(current) ?? []));
  }
  return false;
}

function schemaTypes(schema: PortSchema): readonly string[] {
  if (typeof schema.type === "string") return [schema.type];
  return schema.type ? [...schema.type] : [];
}

function hasOnlyType(schema: PortSchema, expected: string): boolean {
  const types = schemaTypes(schema);
  return types.length === 1 && types[0] === expected;
}

function inferExpressionSchema(expression: Expression, availableNodes: ReadonlyMap<string, FactoryNode>, scopes: ScopeSchemas, context: CompileContext, path: readonly (string | number)[], nodeId: string): PortSchema | undefined {
  if (expression.kind === "literal") return inferLiteralSchema(expression.value);
  if (expression.kind === "ref") {
    const result = sourceSchema(expression, availableNodes, scopes, context, path);
    if (expression.root === "node" && !isAncestor(expression.name, nodeId, context)) addDiagnostic(context, "EXPRESSION_REACHABILITY", `Expression node is not a declared ancestor: ${expression.name}.`, path, nodeId);
    return result;
  }
  if (expression.kind === "exists") {
    sourceSchema(expression.value, availableNodes, scopes, context, [...path, "value"]);
    return { type: "boolean" };
  }
  if (expression.kind === "not") {
    const value = inferExpressionSchema(expression.value, availableNodes, scopes, context, [...path, "value"], nodeId);
    if (value && !hasOnlyType(value, "boolean")) addDiagnostic(context, "EXPRESSION_TYPE", "not requires a boolean expression.", path, nodeId);
    return { type: "boolean" };
  }
  if (expression.kind === "and" || expression.kind === "or") {
    expression.values.forEach((child, index) => {
      const value = inferExpressionSchema(child, availableNodes, scopes, context, [...path, "values", index], nodeId);
      if (value && !hasOnlyType(value, "boolean")) addDiagnostic(context, "EXPRESSION_TYPE", `${expression.kind} requires boolean expressions.`, [...path, "values", index], nodeId);
    });
    return { type: "boolean" };
  }
  if (expression.kind === "length") {
    const value = inferExpressionSchema(expression.value, availableNodes, scopes, context, [...path, "value"], nodeId);
    if (value && !(hasOnlyType(value, "string") || hasOnlyType(value, "array"))) addDiagnostic(context, "EXPRESSION_TYPE", "length requires a string or array expression.", path, nodeId);
    return { type: "integer", minimum: 0 };
  }
  const binary = expression as Extract<Expression, { readonly left: Expression }>;
  const leftExpression = expression.kind === "in" ? expression.value : binary.left;
  const rightExpression = expression.kind === "in" ? expression.collection : binary.right;
  const left = inferExpressionSchema(leftExpression, availableNodes, scopes, context, [...path, "left"], nodeId);
  const right = inferExpressionSchema(rightExpression, availableNodes, scopes, context, [...path, "right"], nodeId);
  if (expression.kind === "in") {
    if (right && !hasOnlyType(right, "array")) addDiagnostic(context, "EXPRESSION_TYPE", "in requires an array collection.", path, nodeId);
    if (left && right?.items && !isSchemaContained(left, right.items)) addDiagnostic(context, "EXPRESSION_TYPE", "in value is incompatible with collection items.", path, nodeId);
  } else if (expression.kind !== "eq") {
    const leftTypes = left ? schemaTypes(left) : [];
    const rightTypes = right ? schemaTypes(right) : [];
    const ordered = leftTypes.length === 1 && rightTypes.length === 1 && (((leftTypes[0] === "number" || leftTypes[0] === "integer") && (rightTypes[0] === "number" || rightTypes[0] === "integer")) || (leftTypes[0] === "string" && rightTypes[0] === "string"));
    if (left && right && !ordered) addDiagnostic(context, "EXPRESSION_TYPE", "Ordered comparison requires compatible numbers or strings.", path, nodeId);
  }
  return { type: "boolean" };
}

function checkBindings(node: FactoryNode, availableNodes: ReadonlyMap<string, FactoryNode>, scopes: ScopeSchemas, context: CompileContext, path: readonly (string | number)[]): void {
  for (const [port, schema] of Object.entries(node.inputPorts ?? {})) {
    const source = node.bindings?.[port];
    if (!source) {
      addDiagnostic(context, "BINDING_MISSING", `Input port has no binding: ${port}.`, [...path, "bindings", port], node.id);
      continue;
    }
    const producer = sourceSchema(source, availableNodes, scopes, context, [...path, "bindings", port]);
    if (producer && source.kind === "literal" ? !validateValue(schema, source.value).ok : producer ? !isSchemaContained(producer, schema) : false) addDiagnostic(context, "BINDING_INCOMPATIBLE", `Binding is not structurally contained by input port: ${port}.`, [...path, "bindings", port], node.id);
    if (source.kind === "ref" && source.root === "node" && !isAncestor(source.name, node.id, context)) addDiagnostic(context, "BINDING_REACHABILITY", `Source node is not a declared ancestor: ${source.name}.`, [...path, "bindings", port], node.id);
  }
  for (const port of Object.keys(node.bindings ?? {})) if (!node.inputPorts || !own(node.inputPorts, port)) addDiagnostic(context, "BINDING_UNKNOWN", `Binding targets an unknown input port: ${port}.`, [...path, "bindings", port], node.id);
}

function checkNodeSource(source: ValueSource, node: FactoryNode, availableNodes: ReadonlyMap<string, FactoryNode>, scopes: ScopeSchemas, context: CompileContext, path: readonly (string | number)[]): PortSchema | undefined {
  const schema = sourceSchema(source, availableNodes, scopes, context, path);
  if (source.kind === "ref" && source.root === "node" && !isAncestor(source.name, node.id, context)) addDiagnostic(context, "BINDING_REACHABILITY", `Source node is not a declared ancestor: ${source.name}.`, path, node.id);
  return schema;
}

function validateControlOutputs(node: Extract<FactoryNode, { kind: "branch" | "map" | "loop" }>, childOutputs: readonly Readonly<Record<string, PortSchema | undefined>>[], context: CompileContext, path: readonly (string | number)[]): void {
  const outputPorts = node.outputPorts ?? {};
  for (const [name, outputPort] of Object.entries(outputPorts)) {
    for (const outputs of childOutputs) {
      const childOutput = own(outputs, name) ? outputs[name] : undefined;
      if (!childOutput) addDiagnostic(context, "CONTROL_OUTPUT_MISSING", `Control body must declare output: ${name}.`, [...path, "outputPorts", name], node.id);
      else if (node.kind === "map") {
        if (!schemaTypes(outputPort).includes("array") || !outputPort.items) addDiagnostic(context, "CONTROL_OUTPUT_TYPE", "Map output ports must be typed arrays.", [...path, "outputPorts", name], node.id);
        else {
          const item = node.mode === "all" ? childOutput : {
            type: "object" as const,
            properties: { outcome: { type: "string" as const, enum: ["succeeded", "failed"] }, value: childOutput, error: { type: "string" as const } },
            required: ["outcome"],
            additionalProperties: false,
          };
          if (!isSchemaContained(item, outputPort.items)) addDiagnostic(context, "CONTROL_OUTPUT_TYPE", `Map body output is incompatible with collection port: ${name}.`, [...path, "outputPorts", name], node.id);
        }
      } else if (!isSchemaContained(childOutput, outputPort)) addDiagnostic(context, "CONTROL_OUTPUT_TYPE", `Control body output is incompatible: ${name}.`, [...path, "outputPorts", name], node.id);
    }
  }
  for (const outputs of childOutputs) for (const name of Object.keys(outputs)) if (!own(outputPorts, name)) addDiagnostic(context, "CONTROL_OUTPUT_UNKNOWN", `Control body declares an unknown output: ${name}.`, [...path, "body", "outputs", name], node.id);
}

function walkGraph(graph: FactoryGraph, context: CompileContext, path: readonly (string | number)[], depth: number, speculative: boolean, visibleNodes: ReadonlyMap<string, FactoryNode>, scopes: ScopeSchemas): Readonly<Record<string, PortSchema | undefined>> {
  if (depth > context.definition.bounds.maxScopeDepth || depth > FACTORY_LIMITS.maxScopeDepth) addDiagnostic(context, "BOUND_SCOPE_DEPTH", "Graph scope depth exceeds its bound.", path);
  const localNodes = new Map<string, FactoryNode>();
  graph.nodes.forEach((node, index) => {
    const nodePath = [...path, "nodes", index];
    if (node.id.length === 0 || node.id.includes("/")) addDiagnostic(context, "GRAPH_NODE_ID", "Node ID must be a nonempty instance-path segment without a slash.", [...nodePath, "id"]);
    if (localNodes.has(node.id) || context.nodes.has(node.id)) addDiagnostic(context, "GRAPH_DUPLICATE_NODE", `Duplicate node ID: ${node.id}.`, [...nodePath, "id"], node.id);
    else {
      localNodes.set(node.id, node);
      context.nodes.set(node.id, node);
      context.orderedIds.push(node.id);
    }
    validateSchemas(node.inputPorts ?? {}, context, [...nodePath, "inputPorts"]);
    validateSchemas(node.outputPorts ?? {}, context, [...nodePath, "outputPorts"]);
    checkAuthority(node, context, nodePath);
    if (node.deadlineMs !== undefined && (!Number.isSafeInteger(node.deadlineMs) || node.deadlineMs <= 0 || node.deadlineMs > FACTORY_LIMITS.maximumNodeDeadlineMs)) addDiagnostic(context, "BOUND_NODE_DEADLINE", "Node deadline is outside launch bounds.", [...nodePath, "deadlineMs"], node.id);
    if (node.retry && (!Number.isSafeInteger(node.retry.maxAttempts) || node.retry.maxAttempts < 1 || node.retry.maxAttempts > 3 || !Number.isSafeInteger(node.retry.initialDelayMs) || node.retry.initialDelayMs < 0 || !Number.isSafeInteger(node.retry.maximumDelayMs) || node.retry.maximumDelayMs < node.retry.initialDelayMs)) addDiagnostic(context, "BOUND_RETRY", "Retry policy is invalid or exceeds three attempts.", [...nodePath, "retry"], node.id);
    if (node.kind !== "task" && node.retry) addDiagnostic(context, "RETRY_UNSUPPORTED", "Only task nodes can declare a retry policy.", [...nodePath, "retry"], node.id);
    if (node.kind === "task" && node.maxIterations !== undefined && (!Number.isSafeInteger(node.maxIterations) || node.maxIterations < 1)) addDiagnostic(context, "BOUND_AGENT_ITERATIONS", "Task iterations require a positive bound.", [...nodePath, "maxIterations"], node.id);
    if (node.kind === "task") { validateRunner(node.runner, context, [...nodePath, "runner"]); checkRunnerLock(node.runner, context, [...nodePath, "runner"]); }
    if (node.kind === "release") { validateRunner(node.adapter, context, [...nodePath, "adapter"]); checkRunnerLock(node.adapter, context, [...nodePath, "adapter"]); }
    if (node.kind === "subfactory") { validatePin(node.factory.id, node.factory.version, node.factory.digest, context, [...nodePath, "factory"]); checkFactoryLock(node.factory, context, [...nodePath, "factory"]); }
    if (node.kind === "subfactory" && node.factory.id === context.definition.id) addDiagnostic(context, "REFERENCE_CYCLE", "A factory cannot reference itself.", [...nodePath, "factory"], node.id);
    if (node.kind === "map" && (!Number.isSafeInteger(node.maxItems) || node.maxItems < 0 || node.maxItems > context.definition.bounds.maxExpandedNodes || !Number.isSafeInteger(node.maxConcurrency) || node.maxConcurrency < 1 || node.maxConcurrency > FACTORY_LIMITS.maxConcurrentActivities)) addDiagnostic(context, "BOUND_MAP", "Map bounds are invalid.", nodePath, node.id);
    if (node.kind === "loop" && (!Number.isSafeInteger(node.maxIterations) || node.maxIterations < 1 || node.maxIterations > context.definition.bounds.maxExpandedNodes || !Number.isSafeInteger(node.maxElapsedMs) || node.maxElapsedMs < 1)) addDiagnostic(context, "BOUND_LOOP", "Loop requires positive iteration and elapsed-time bounds.", nodePath, node.id);
    if (node.kind === "loop") validateBudget(node.budget, context, [...nodePath, "budget"], node.id);
    if (node.kind === "approval" && (!Number.isSafeInteger(node.expiresInMs) || node.expiresInMs < 1 || node.expiresInMs > FACTORY_LIMITS.maximumApprovalWaitMs || node.choices.length === 0 || new Set(node.choices).size !== node.choices.length)) addDiagnostic(context, "BOUND_APPROVAL", "Approval choices or expiry are invalid.", nodePath, node.id);
    if (node.kind === "join") {
      if (node.mode === "all" && (node.quorum !== undefined || node.eligibleOutcomes !== undefined)) addDiagnostic(context, "JOIN_CONFIGURATION", "All joins cannot declare quorum outcomes.", nodePath, node.id);
      if (node.mode !== "all" && (!node.eligibleOutcomes?.length || !Number.isSafeInteger(node.quorum) || (node.quorum ?? 0) < 1 || (node.quorum ?? 0) > node.predecessors.length)) addDiagnostic(context, "JOIN_CONFIGURATION", "Any/quorum joins require eligible outcomes and a positive feasible quorum.", nodePath, node.id);
      if (Object.keys(node.outputPorts ?? {}).length !== 1 || !node.outputPorts?.winners || !isSchemaContained(joinOutputPorts().winners as PortSchema, node.outputPorts.winners)) addDiagnostic(context, "JOIN_OUTPUT", "Join outputPorts must declare the intrinsic winners record.", [...nodePath, "outputPorts"], node.id);
    }
    if (node.kind === "branch" && (containsPublication(node.then) || containsPublication(node.else))) addDiagnostic(context, "SPECULATIVE_PUBLICATION", "Speculative branches cannot publish or release.", nodePath, node.id);
    if (node.kind === "approval" && (Object.keys(node.outputPorts ?? {}).length !== 1 || !node.outputPorts?.choice || !isSchemaContained(approvalOutputPorts(node.choices).choice as PortSchema, node.outputPorts.choice))) addDiagnostic(context, "APPROVAL_OUTPUT", "Approval outputPorts must declare the intrinsic choice enum.", [...nodePath, "outputPorts"], node.id);
    if (node.kind === "branch") {
      const result = validateExpression(node.condition);
      if (!result.ok) addDiagnostic(context, result.issues[0]?.code ?? "EXPRESSION_INVALID", result.issues[0]?.message ?? "Branch expression is invalid.", [...nodePath, "condition"], node.id);
    }
    if (node.kind === "loop") for (const [field, expression] of [["until", node.until], ["nextInput", node.nextInput]] as const) {
      const result = validateExpression(expression);
      if (!result.ok) addDiagnostic(context, result.issues[0]?.code ?? "EXPRESSION_INVALID", result.issues[0]?.message ?? "Loop expression is invalid.", [...nodePath, field], node.id);
    }
    if (speculative && (node.kind === "release" || node.effects?.includes("publish"))) addDiagnostic(context, "SPECULATIVE_PUBLICATION", "Speculative scopes cannot publish or release.", nodePath, node.id);
  });

  const availableNodes = new Map([...visibleNodes, ...localNodes]);
  for (const [nodeId, node] of localNodes) {
    const declared = new Set([...(node.dependsOn ?? []), ...(node.kind === "join" ? node.predecessors : [])]);
    context.dependencies.set(nodeId, declared);
    context.successors.set(nodeId, context.successors.get(nodeId) ?? new Set());
    for (const predecessor of declared) {
      if (!localNodes.has(predecessor) && !visibleNodes.has(predecessor)) addDiagnostic(context, "GRAPH_MISSING_NODE", `Missing dependency: ${predecessor}.`, [...path, "nodes"], nodeId);
      else {
        const successors = context.successors.get(predecessor) ?? new Set<string>();
        successors.add(nodeId);
        context.successors.set(predecessor, successors);
      }
    }
  }

  const localCounts = new Map<string, number>();
  const localReady: string[] = [];
  for (const id of localNodes.keys()) {
    const count = [...(context.dependencies.get(id) ?? [])].filter((dependency) => localNodes.has(dependency)).length;
    localCounts.set(id, count);
    if (count === 0) localReady.push(id);
  }
  let processed = 0;
  while (localReady.length > 0) {
    const id = localReady.pop() as string;
    processed += 1;
    for (const successor of context.successors.get(id) ?? []) if (localNodes.has(successor)) {
      const count = (localCounts.get(successor) ?? 1) - 1;
      localCounts.set(successor, count);
      if (count === 0) localReady.push(successor);
    }
  }
  if (processed !== localNodes.size) addDiagnostic(context, "GRAPH_CYCLE", "Graph contains a dependency cycle.", path);

  graph.nodes.forEach((node, index) => {
    const nodePath = [...path, "nodes", index];
    checkBindings(node, availableNodes, scopes, context, nodePath);
    if (node.kind === "map") {
      const collection = checkNodeSource(node.collection, node, availableNodes, scopes, context, [...nodePath, "collection"]);
      if (collection && (!schemaTypes(collection).includes("array") || !collection.items || !isSchemaContained(collection.items, node.itemSchema))) addDiagnostic(context, "MAP_COLLECTION_TYPE", "Map collection must be an array whose items fit itemSchema.", [...nodePath, "collection"], node.id);
    } else if (node.kind === "loop") {
      const initial = checkNodeSource(node.initialInput, node, availableNodes, scopes, context, [...nodePath, "initialInput"]);
      if (initial && !isSchemaContained(initial, node.carriedSchema)) addDiagnostic(context, "LOOP_INPUT_TYPE", "Loop initialInput is incompatible with carriedSchema.", [...nodePath, "initialInput"], node.id);
    } else if (node.kind === "approval") checkNodeSource(node.context, node, availableNodes, scopes, context, [...nodePath, "context"]);
    else if (node.kind === "acceptance") {
      checkNodeSource(node.candidate, node, availableNodes, scopes, context, [...nodePath, "candidate"]);
      checkNodeSource(node.evidence, node, availableNodes, scopes, context, [...nodePath, "evidence"]);
    } else if (node.kind === "release") {
      checkNodeSource(node.acceptedCandidate, node, availableNodes, scopes, context, [...nodePath, "acceptedCandidate"]);
      checkNodeSource(node.destination, node, availableNodes, scopes, context, [...nodePath, "destination"]);
    }
    if (node.kind === "branch") {
      const condition = inferExpressionSchema(node.condition, availableNodes, scopes, context, [...nodePath, "condition"], node.id);
      if (condition && !hasOnlyType(condition, "boolean")) addDiagnostic(context, "EXPRESSION_TYPE", "Branch condition must be boolean.", [...nodePath, "condition"], node.id);
    }
    if (node.kind === "loop") {
      const loopScopes: ScopeSchemas = { ...scopes, loop: { carried: node.carriedSchema, result: node.resultSchema, index: { type: "integer", minimum: 0 } } };
      const until = inferExpressionSchema(node.until, availableNodes, loopScopes, context, [...nodePath, "until"], node.id);
      if (until && !hasOnlyType(until, "boolean")) addDiagnostic(context, "EXPRESSION_TYPE", "Loop until expression must be boolean.", [...nodePath, "until"], node.id);
      const next = inferExpressionSchema(node.nextInput, availableNodes, loopScopes, context, [...nodePath, "nextInput"], node.id);
      if (next && !isSchemaContained(next, node.carriedSchema)) addDiagnostic(context, "EXPRESSION_TYPE", "Loop nextInput is incompatible with carriedSchema.", [...nodePath, "nextInput"], node.id);
    }
    if (node.kind === "release" && (node.acceptedCandidate.kind !== "ref" || node.acceptedCandidate.root !== "node" || context.nodes.get(node.acceptedCandidate.name)?.kind !== "acceptance" || !context.dependencies.get(node.id)?.has(node.acceptedCandidate.name))) addDiagnostic(context, "RELEASE_ACCEPTANCE", "Release requires a declared dependency on an Acceptance node.", [...nodePath, "acceptedCandidate"], node.id);
    if (node.kind === "release" && (node.acceptedCandidate.kind !== "ref" || node.acceptedCandidate.path?.length !== 1 || node.acceptedCandidate.path[0] !== "acceptedCandidate")) addDiagnostic(context, "RELEASE_ACCEPTANCE", "Release must bind the exact acceptedCandidate output.", [...nodePath, "acceptedCandidate"], node.id);
    if (node.kind === "acceptance" && node.contract !== context.definition.acceptance.id) addDiagnostic(context, "ACCEPTANCE_CONTRACT", "Acceptance node must use the definition's pinned contract.", [...nodePath, "contract"], node.id);
    if (node.kind === "acceptance" && node.maxRepairs !== undefined && (!Number.isSafeInteger(node.maxRepairs) || node.maxRepairs < 0 || node.maxRepairs >= context.definition.bounds.maxExpandedNodes)) addDiagnostic(context, "BOUND_REPAIR", "Acceptance repair bound is invalid.", [...nodePath, "maxRepairs"], node.id);
    if (node.kind === "branch") {
      const ancestors = new Map([...availableNodes].filter(([id]) => isAncestor(id, node.id, context)));
      const thenOutputs = walkGraph(node.then, context, [...nodePath, "then"], depth + 1, true, ancestors, scopes);
      const elseOutputs = walkGraph(node.else, context, [...nodePath, "else"], depth + 1, true, ancestors, scopes);
      validateControlOutputs(node, [thenOutputs, elseOutputs], context, nodePath);
    } else if (node.kind === "map") {
      const ancestors = new Map([...availableNodes].filter(([id]) => isAncestor(id, node.id, context)));
      const bodyOutputs = walkGraph(node.body, context, [...nodePath, "body"], depth + 1, speculative, ancestors, { ...scopes, map: { item: node.itemSchema, index: { type: "integer", minimum: 0 } } });
      validateControlOutputs(node, [bodyOutputs], context, nodePath);
    } else if (node.kind === "loop") {
      const ancestors = new Map([...availableNodes].filter(([id]) => isAncestor(id, node.id, context)));
      const bodyOutputs = walkGraph(node.body, context, [...nodePath, "body"], depth + 1, speculative, ancestors, { ...scopes, loop: { carried: node.carriedSchema, result: node.resultSchema, index: { type: "integer", minimum: 0 } } });
      validateControlOutputs(node, [bodyOutputs], context, nodePath);
      if (!hasOnlyType(node.resultSchema, "object") || !node.resultSchema.properties || node.resultSchema.additionalProperties !== false || node.resultSchema.required?.length !== Object.keys(node.resultSchema.properties).length || Object.keys(node.resultSchema.properties).some((name) => !node.resultSchema.required?.includes(name) || !own(node.outputPorts ?? {}, name)) || Object.keys(node.outputPorts ?? {}).some((name) => !own(node.resultSchema.properties ?? {}, name))) addDiagnostic(context, "LOOP_RESULT_SCHEMA", "Loop resultSchema must be a closed object with every output property required and matched to outputPorts.", [...nodePath, "resultSchema"], node.id);
      else for (const [name, resultPort] of Object.entries(node.resultSchema.properties)) {
        const bodyOutput = bodyOutputs[name];
        const outputPort = node.outputPorts?.[name];
        if (bodyOutput && !isSchemaContained(bodyOutput, resultPort)) addDiagnostic(context, "CONTROL_OUTPUT_TYPE", `Loop body output is incompatible with resultSchema: ${name}.`, [...nodePath, "resultSchema", "properties", name], node.id);
        if (outputPort && !isSchemaContained(resultPort, outputPort)) addDiagnostic(context, "CONTROL_OUTPUT_TYPE", `Loop resultSchema is incompatible with output port: ${name}.`, [...nodePath, "outputPorts", name], node.id);
      }
    }
  });
  const outputSchemas = Object.create(null) as Record<string, PortSchema | undefined>;
  for (const [name, source] of Object.entries(graph.outputs)) outputSchemas[name] = sourceSchema(source, availableNodes, scopes, context, [...path, "outputs", name]);
  return outputSchemas;
}

function topologicalOrder(context: CompileContext): string[] {
  const remaining = new Map<string, number>();
  for (const id of context.orderedIds) remaining.set(id, [...(context.dependencies.get(id) ?? [])].filter((dependency) => context.nodes.has(dependency)).length);
  const ready = context.orderedIds.filter((id) => remaining.get(id) === 0);
  const result: string[] = [];
  while (ready.length > 0) {
    ready.sort(compareText);
    const id = ready.shift() as string;
    result.push(id);
    for (const successor of context.successors.get(id) ?? []) {
      const count = (remaining.get(successor) ?? 1) - 1;
      remaining.set(successor, count);
      if (count === 0) ready.push(successor);
    }
  }
  return result.length === context.nodes.size ? result : [...context.orderedIds];
}

function expandedGraphCount(graph: FactoryGraph, limit: number): number {
  let count = 0;
  for (const node of graph.nodes) {
    count += 1;
    if (node.kind === "branch") count += Math.max(expandedGraphCount(node.then, limit), expandedGraphCount(node.else, limit));
    else if (node.kind === "map") count += node.maxItems * expandedGraphCount(node.body, limit);
    else if (node.kind === "loop") count += node.maxIterations * expandedGraphCount(node.body, limit);
    if (!Number.isSafeInteger(count) || count > limit) return limit + 1;
  }
  return count;
}

type PartitionChunk = { readonly nodeIds: readonly string[] };

function partitionPayload(partition: Omit<CompiledPartition, "encodedBytes" | "digest">, context: CompileContext, factoryDigest: string): CompiledPartitionArtifact {
  return {
    schemaVersion: FACTORY_PARTITION_SCHEMA_VERSION,
    factoryDigest,
    ...partition,
    nodes: partition.nodeIds.map((id) => context.nodes.get(id) as FactoryNode),
  };
}

function encodedJsonBytes(value: JsonValue): number {
  return new TextEncoder().encode(canonicalizeJson(value)).byteLength;
}

function materializePartitions(chunks: readonly PartitionChunk[], context: CompileContext, factoryDigest: string): CompiledPartition[] {
  const nodePartition = new Map<string, string>();
  for (let index = 0; index < chunks.length; index += 1) {
    const id = `partition-${index}`;
    const nodeIds = chunks[index]!.nodeIds;
    for (const nodeId of nodeIds) nodePartition.set(nodeId, id);
  }
  const inboundByPartition = new Map<string, CompiledPartitionInboundEdge[]>(chunks.map((_, index) => [`partition-${index}`, []]));
  const outboundByPartition = new Map<string, CompiledPartitionOutboundEdge[]>(chunks.map((_, index) => [`partition-${index}`, []]));
  for (let index = 0; index < chunks.length; index += 1) for (const nodeId of chunks[index]!.nodeIds) for (const fromNodeId of context.dependencies.get(nodeId) ?? []) {
    const id = `partition-${index}`;
    const fromPartitionId = nodePartition.get(fromNodeId);
    if (!fromPartitionId || fromPartitionId === id) continue;
    inboundByPartition.get(id)!.push({ nodeId, fromNodeId, fromPartitionId });
    outboundByPartition.get(fromPartitionId)!.push({ nodeId: fromNodeId, toNodeId: nodeId, toPartitionId: id });
  }
  const compareInbound = (left: CompiledPartitionInboundEdge, right: CompiledPartitionInboundEdge): number => compareText(left.nodeId, right.nodeId) || compareText(left.fromNodeId, right.fromNodeId) || compareText(left.fromPartitionId, right.fromPartitionId);
  const compareOutbound = (left: CompiledPartitionOutboundEdge, right: CompiledPartitionOutboundEdge): number => compareText(left.nodeId, right.nodeId) || compareText(left.toNodeId, right.toNodeId) || compareText(left.toPartitionId, right.toPartitionId);
  return chunks.map(({ nodeIds }, index) => {
    const id = `partition-${index}`;
    const inbound = inboundByPartition.get(id)!.sort(compareInbound);
    const outbound = outboundByPartition.get(id)!.sort(compareOutbound);
    const manifest = { id, nodeIds, dependsOn: [...new Set(inbound.map((edge) => edge.fromPartitionId))].sort(compareText), inbound, outbound };
    const encoded = canonicalizeJson(partitionPayload(manifest, context, factoryDigest) as unknown as JsonValue);
    return { ...manifest, encodedBytes: new TextEncoder().encode(encoded).byteLength, digest: sha256(encoded) };
  });
}

function initialPartitionChunks(order: readonly string[], context: CompileContext, factoryDigest: string): PartitionChunk[] {
  const chunks: PartitionChunk[] = [];
  let nodeIds: string[] = [];
  let bytes = encodedJsonBytes(partitionPayload({ id: "partition-0", nodeIds: [], dependsOn: [], inbound: [], outbound: [] }, context, factoryDigest) as unknown as JsonValue);
  for (const nodeId of order) {
    const separatorBytes = nodeIds.length === 0 ? 0 : 2;
    const additionalBytes = encodedJsonBytes(nodeId) + encodedJsonBytes(context.nodes.get(nodeId) as unknown as JsonValue) + separatorBytes;
    if (nodeIds.length >= FACTORY_LIMITS.maxPartitionNodes || (nodeIds.length > 0 && bytes + additionalBytes > FACTORY_LIMITS.maxRecordedPageBytes)) {
      chunks.push({ nodeIds });
      nodeIds = [nodeId];
      bytes = encodedJsonBytes(partitionPayload({ id: `partition-${chunks.length}`, nodeIds: [], dependsOn: [], inbound: [], outbound: [] }, context, factoryDigest) as unknown as JsonValue) + additionalBytes - separatorBytes;
    } else {
      nodeIds.push(nodeId);
      bytes += additionalBytes;
    }
  }
  if (nodeIds.length > 0) chunks.push({ nodeIds });
  return chunks;
}

function buildPartitions(order: readonly string[], context: CompileContext, factoryDigest: string): CompiledPartition[] {
  const chunks = initialPartitionChunks(order, context, factoryDigest);
  let partitions = materializePartitions(chunks, context, factoryDigest);
  let oversizedIndex = partitions.findIndex((partition) => partition.encodedBytes > FACTORY_LIMITS.maxRecordedPageBytes);
  while (oversizedIndex >= 0) {
    const oversized = chunks[oversizedIndex]!;
    if (oversized.nodeIds.length === 1) {
      addDiagnostic(context, "PAYLOAD_PARTITION", `Node ${oversized.nodeIds[0]} and its partition boundary metadata exceed 32 KiB.`, ["graph"], oversized.nodeIds[0]);
      return partitions;
    }
    const middle = Math.ceil(oversized.nodeIds.length / 2);
    chunks.splice(oversizedIndex, 1, { nodeIds: oversized.nodeIds.slice(0, middle) }, { nodeIds: oversized.nodeIds.slice(middle) });
    partitions = materializePartitions(chunks, context, factoryDigest);
    oversizedIndex = partitions.findIndex((partition) => partition.encodedBytes > FACTORY_LIMITS.maxRecordedPageBytes);
  }
  return partitions;
}

function buildPages(partitions: readonly CompiledPartition[], context: CompileContext): CompiledPage[] {
  const pages: CompiledPage[] = [];
  for (const partition of partitions) {
    let nodeIds: string[] = [];
    let bytes = 2;
    const flush = (): void => {
      if (nodeIds.length === 0) return;
      const content = canonicalizeJson(nodeIds.map((id) => context.nodes.get(id)) as unknown as JsonValue);
      pages.push({ id: `page-${pages.length}`, partitionId: partition.id, nodeIds, encodedBytes: new TextEncoder().encode(content).byteLength, digest: sha256(content) });
      nodeIds = [];
      bytes = 2;
    };
    for (const id of partition.nodeIds) {
      const encoded = new TextEncoder().encode(canonicalizeJson(context.nodes.get(id) as unknown as JsonValue)).byteLength + 1;
      if (encoded > FACTORY_LIMITS.maxRecordedPageBytes) {
        addDiagnostic(context, "PAYLOAD_NODE", `Node ${id} exceeds the 32 KiB page limit.`, ["graph"], id);
        continue;
      }
      if (bytes + encoded > FACTORY_LIMITS.maxRecordedPageBytes) flush();
      nodeIds.push(id);
      bytes += encoded;
    }
    flush();
  }
  return pages;
}

function executionManifest(definition: FactoryDefinition, factoryDigest: string): CompiledExecutionManifest {
  return {
    schemaVersion: FACTORY_EXECUTION_MANIFEST_SCHEMA_VERSION,
    factoryDigest,
    inputPorts: definition.inputPorts,
    outputPorts: definition.outputPorts,
    bounds: {
      runDeadlineMs: definition.bounds.runDeadlineMs!,
      maxExpandedNodes: definition.bounds.maxExpandedNodes,
      maxScopeDepth: definition.bounds.maxScopeDepth,
    },
    outputs: definition.graph.outputs,
  };
}

export function compileFactory(input: unknown): CompileResult {
  if (!isFactoryDefinition(input)) return { ok: false, diagnostics: [diagnostic("FACTORY_SCHEMA", "Input does not match the canonical FactoryDefinition schema.", [])] };
  const definition = materializeDefinition(cloneDefinition(input as FactoryDefinition));
  const diagnostics: CompilerDiagnostic[] = [];
  const context: CompileContext = { definition, diagnostics, nodes: new Map(), successors: new Map(), dependencies: new Map(), orderedIds: [] };

  const encodedDefinition = canonicalizeJson(definition as unknown as JsonValue);
  if (new TextEncoder().encode(encodedDefinition).byteLength > FACTORY_LIMITS.maxDefinitionBytes) diagnostics.push(diagnostic("BOUND_DEFINITION_BYTES", "Compiled definition exceeds 16 MiB.", []));
  if (!Number.isSafeInteger(definition.bounds.maxExpandedNodes) || definition.bounds.maxExpandedNodes < 1 || definition.bounds.maxExpandedNodes > FACTORY_LIMITS.maxExpandedNodes) diagnostics.push(diagnostic("BOUND_EXPANDED_NODES", "Expanded-node bound is outside launch limits.", ["bounds", "maxExpandedNodes"]));
  if (!Number.isSafeInteger(definition.bounds.maxScopeDepth) || definition.bounds.maxScopeDepth < 1 || definition.bounds.maxScopeDepth > FACTORY_LIMITS.maxScopeDepth) diagnostics.push(diagnostic("BOUND_SCOPE_DEPTH", "Scope-depth bound is outside launch limits.", ["bounds", "maxScopeDepth"]));
  if (!Number.isSafeInteger(definition.bounds.runDeadlineMs) || definition.bounds.runDeadlineMs! < 1 || definition.bounds.runDeadlineMs! > FACTORY_LIMITS.maximumRunDeadlineMs) diagnostics.push(diagnostic("BOUND_RUN_DEADLINE", "Run deadline is outside launch limits.", ["bounds", "runDeadlineMs"]));
  if (definition.id.length === 0 || definition.version.length === 0 || definition.version === "latest" || definition.version.includes("*") || definition.interpreterCompatibility.length === 0) diagnostics.push(diagnostic("FACTORY_IDENTITY", "Factory ID, exact version, and interpreter compatibility are required.", []));
  validateSchemas(definition.inputPorts, context, ["inputPorts"]);
  validateSchemas(definition.outputPorts, context, ["outputPorts"]);

  const pins = new Set<string>();
  definition.packages.forEach((reference, index) => {
    validatePin(reference.name, reference.version, reference.digest, context, ["packages", index]);
    if (pins.has(reference.name)) addDiagnostic(context, "REFERENCE_DUPLICATE", `Duplicate package pin: ${reference.name}.`, ["packages", index]);
    pins.add(reference.name);
  });
  const factoryPins = new Set<string>();
  (definition.factories ?? []).forEach((reference, index) => {
    validatePin(reference.id, reference.version, reference.digest, context, ["factories", index]);
    if (factoryPins.has(reference.id)) addDiagnostic(context, "REFERENCE_DUPLICATE", `Duplicate factory pin: ${reference.id}.`, ["factories", index]);
    factoryPins.add(reference.id);
  });
  const generatorPackages = new Set<string>();
  const collectGenerators = (graph: FactoryGraph): void => {
    for (const node of graph.nodes) {
      if (node.kind === "task" && node.effects?.includes("write")) generatorPackages.add(node.runner.package);
      if (node.kind === "branch") { collectGenerators(node.then); collectGenerators(node.else); }
      else if (node.kind === "map" || node.kind === "loop") collectGenerators(node.body);
    }
  };
  collectGenerators(definition.graph);
  if (definition.acceptance.id.length === 0 || definition.acceptance.version.length === 0 || definition.acceptance.version === "latest" || definition.acceptance.version.includes("*") || definition.acceptance.claims.length === 0) diagnostics.push(diagnostic("ACCEPTANCE_CONTRACT", "Acceptance contract identity, exact version, and at least one claim are required.", ["acceptance"]));
  const claimIds = new Set<string>();
  definition.acceptance.claims.forEach((claim, index) => {
    if (claim.id.length === 0 || claimIds.has(claim.id)) addDiagnostic(context, "ACCEPTANCE_CLAIM", "Acceptance claim IDs must be nonempty and unique.", ["acceptance", "claims", index, "id"]);
    claimIds.add(claim.id);
    validateRunner(claim.validator, context, ["acceptance", "claims", index, "validator"]);
    checkRunnerLock(claim.validator, context, ["acceptance", "claims", index, "validator"]);
    if (claim.freshnessMs !== undefined && (!Number.isSafeInteger(claim.freshnessMs) || claim.freshnessMs < 1 || claim.freshnessMs > definition.bounds.runDeadlineMs!)) addDiagnostic(context, "ACCEPTANCE_FRESHNESS", "Claim freshness must be a positive safe integer within the run deadline.", ["acceptance", "claims", index, "freshnessMs"], claim.id);
    if (claim.protected && generatorPackages.has(claim.validator.package)) addDiagnostic(context, "ACCEPTANCE_AUTHORITY", "A protected validator cannot share the generator package.", ["acceptance", "claims", index], claim.id);
  });
  const groupIds = new Set<string>();
  const groupedClaims = new Set<string>();
  for (const [index, group] of (definition.acceptance.groups ?? []).entries()) {
    if (group.id.length === 0 || groupIds.has(group.id) || group.claimIds.length === 0 || new Set(group.claimIds).size !== group.claimIds.length || !Number.isSafeInteger(group.minimumPasses) || group.minimumPasses < 1 || group.minimumPasses > group.claimIds.length || group.claimIds.some((id) => !claimIds.has(id) || groupedClaims.has(id))) addDiagnostic(context, "ACCEPTANCE_GROUP", "Acceptance groups require a unique ID, known claims used by one group, and a feasible positive pass threshold.", ["acceptance", "groups", index]);
    groupIds.add(group.id);
    for (const id of group.claimIds) {
      groupedClaims.add(id);
    }
  }
  if (definition.acceptance.claims.some((claim) => !claim.required && !groupedClaims.has(claim.id))) diagnostics.push(diagnostic("ACCEPTANCE_GROUP", "Every optional claim must belong to one acceptance group.", ["acceptance", "claims"]));

  walkGraph(definition.graph, context, ["graph"], 1, false, new Map(), {});
  if (expandedGraphCount(definition.graph, definition.bounds.maxExpandedNodes) > definition.bounds.maxExpandedNodes) diagnostics.push(diagnostic("BOUND_EXPANDED_NODES", "Graph expansion exceeds its expanded-node bound.", ["graph"]));
  for (const [name, schema] of Object.entries(definition.outputPorts)) {
    const source = definition.graph.outputs[name];
    if (!source) addDiagnostic(context, "GRAPH_OUTPUT_MISSING", `Factory output has no graph source: ${name}.`, ["graph", "outputs", name]);
    else {
      const producer = sourceSchema(source, context.nodes, {}, context, ["graph", "outputs", name]);
      if (producer && !isSchemaContained(producer, schema)) addDiagnostic(context, "GRAPH_OUTPUT_INCOMPATIBLE", `Graph output is incompatible: ${name}.`, ["graph", "outputs", name]);
    }
  }
  for (const name of Object.keys(definition.graph.outputs)) if (!own(definition.outputPorts, name)) addDiagnostic(context, "GRAPH_OUTPUT_UNKNOWN", `Graph declares unknown factory output: ${name}.`, ["graph", "outputs", name]);
  if (diagnostics.some(({ code }) => code === "BOUND_DEFINITION_BYTES")) return { ok: false, diagnostics };

  const lock = {
    packages: [...definition.packages].sort((left, right) => compareText(left.name, right.name)),
    factories: [...(definition.factories ?? [])].sort((left, right) => compareText(left.id, right.id)),
    interpreter: definition.interpreterCompatibility,
  };
  const { presentation: _presentation, ...executionFields } = definition;
  const executionDefinition = executionFields as unknown as JsonValue;
  const digest = sha256(canonicalizeJson({ definition: executionDefinition, lock } as unknown as JsonValue));
  const manifest = executionManifest(definition, digest);
  const encodedManifest = canonicalizeJson(manifest as unknown as JsonValue);
  const executionManifestDescriptor = { encodedBytes: new TextEncoder().encode(encodedManifest).byteLength, digest: sha256(encodedManifest) };
  if (executionManifestDescriptor.encodedBytes > FACTORY_LIMITS.maxRecordedPageBytes) diagnostics.push(diagnostic("PAYLOAD_EXECUTION_MANIFEST", "Execution manifest exceeds 32 KiB.", ["inputPorts"]));
  const order = topologicalOrder(context);
  const rootNodeIds = new Set(definition.graph.nodes.map((node) => node.id));
  const partitions = buildPartitions(order.filter((id) => rootNodeIds.has(id)), context, digest);
  const pages = buildPages(partitions, context);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const nodeById = Object.create(null) as Record<string, FactoryNode>;
  const successors = Object.create(null) as Record<string, readonly string[]>;
  const dependencyCounts = Object.create(null) as Record<string, number>;
  for (const id of order) {
    nodeById[id] = context.nodes.get(id) as FactoryNode;
    successors[id] = [...(context.successors.get(id) ?? [])].sort(compareText);
    dependencyCounts[id] = context.dependencies.get(id)?.size ?? 0;
  }
  const indexes: CompiledIndexes = { nodeById, successors, dependencyCounts };
  const factory: CompiledFactory = {
    schemaVersion: FACTORY_IR_SCHEMA_VERSION,
    digest,
    ...(definition.presentation === undefined ? {} : { presentationDigest: sha256(canonicalizeJson(definition.presentation as JsonValue)) }),
    definition,
    lock,
    indexes,
    executionManifest: executionManifestDescriptor,
    partitions,
    pages,
  };
  return { ok: true, factory: deepFreeze(factory) };
}

export function createCompiledExecutionManifest(factory: CompiledFactory): CompiledExecutionManifest {
  return executionManifest(factory.definition, factory.digest);
}

export function createCompiledPartitionArtifact(factory: CompiledFactory, partitionId: string): CompiledPartitionArtifact {
  const partition = factory.partitions.find((candidate) => candidate.id === partitionId);
  if (!partition) throw new Error(`Unknown compiled partition: ${partitionId}`);
  const { encodedBytes: _encodedBytes, digest: _digest, ...fields } = partition;
  return {
    schemaVersion: FACTORY_PARTITION_SCHEMA_VERSION,
    factoryDigest: factory.digest,
    ...fields,
    nodes: partition.nodeIds.map((id) => factory.indexes.nodeById[id]!),
  };
}

export type CompiledFactoryPageBytes = Readonly<Record<string, Uint8Array>>;

function verificationIssue(code: string, message: string, path: readonly (string | number)[]): ValidationResult {
  return { ok: false, issues: [{ code, message, path }] };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function sha256Bytes(value: Uint8Array): string {
  return `${DIGEST_PREFIX}${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Trusted Node/Bun boundary check. Recompilation proves every canonical IR
 * field; supplied page bytes prove the manifests reference the fetched data.
 */
export function verifyCompiledFactoryArtifact(
  value: unknown,
  pageBytes: CompiledFactoryPageBytes,
): ValidationResult {
  const structural = validateCompiledFactory(value);
  if (!structural.ok) return structural;
  const factory = value as CompiledFactory;
  const rebuilt = compileFactory(factory.definition);
  if (!rebuilt.ok) return verificationIssue("COMPILED_RECOMPILE", "Embedded definition does not compile.", ["definition"]);
  if (canonicalizeJson(factory as unknown as JsonValue) !== canonicalizeJson(rebuilt.factory as unknown as JsonValue)) return verificationIssue("COMPILED_CANONICAL", "Compiled artifact differs from canonical recompilation.", []);
  const suppliedIds = Object.keys(pageBytes);
  if (suppliedIds.length !== factory.pages.length || suppliedIds.some((id) => !factory.pages.some((page) => page.id === id))) return verificationIssue("COMPILED_PAGE_BYTES", "Fetched page byte set differs from the page manifest.", ["pages"]);
  for (let index = 0; index < factory.pages.length; index += 1) {
    const page = factory.pages[index]!;
    if (!Object.hasOwn(pageBytes, page.id)) return verificationIssue("COMPILED_PAGE_BYTES", "A fetched page is missing.", ["pages", index]);
    const expectedText = canonicalizeJson(page.nodeIds.map((id) => factory.indexes.nodeById[id]) as unknown as JsonValue);
    const expected = new TextEncoder().encode(expectedText);
    const actual = pageBytes[page.id]!;
    if (actual.byteLength !== page.encodedBytes || sha256Bytes(actual) !== page.digest || !bytesEqual(actual, expected)) return verificationIssue("COMPILED_PAGE_BYTES", "Fetched page bytes do not match the canonical page and digest.", ["pages", index]);
  }
  return { ok: true };
}
