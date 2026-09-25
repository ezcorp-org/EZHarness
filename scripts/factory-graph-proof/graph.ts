/**
 * The W19a graph, its model pins, and the runner profiles that admit it.
 *
 *   input.topic ──▶ prepare ──text──▶ infer ──answer──▶ combine ──summary──▶ output
 *                      └──────────count───────────────────▲
 *
 * Every wired value is a reference (`{ kind: "ref", root, name, path }`); no
 * node reads a literal for a value another node produced. The two proof modes
 * run this same graph and these same guests. Only the model pin differs:
 * mode `ollama` pins the host's Ollama, mode `mock` pins the product's
 * in-process prompt-digest fake.
 *
 * Pure data and pure functions, so `src/factory/graph-proof-definition.test.ts`
 * compiles exactly what the harness submits.
 */
import { createHash } from "node:crypto";
import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import type { FactoryModelPin, JsonValue, RunnerReference } from "@ezcorp/factory-sdk";

export type GraphProofMode = "ollama" | "mock";

/** The package every node runs, built once from `guest/graph-guest.ts`. */
export interface GraphGuestPackage {
  readonly package: string;
  readonly manifestName: string;
  readonly version: string;
  readonly digest: string;
}

export const GRAPH_GUEST_PACKAGE = "@ezcorp/w19a-graph-guest";
export const GRAPH_GUEST_MANIFEST = "w19a-graph-guest";
export const GRAPH_GUEST_VERSION = "1.0.0";
export const GRAPH_TOPIC = "the primary colours of light";

/** The sampling both modes pin. Ollama honours all three; the mock ignores them. */
export const GRAPH_MODEL_CONFIGURATION = Object.freeze({ temperature: 0, seed: 42, reasoningEffort: "none" });
const GRAPH_MODEL_POLICY = Object.freeze({ tools: false });

/** The host's Ollama, as `ollama list` names it. */
export const OLLAMA_MODEL = "qwen3:1.7b";
/** A model the operator registers and Ollama does not have: the missing-model control. */
export const OLLAMA_MISSING_MODEL = "qwen3:w19a-missing";
/** The product's own prompt-digest fake, reached only with the test surface open. */
export const MOCK_PROVIDER = "ezcorp-mock";
export const MOCK_MODEL = "prompt-digest:w19a";

