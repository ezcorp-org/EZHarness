import type { FactoryModelPin, FactoryToolDeclaration, ResourceBounds, RunnerReference } from "@ezcorp/factory-sdk";
import { isUnsignedDecimal } from "@ezcorp/factory-sdk/canonical";
import type { MigrationDb } from "../db/migrations/types";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryBudgetAmount } from "./budgets";
import type { FactoryGrants } from "./grants";
import { normalizePoolResourceVector } from "./pool/ledger";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";
import type { FactoryTaskResourceProfile } from "./task-admission";
import type { FactoryTaskRunnerPolicy, FactoryTaskRunnerPolicyInput, FactoryTaskRunnerResolution } from "./task-execution-admission";

export interface FactoryNativeToolProfile {
  readonly declaration: FactoryToolDeclaration;
  readonly requiredCapabilities: readonly string[];
}

export interface FactoryNativeRunnerProfile {
  readonly runner: RunnerReference;
  readonly resourceClass: string;
  readonly allocation: FactoryTaskResourceProfile;
  readonly allowedCapabilities: readonly string[];
  readonly model?: FactoryModelPin;
  readonly tools: readonly FactoryNativeToolProfile[];
}

export class FactoryNativeRunnerPolicyError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryNativeRunnerPolicyError"; }
}

function snapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function same(left: unknown, right: unknown): boolean {
  return encodeFactoryPayload(left) === encodeFactoryPayload(right);
}

function validAmount(value: FactoryBudgetAmount): boolean {
  return typeof value.costMicros === "string" && value.costMicros.length <= 78 && isUnsignedDecimal(value.costMicros)
    && Number.isSafeInteger(value.tokens) && value.tokens >= 0
    && Number.isSafeInteger(value.computeMs) && value.computeMs >= 0;
}

function withinAmount(value: FactoryBudgetAmount, ceiling: FactoryBudgetAmount, requested: ResourceBounds | undefined): boolean {
  if (!validAmount(value) || !validAmount(ceiling)) return false;
  const requestedCost = requested?.maxCostMicros;
  return BigInt(value.costMicros) <= BigInt(ceiling.costMicros)
    && (requestedCost === undefined || isUnsignedDecimal(requestedCost) && BigInt(value.costMicros) <= BigInt(requestedCost))
    && value.tokens <= ceiling.tokens && (requested?.maxTokens === undefined || value.tokens <= requested.maxTokens)
    && value.computeMs <= ceiling.computeMs && (requested?.maxComputeMs === undefined || value.computeMs <= requested.maxComputeMs);
}

function prefixedDigest(value: unknown): string {
  return `sha256:${digestObject(value)}`;
}

function validModel(runner: RunnerReference, model: FactoryModelPin | undefined): boolean {
  if ((runner.model === undefined) !== (model === undefined)) return false;
  if (!model) return true;
  return runner.model === model.model
    && runner.configurationDigest === model.configurationDigest
    && model.configurationDigest === prefixedDigest(model.configuration)
    && model.policyDigest === prefixedDigest(model.policy);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length && values.every(value => value.length > 0 && value.length <= 512 && !value.includes("\0"));
}

function profileKey(runner: RunnerReference): string {
  return encodeFactoryPayload(runner);
}

/** Exact boot policy for the built-in native runner. It never reads host provider credentials or mutable tool registries. */
export class FactoryNativeRunnerPolicy implements FactoryTaskRunnerPolicy {
  private readonly profiles: ReadonlyMap<string, FactoryNativeRunnerProfile>;

