import { createHash } from "node:crypto";
import { canonicalizeJson, isUnsignedDecimal } from "./canonical.js";
import { isFactoryDefinition } from "./schema.js";
import { validateExpression } from "./expressions.js";
import {
  FACTORY_IR_SCHEMA_VERSION,
  FACTORY_LIMITS,
  type CompileResult,
  type CompiledFactory,
  type CompiledIndexes,
  type CompiledPage,
  type CompiledPartition,
  type CompilerDiagnostic,
  type FactoryDefinition,
  type FactoryGraph,
  type FactoryNode,
  type Expression,
  type JsonValue,
  type PortSchema,
  type ValueSource,
  type BudgetBounds,
} from "./types.js";
import { isSchemaContained, resolveSchemaReference, validatePortSchema, validateValue } from "./validation.js";

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
        outputPorts: node.outputPorts ?? {},
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

function walkGraph(graph: FactoryGraph, context: CompileContext, path: readonly (string | number)[], depth: number, speculative: boolean, visibleNodes: ReadonlyMap<string, FactoryNode>, scopes: ScopeSchemas): void {
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
    if (node.kind === "map" && (!Number.isSafeInteger(node.maxItems) || node.maxItems < 0 || node.maxItems > context.definition.bounds.maxExpandedNodes || !Number.isSafeInteger(node.maxConcurrency) || node.maxConcurrency < 1)) addDiagnostic(context, "BOUND_MAP", "Map bounds are invalid.", nodePath, node.id);
    if (node.kind === "loop" && (!Number.isSafeInteger(node.maxIterations) || node.maxIterations < 1 || node.maxIterations > context.definition.bounds.maxExpandedNodes || !Number.isSafeInteger(node.maxElapsedMs) || node.maxElapsedMs < 1)) addDiagnostic(context, "BOUND_LOOP", "Loop requires positive iteration and elapsed-time bounds.", nodePath, node.id);
    if (node.kind === "loop") validateBudget(node.budget, context, [...nodePath, "budget"], node.id);
    if (node.kind === "approval" && (!Number.isSafeInteger(node.expiresInMs) || node.expiresInMs < 1 || node.expiresInMs > FACTORY_LIMITS.maximumApprovalWaitMs || node.choices.length === 0 || new Set(node.choices).size !== node.choices.length)) addDiagnostic(context, "BOUND_APPROVAL", "Approval choices or expiry are invalid.", nodePath, node.id);
    if (node.kind === "join") {
      if (node.mode === "all" && (node.quorum !== undefined || node.eligibleOutcomes !== undefined)) addDiagnostic(context, "JOIN_CONFIGURATION", "All joins cannot declare quorum outcomes.", nodePath, node.id);
      if (node.mode !== "all" && (!node.eligibleOutcomes?.length || !Number.isSafeInteger(node.quorum) || (node.quorum ?? 0) < 1 || (node.quorum ?? 0) > node.predecessors.length)) addDiagnostic(context, "JOIN_CONFIGURATION", "Any/quorum joins require eligible outcomes and a positive feasible quorum.", nodePath, node.id);
    }
    if (node.kind === "branch" && (containsPublication(node.then) || containsPublication(node.else))) addDiagnostic(context, "SPECULATIVE_PUBLICATION", "Speculative branches cannot publish or release.", nodePath, node.id);
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
      walkGraph(node.then, context, [...nodePath, "then"], depth + 1, true, ancestors, scopes);
      walkGraph(node.else, context, [...nodePath, "else"], depth + 1, true, ancestors, scopes);
    } else if (node.kind === "map") {
      const ancestors = new Map([...availableNodes].filter(([id]) => isAncestor(id, node.id, context)));
      walkGraph(node.body, context, [...nodePath, "body"], depth + 1, speculative, ancestors, { ...scopes, map: { item: node.itemSchema, index: { type: "integer", minimum: 0 } } });
    } else if (node.kind === "loop") {
      const ancestors = new Map([...availableNodes].filter(([id]) => isAncestor(id, node.id, context)));
      walkGraph(node.body, context, [...nodePath, "body"], depth + 1, speculative, ancestors, { ...scopes, loop: { carried: node.carriedSchema, result: node.resultSchema, index: { type: "integer", minimum: 0 } } });
    }
  });
  for (const [name, source] of Object.entries(graph.outputs)) sourceSchema(source, availableNodes, scopes, context, [...path, "outputs", name]);
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