function digestOf(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalizeJson(value)).digest("hex")}`;
}

export function graphModelPin(provider: string, model: string): FactoryModelPin {
  return Object.freeze({
    provider,
    model,
    configuration: GRAPH_MODEL_CONFIGURATION,
    configurationDigest: digestOf(GRAPH_MODEL_CONFIGURATION),
    policy: GRAPH_MODEL_POLICY,
    policyDigest: digestOf(GRAPH_MODEL_POLICY),
  });
}

/** The pin a mode's `infer` node runs under. */
export function modePin(mode: GraphProofMode): FactoryModelPin {
  return mode === "ollama" ? graphModelPin("ollama", OLLAMA_MODEL) : graphModelPin(MOCK_PROVIDER, MOCK_MODEL);
}

export interface GraphReferences {
  readonly prepare: RunnerReference;
  readonly infer: RunnerReference;
  readonly combine: RunnerReference;
}

/** The three exports of one package. `infer` names its model exactly when a pin is given. */
export function graphReferences(guest: GraphGuestPackage, pin: FactoryModelPin | undefined): GraphReferences {
  const at = (name: string): RunnerReference => ({ ...guest, export: name });
  return {
    prepare: at("prepare"),
    infer: pin === undefined ? at("infer") : { ...at("infer"), model: pin.model, configurationDigest: pin.configurationDigest },
    combine: at("combine"),
  };
}

/** Each node's resource class. The startup document keys admission by class, so three nodes need three. */
export const GRAPH_RESOURCE_CLASSES = Object.freeze({ prepare: "cpu", infer: "cpu-infer", combine: "cpu-combine" });

const ref = (root: "input" | "node", name: string, ...path: string[]): JsonValue =>
  (path.length === 0 ? { kind: "ref", root, name } : { kind: "ref", root, name, path }) as JsonValue;

/**
 * The factory definition.
 *
 * `badPort` replaces the binding of `combine.answer` with a reference to an
 * output port `infer` does not declare. It is the compile-time control: the
 * product must refuse the definition by name before anything runs.
 */
export function graphDefinition(options: { readonly id: string; readonly references: GraphReferences; readonly badPort?: boolean }): Record<string, JsonValue> {
  const { references } = options;
  const retry = { maxAttempts: 1, initialDelayMs: 1_000, maximumDelayMs: 2_000 };
  return {
    schemaVersion: "factory.v1",
    id: options.id,
    version: "1.0.0",
    interpreterCompatibility: "factory-kernel.v1",
    inputPorts: { topic: { type: "string", minLength: 1, maxLength: 512 } },
    outputPorts: { summary: { type: "string" } },
    graph: {
      nodes: [
        {
          id: "prepare", kind: "task", runner: references.prepare as unknown as JsonValue,
          inputPorts: { topic: { type: "string" } },
          outputPorts: { text: { type: "string" }, count: { type: "integer", minimum: 0 } },
          bindings: { topic: ref("input", "topic") },
          retry, resources: { resourceClass: GRAPH_RESOURCE_CLASSES.prepare },
        },
        {
          id: "infer", kind: "task", runner: references.infer as unknown as JsonValue,
          inputPorts: { text: { type: "string" } },
          outputPorts: {
            answer: { type: "string" },
            usage: { type: "object", properties: { inputTokens: { type: "integer", minimum: 0 }, outputTokens: { type: "integer", minimum: 0 } }, required: ["inputTokens", "outputTokens"], additionalProperties: false },
          },
          bindings: { text: ref("node", "prepare", "text") },
          dependsOn: ["prepare"],
          retry, resources: { resourceClass: GRAPH_RESOURCE_CLASSES.infer },
        },
        {
          id: "combine", kind: "task", runner: references.combine as unknown as JsonValue,
          inputPorts: { count: { type: "integer", minimum: 0 }, answer: { type: "string" } },
          outputPorts: { summary: { type: "string" } },
          bindings: { count: ref("node", "prepare", "count"), answer: options.badPort ? ref("node", "infer", "reply") : ref("node", "infer", "answer") },
          dependsOn: ["prepare", "infer"],
          retry, resources: { resourceClass: GRAPH_RESOURCE_CLASSES.combine },
        },
      ],
      outputs: { summary: ref("node", "combine", "summary") },
    },
    acceptance: { id: `${options.id}.contract`, version: "1", claims: [{ id: "claim", validator: references.prepare as unknown as JsonValue, required: true, protected: true }] },
    packages: [{ name: references.prepare.package, version: references.prepare.version, digest: references.prepare.digest }],
    capabilities: [],
    effects: ["none"],
    bounds: { maxExpandedNodes: 10, maxScopeDepth: 16, runDeadlineMs: 600_000 },
  };
}

/** The startup document's runner profiles: one per node, `infer`'s carrying the pin. */
export function graphRunnerProfiles(references: GraphReferences, pin: FactoryModelPin | undefined): Record<string, JsonValue> {
  const allocation = { resources: { cpu: 1 }, memoryBytes: 1_073_741_824, budget: { costMicros: "1000000", tokens: 10_000, computeMs: 600_000 } };
  const profile = (runner: RunnerReference, resourceClass: string, model?: FactoryModelPin) => ({
    runner: runner as unknown as JsonValue, resourceClass, allocation, allowedCapabilities: [],
    ...(model === undefined ? {} : { model: model as unknown as JsonValue }),
  });
  return {
    brokerAudience: "factory-gateway",
    profiles: [
      profile(references.prepare, GRAPH_RESOURCE_CLASSES.prepare),
      profile(references.infer, GRAPH_RESOURCE_CLASSES.infer, pin),
      profile(references.combine, GRAPH_RESOURCE_CLASSES.combine),
    ],
  };
}