  constructor(
    readonly tenantId: string,
    private readonly grants: Pick<FactoryGrants, "tenantId" | "authorizeInTransaction">,
    values: readonly FactoryNativeRunnerProfile[],
    private readonly brokerAudience: string,
  ) {
    assertFactoryIdentity(tenantId, brokerAudience);
    if (grants.tenantId !== tenantId || values.length === 0) throw new FactoryNativeRunnerPolicyError("factory_native_policy_invalid");
    const profiles = new Map<string, FactoryNativeRunnerProfile>();
    for (const raw of snapshot(values)) {
      assertFactoryIdentity(raw.resourceClass);
      const allocation = { ...raw.allocation, resources: normalizePoolResourceVector(raw.allocation.resources) };
      const toolNames = raw.tools.map(tool => tool.declaration.name);
      if (!Number.isSafeInteger(allocation.memoryBytes) || allocation.memoryBytes < 1 || !validAmount(allocation.budget)
        || !unique(raw.allowedCapabilities) || !unique(toolNames)
        || raw.tools.some(tool => !unique(tool.requiredCapabilities) || tool.requiredCapabilities.some(capability => !raw.allowedCapabilities.includes(capability)))) {
        throw new FactoryNativeRunnerPolicyError("factory_native_policy_invalid");
      }
      const profile = Object.freeze({ ...raw, allocation: Object.freeze(allocation) });
      const key = profileKey(profile.runner);
      if (profiles.has(key)) throw new FactoryNativeRunnerPolicyError("factory_native_policy_invalid");
      profiles.set(key, profile);
    }
    this.profiles = profiles;
  }

  async resolveInTransaction(transaction: MigrationDb, input: FactoryTaskRunnerPolicyInput): Promise<FactoryTaskRunnerResolution> {
    input = snapshot(input);
    const { context, compute } = input;
    if (input.reference.tenantId !== this.tenantId || context.fence.tenantId !== this.tenantId) throw new FactoryNativeRunnerPolicyError("factory_native_policy_scope");
    await this.grants.authorizeInTransaction(transaction, input.initiator, input.reference.projectId, "factory.run", context.fence.grantRevision);
    const profile = this.profiles.get(profileKey(context.node.runner));
    const locked = context.compiled.lock.packages.find(value => value.name === context.node.runner.package);
    if (!profile || !locked || locked.version !== context.node.runner.version || locked.digest !== context.node.runner.digest) throw new FactoryNativeRunnerPolicyError("factory_native_package_untrusted");
    const capabilities = [...(context.node.capabilities ?? [])];
    if (!unique(capabilities) || capabilities.some(capability => !context.compiled.definition.capabilities.includes(capability) || !profile.allowedCapabilities.includes(capability))) throw new FactoryNativeRunnerPolicyError("factory_native_capability_denied");
    const limits = context.node.resources;
    const resourceClass = limits?.resourceClass ?? "cpu";
    const source = compute.request;
    const lease = compute.receipt.lease;
    if (resourceClass !== profile.resourceClass || source.memoryBytes > profile.allocation.memoryBytes || (limits?.memoryBytes !== undefined && limits.memoryBytes > source.memoryBytes)
      || !withinAmount(source.budget, profile.allocation.budget, limits)
      || !same(source.request.resources, profile.allocation.resources) || !same(lease.resources, source.request.resources)
      || source.request.grantScope !== `${this.tenantId}:factory` || source.request.grantRevision !== context.fence.grantRevision
      || source.request.admissionDeadline !== new Date(context.command.deadlineAtMs).toISOString()) {
      throw new FactoryNativeRunnerPolicyError("factory_native_resource_denied");
    }
    if (!validModel(context.node.runner, profile.model)) throw new FactoryNativeRunnerPolicyError("factory_native_model_denied");
    const allowed = new Set(capabilities);
    const tools = profile.tools.filter(tool => tool.requiredCapabilities.every(capability => allowed.has(capability))).map(tool => tool.declaration).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const resources: ResourceBounds = {
      resourceClass,
      memoryBytes: limits?.memoryBytes ?? source.memoryBytes,
      maxCostMicros: source.budget.costMicros,
      maxTokens: source.budget.tokens,
      maxComputeMs: source.budget.computeMs,
    };
    return snapshot({ grants: capabilities.sort(), resources, ...(profile.model ? { model: profile.model } : {}), tools, brokerAudience: this.brokerAudience });
  }
}