function buildPartitions(order: readonly string[], context: CompileContext): CompiledPartition[] {
  const partitions: CompiledPartition[] = [];
  const nodePartition = new Map<string, string>();
  for (let offset = 0; offset < order.length; offset += FACTORY_LIMITS.maxPartitionNodes) {
    const nodeIds = order.slice(offset, offset + FACTORY_LIMITS.maxPartitionNodes);
    const id = `partition-${partitions.length}`;
    const dependsOn = new Set<string>();
    for (const nodeId of nodeIds) for (const dependency of context.dependencies.get(nodeId) ?? []) {
      const partition = nodePartition.get(dependency);
      if (partition && partition !== id) dependsOn.add(partition);
    }
    for (const nodeId of nodeIds) nodePartition.set(nodeId, id);
    partitions.push({ id, nodeIds, dependsOn: [...dependsOn].sort(compareText) });
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
      if (encoded > 32 * 1024) {
        addDiagnostic(context, "PAYLOAD_NODE", `Node ${id} exceeds the 32 KiB page limit.`, ["graph"], id);
        continue;
      }
      if (bytes + encoded > 32 * 1024) flush();
      nodeIds.push(id);
      bytes += encoded;
    }
    flush();
  }
  return pages;
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
  if (definition.acceptance.id.length === 0 || definition.acceptance.version.length === 0 || definition.acceptance.claims.length === 0) diagnostics.push(diagnostic("ACCEPTANCE_CONTRACT", "Acceptance contract identity and at least one claim are required.", ["acceptance"]));
  const claimIds = new Set<string>();
  definition.acceptance.claims.forEach((claim, index) => {
    if (claim.id.length === 0 || claimIds.has(claim.id)) addDiagnostic(context, "ACCEPTANCE_CLAIM", "Acceptance claim IDs must be nonempty and unique.", ["acceptance", "claims", index, "id"]);
    claimIds.add(claim.id);
    validateRunner(claim.validator, context, ["acceptance", "claims", index, "validator"]);
    checkRunnerLock(claim.validator, context, ["acceptance", "claims", index, "validator"]);
    if (claim.protected && generatorPackages.has(claim.validator.package)) addDiagnostic(context, "ACCEPTANCE_AUTHORITY", "A protected validator cannot share the generator package.", ["acceptance", "claims", index], claim.id);
  });
  const groupIds = new Set<string>();
  for (const [index, group] of (definition.acceptance.groups ?? []).entries()) {
    if (group.id.length === 0 || groupIds.has(group.id) || group.claimIds.length === 0 || new Set(group.claimIds).size !== group.claimIds.length || !Number.isSafeInteger(group.minimumPasses) || group.minimumPasses < 1 || group.minimumPasses > group.claimIds.length || group.claimIds.some((id) => !claimIds.has(id))) addDiagnostic(context, "ACCEPTANCE_GROUP", "Acceptance groups require a unique ID, known unique claims, and a feasible positive pass threshold.", ["acceptance", "groups", index]);
    groupIds.add(group.id);
  }

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

  const order = topologicalOrder(context);
  const partitions = buildPartitions(order, context);
  const pages = buildPages(partitions, context);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const lock = {
    packages: [...definition.packages].sort((left, right) => compareText(left.name, right.name)),
    factories: [...(definition.factories ?? [])].sort((left, right) => compareText(left.id, right.id)),
    interpreter: definition.interpreterCompatibility,
  };
  const { presentation: _presentation, ...executionFields } = definition;
  const executionDefinition = executionFields as unknown as JsonValue;
  const digest = sha256(canonicalizeJson({ definition: executionDefinition, lock } as unknown as JsonValue));
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
    partitions,
    pages,
  };
  return { ok: true, factory: deepFreeze(factory) };
}
