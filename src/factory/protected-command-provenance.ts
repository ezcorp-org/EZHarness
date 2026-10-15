import { canonicalJson } from "@ezcorp/extension-contract";
import type { CompiledFactory, FactoryNode, JsonValue, KernelAttempt, KernelState, ReferencePathSegment, ValueReference, ValueSource } from "@ezcorp/factory-sdk";
import { nodeFor } from "@ezcorp/factory-sdk/kernel";

export interface FactoryProtectedTaskSource {
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly attempt: KernelAttempt;
  readonly path: readonly ReferencePathSegment[];
}

export interface FactoryProtectedNodeSource extends FactoryProtectedTaskSource {
  readonly kind: FactoryNode["kind"];
}

export class FactoryProtectedCommandProvenanceError extends Error {
  constructor(readonly code: "factory_protected_source_missing" | "factory_protected_source_stale" | "factory_protected_source_unsupported") {
    super(code);
    this.name = "FactoryProtectedCommandProvenanceError";
  }
}

function pathValue(value: JsonValue, path: readonly ReferencePathSegment[]): JsonValue {
  let current: JsonValue | undefined = value;
  for (const segment of path) {
    if (typeof segment === "number") current = Array.isArray(current) && Number.isSafeInteger(segment) && segment >= 0 ? current[segment] : undefined;
    else current = current !== null && typeof current === "object" && !Array.isArray(current) && Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (current === undefined) throw new FactoryProtectedCommandProvenanceError("factory_protected_source_stale");
  }
  return current;
}

function equal(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function lexicalScopes(nodeInstanceId: string): string[] {
  const parts = nodeInstanceId.split("/");
  const scopes = [""];
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index + 1] === "then" || parts[index + 1] === "else") {
      scopes.push(`${parts.slice(0, index + 2).join("/")}/`);
      index += 1;
    } else if (parts[index + 1] === "items" && parts[index + 2] !== undefined) {
      scopes.push(`${parts.slice(0, index + 3).join("/")}/`);
      index += 2;
    }
  }
  return scopes;
}

function withPath(source: ValueSource, suffix: readonly ReferencePathSegment[]): ValueSource {
  if (suffix.length === 0) return source;
  if (source.kind !== "ref") throw new FactoryProtectedCommandProvenanceError("factory_protected_source_unsupported");
  return { ...source, path: [...(source.path ?? []), ...suffix] };
}

function referencedNode(compiled: CompiledFactory, state: KernelState, scopes: readonly string[], reference: ValueReference): string {
  for (const scope of [...scopes].reverse()) {
    const nodeId = `${scope}${reference.name}`;
    if (Object.hasOwn(state.nodes, nodeId) && nodeFor(compiled, nodeId)) return nodeId;
  }
  throw new FactoryProtectedCommandProvenanceError("factory_protected_source_missing");
}

function resolve(compiled: CompiledFactory, state: KernelState, scopes: readonly string[], source: ValueSource, expected: JsonValue, expectedKind: FactoryNode["kind"]): FactoryProtectedNodeSource {
  if (source.kind !== "ref" || source.root !== "node") throw new FactoryProtectedCommandProvenanceError("factory_protected_source_unsupported");
  const nodeInstanceId = referencedNode(compiled, state, scopes, source);
  const node = nodeFor(compiled, nodeInstanceId);
  const runtime = state.nodes[nodeInstanceId];
  const path = source.path ?? [];
  if (!node || !runtime || runtime.status !== "succeeded" || runtime.output === undefined || !equal(pathValue(runtime.output, path), expected)) throw new FactoryProtectedCommandProvenanceError("factory_protected_source_stale");
  if (node.kind === expectedKind) {
    const attempt = runtime.attempts.at(-1);
    if (!attempt?.stopped || attempt.uncertain || attempt.candidateGeneration !== runtime.candidateGeneration) throw new FactoryProtectedCommandProvenanceError("factory_protected_source_stale");
    return { nodeInstanceId, candidateGeneration: runtime.candidateGeneration, attempt, path, kind: node.kind };
  }
  const outputName = path[0];
  if (typeof outputName !== "string") throw new FactoryProtectedCommandProvenanceError("factory_protected_source_unsupported");
  const suffix = path.slice(1);
  if (node.kind === "branch" && runtime.selected) {
    const childScope = `${nodeInstanceId}/${runtime.selected}/`;
    const mapped = node[runtime.selected].outputs[outputName];
    if (!mapped) throw new FactoryProtectedCommandProvenanceError("factory_protected_source_stale");
    return resolve(compiled, state, [...scopes, childScope], withPath(mapped, suffix), expected, expectedKind);
  }
  if (node.kind === "loop" && runtime.loop) {
    const childScope = `${nodeInstanceId}/items/${runtime.loop.iteration}/`;
    const mapped = node.body.outputs[outputName];
    if (!mapped) throw new FactoryProtectedCommandProvenanceError("factory_protected_source_stale");
    return resolve(compiled, state, [...scopes, childScope], withPath(mapped, suffix), expected, expectedKind);
  }
  throw new FactoryProtectedCommandProvenanceError("factory_protected_source_unsupported");
}

/** Traces a committed value through retained branch/loop state to one verified task attempt. */
export function resolveFactoryProtectedTaskSource(compiled: CompiledFactory, state: KernelState, consumerNodeInstanceId: string, source: ValueSource, expected: JsonValue): FactoryProtectedTaskSource {
  const captured = JSON.parse(canonicalJson({ source, expected })) as { source: ValueSource; expected: JsonValue };
  const { kind: _kind, ...task } = resolve(compiled, state, lexicalScopes(consumerNodeInstanceId), captured.source, captured.expected, "task");
  return task;
}

/** Traces a protected value to the exact succeeded node kind that issued it. */
export function resolveFactoryProtectedNodeSource(compiled: CompiledFactory, state: KernelState, consumerNodeInstanceId: string, source: ValueSource, expected: JsonValue, expectedKind: FactoryNode["kind"]): FactoryProtectedNodeSource {
  const captured = JSON.parse(canonicalJson({ source, expected, expectedKind })) as { source: ValueSource; expected: JsonValue; expectedKind: FactoryNode["kind"] };
  return resolve(compiled, state, lexicalScopes(consumerNodeInstanceId), captured.source, captured.expected, captured.expectedKind);
}
