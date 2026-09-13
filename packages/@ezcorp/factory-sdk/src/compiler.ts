import { createHash } from "node:crypto";
import { canonicalizeJson, isUnsignedDecimal } from "./canonical";
import { isFactoryDefinition } from "./schema";
import { validateExpression } from "./expressions";
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
  type JsonValue,
  type PortSchema,
  type ValueSource,
} from "./types";
import { isSchemaContained, validatePortSchema, validateValue } from "./validation";

const DIGEST_PREFIX = "sha256:";

function own(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
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
  nodeCount: number;
}

function addDiagnostic(context: CompileContext, code: string, message: string, path: readonly (string | number)[], nodeId?: string): void {
  context.diagnostics.push(diagnostic(code, message, path, nodeId));
}

function validateSchemas(record: Readonly<Record<string, PortSchema>>, context: CompileContext, path: readonly (string | number)[]): void {
  for (const [name, schema] of Object.entries(record)) {
    const result = validatePortSchema(schema);
    if (!result.ok) addDiagnostic(context, result.issues[0]?.code ?? "SCHEMA_INVALID", result.issues[0]?.message ?? "Invalid port schema.", [...path, name, ...(result.issues[0]?.path ?? [])]);
  }
}

function validatePin(name: string, version: string, digest: string, context: CompileContext, path: readonly (string | number)[]): void {
  if (name.length === 0) addDiagnostic(context, "REFERENCE_NAME", "Reference name cannot be empty.", [...path, "name"]);
  if (version.length === 0 || version === "latest" || version.includes("*")) addDiagnostic(context, "REFERENCE_VERSION", "References require an exact immutable version.", [...path, "version"]);
  if (!validDigest(digest)) addDiagnostic(context, "REFERENCE_DIGEST", "References require a lowercase sha256 digest.", [...path, "digest"]);
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
  if (node.resources?.maxCostMicros !== undefined && !isUnsignedDecimal(node.resources.maxCostMicros)) addDiagnostic(context, "BOUND_COST", "Cost micros must be a canonical unsigned decimal string.", [...path, "resources", "maxCostMicros"], node.id);
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

function sourceSchema(source: ValueSource, graphNodes: ReadonlyMap<string, FactoryNode>, context: CompileContext, path: readonly (string | number)[]): PortSchema | undefined {
  if (source.kind === "literal") return inferLiteralSchema(source.value);
  if (source.root === "input") {
    const schema = own(context.definition.inputPorts, source.name) ? context.definition.inputPorts[source.name] : undefined;
    if (!schema) addDiagnostic(context, "BINDING_INPUT", `Unknown factory input: ${source.name}.`, path);
    return schema;
  }
  if (source.root === "node") {
    const node = graphNodes.get(source.name) ?? context.nodes.get(source.name);
    if (!node) {
      addDiagnostic(context, "BINDING_NODE", `Unknown source node: ${source.name}.`, path);
      return undefined;
    }
    const port = source.path?.[0];
    if (typeof port !== "string" || !node.outputPorts || !own(node.outputPorts, port)) {
      addDiagnostic(context, "BINDING_PORT", "Node references must start with a declared output port.", path, source.name);
      return undefined;
    }
    return node.outputPorts[port];
  }
  if (source.root === "map") return source.name === "item" || source.name === "index" ? { type: source.name === "index" ? "integer" : "object" } : undefined;
  return source.name === "carried" || source.name === "result" || source.name === "index" ? { type: source.name === "index" ? "integer" : "object" } : undefined;
}

function checkBindings(node: FactoryNode, localNodes: ReadonlyMap<string, FactoryNode>, context: CompileContext, path: readonly (string | number)[]): void {
  for (const [port, schema] of Object.entries(node.inputPorts ?? {})) {
    const source = node.bindings?.[port];
    if (!source) {
      addDiagnostic(context, "BINDING_MISSING", `Input port has no binding: ${port}.`, [...path, "bindings", port], node.id);
      continue;
    }
    const producer = sourceSchema(source, localNodes, context, [...path, "bindings", port]);
    if (producer && source.kind === "literal" ? !validateValue(schema, source.value).ok : producer ? !isSchemaContained(producer, schema) : false) addDiagnostic(context, "BINDING_INCOMPATIBLE", `Binding is not structurally contained by input port: ${port}.`, [...path, "bindings", port], node.id);
    if (source.kind === "ref" && source.root === "node" && !context.dependencies.get(node.id)?.has(source.name)) addDiagnostic(context, "BINDING_REACHABILITY", `Source node is not a declared dependency: ${source.name}.`, [...path, "bindings", port], node.id);
  }
  for (const port of Object.keys(node.bindings ?? {})) if (!node.inputPorts || !own(node.inputPorts, port)) addDiagnostic(context, "BINDING_UNKNOWN", `Binding targets an unknown input port: ${port}.`, [...path, "bindings", port], node.id);
}

function walkGraph(graph: FactoryGraph, context: CompileContext, path: readonly (string | number)[], depth: number, speculative: boolean): void {
  if (depth > context.definition.bounds.maxScopeDepth || depth > FACTORY_LIMITS.maxScopeDepth) addDiagnostic(context, "BOUND_SCOPE_DEPTH", "Graph scope depth exceeds its bound.", path);
  const localNodes = new Map<string, FactoryNode>();
  graph.nodes.forEach((node, index) => {
    const nodePath = [...path, "nodes", index];
    context.nodeCount += 1;
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
    if (node.retry && (!Number.isSafeInteger(node.retry.maxAttempts) || node.retry.maxAttempts < 1 || node.retry.initialDelayMs < 0 || node.retry.maximumDelayMs < node.retry.initialDelayMs)) addDiagnostic(context, "BOUND_RETRY", "Retry policy is invalid.", [...nodePath, "retry"], node.id);
    if (node.kind === "task") { validatePin(node.runner.package, node.runner.version, node.runner.digest, context, [...nodePath, "runner"]); checkRunnerLock(node.runner, context, [...nodePath, "runner"]); }
    if (node.kind === "release") { validatePin(node.adapter.package, node.adapter.version, node.adapter.digest, context, [...nodePath, "adapter"]); checkRunnerLock(node.adapter, context, [...nodePath, "adapter"]); }
    if (node.kind === "subfactory") { validatePin(node.factory.id, node.factory.version, node.factory.digest, context, [...nodePath, "factory"]); checkFactoryLock(node.factory, context, [...nodePath, "factory"]); }
    if (node.kind === "map" && (!Number.isSafeInteger(node.maxItems) || node.maxItems < 0 || node.maxItems > context.definition.bounds.maxExpandedNodes || !Number.isSafeInteger(node.maxConcurrency) || node.maxConcurrency < 1)) addDiagnostic(context, "BOUND_MAP", "Map bounds are invalid.", nodePath, node.id);
    if (node.kind === "loop" && (!Number.isSafeInteger(node.maxIterations) || node.maxIterations < 1 || node.maxIterations > context.definition.bounds.maxExpandedNodes || !Number.isSafeInteger(node.maxElapsedMs) || node.maxElapsedMs < 1)) addDiagnostic(context, "BOUND_LOOP", "Loop requires positive iteration and elapsed-time bounds.", nodePath, node.id);
    if (node.kind === "loop" && node.budget?.maxCostMicros !== undefined && !isUnsignedDecimal(node.budget.maxCostMicros)) addDiagnostic(context, "BOUND_COST", "Loop cost must be a canonical unsigned decimal string.", [...nodePath, "budget", "maxCostMicros"], node.id);
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

  for (const [nodeId, node] of localNodes) {
    const declared = new Set([...(node.dependsOn ?? []), ...(node.kind === "join" ? node.predecessors : [])]);
    context.dependencies.set(nodeId, declared);
    context.successors.set(nodeId, context.successors.get(nodeId) ?? new Set());
    for (const predecessor of declared) {
      if (!localNodes.has(predecessor) && !context.nodes.has(predecessor)) addDiagnostic(context, "GRAPH_MISSING_NODE", `Missing dependency: ${predecessor}.`, [...path, "nodes"], nodeId);
      else {
        const successors = context.successors.get(predecessor) ?? new Set<string>();
        successors.add(nodeId);
        context.successors.set(predecessor, successors);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      addDiagnostic(context, "GRAPH_CYCLE", `Graph cycle includes ${id}.`, path, id);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of context.dependencies.get(id) ?? []) if (localNodes.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of localNodes.keys()) visit(id);

  graph.nodes.forEach((node, index) => {
    const nodePath = [...path, "nodes", index];
    checkBindings(node, localNodes, context, nodePath);
    if (node.kind === "release" && (node.acceptedCandidate.kind !== "ref" || node.acceptedCandidate.root !== "node" || context.nodes.get(node.acceptedCandidate.name)?.kind !== "acceptance" || !context.dependencies.get(node.id)?.has(node.acceptedCandidate.name))) addDiagnostic(context, "RELEASE_ACCEPTANCE", "Release requires a declared dependency on an Acceptance node.", [...nodePath, "acceptedCandidate"], node.id);
    if (node.kind === "branch") {
      walkGraph(node.then, context, [...nodePath, "then"], depth + 1, true);
      walkGraph(node.else, context, [...nodePath, "else"], depth + 1, true);
    } else if (node.kind === "map" || node.kind === "loop") walkGraph(node.body, context, [...nodePath, "body"], depth + 1, speculative);
  });
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
  const context: CompileContext = { definition, diagnostics, nodes: new Map(), successors: new Map(), dependencies: new Map(), orderedIds: [], nodeCount: 0 };

  const encodedDefinition = canonicalizeJson(definition as unknown as JsonValue);
  if (new TextEncoder().encode(encodedDefinition).byteLength > FACTORY_LIMITS.maxDefinitionBytes) diagnostics.push(diagnostic("BOUND_DEFINITION_BYTES", "Compiled definition exceeds 16 MiB.", []));
  if (!Number.isSafeInteger(definition.bounds.maxExpandedNodes) || definition.bounds.maxExpandedNodes < 1 || definition.bounds.maxExpandedNodes > FACTORY_LIMITS.maxExpandedNodes) diagnostics.push(diagnostic("BOUND_EXPANDED_NODES", "Expanded-node bound is outside launch limits.", ["bounds", "maxExpandedNodes"]));
  if (!Number.isSafeInteger(definition.bounds.maxScopeDepth) || definition.bounds.maxScopeDepth < 1 || definition.bounds.maxScopeDepth > FACTORY_LIMITS.maxScopeDepth) diagnostics.push(diagnostic("BOUND_SCOPE_DEPTH", "Scope-depth bound is outside launch limits.", ["bounds", "maxScopeDepth"]));
  if (!Number.isSafeInteger(definition.bounds.runDeadlineMs) || definition.bounds.runDeadlineMs! < 1 || definition.bounds.runDeadlineMs! > FACTORY_LIMITS.maximumRunDeadlineMs) diagnostics.push(diagnostic("BOUND_RUN_DEADLINE", "Run deadline is outside launch limits.", ["bounds", "runDeadlineMs"]));
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
  definition.acceptance.claims.forEach((claim, index) => {
    validatePin(claim.validator.package, claim.validator.version, claim.validator.digest, context, ["acceptance", "claims", index, "validator"]);
    checkRunnerLock(claim.validator, context, ["acceptance", "claims", index, "validator"]);
    if (claim.protected && generatorPackages.has(claim.validator.package)) addDiagnostic(context, "ACCEPTANCE_AUTHORITY", "A protected validator cannot share the generator package.", ["acceptance", "claims", index], claim.id);
  });

  walkGraph(definition.graph, context, ["graph"], 1, false);
  if (context.nodeCount > definition.bounds.maxExpandedNodes) diagnostics.push(diagnostic("BOUND_EXPANDED_NODES", "Static graph exceeds its expanded-node bound.", ["graph"]));
  for (const [name, schema] of Object.entries(definition.outputPorts)) {
    const source = definition.graph.outputs[name];
    if (!source) addDiagnostic(context, "GRAPH_OUTPUT_MISSING", `Factory output has no graph source: ${name}.`, ["graph", "outputs", name]);
    else {
      const producer = sourceSchema(source, context.nodes, context, ["graph", "outputs", name]);
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
