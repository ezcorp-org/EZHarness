import { advanceKernel, FactoryKernelError } from "@ezcorp/factory-sdk/kernel";
import { factoryGraphNodes } from "@ezcorp/factory-sdk";
import type { CompiledFactory, FactoryReference, FactoryRunRevisionBody } from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryDefinitions } from "./definitions";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { FactoryMutations } from "./mutations";
import { assertFactoryIdentity, encodeFactoryPayload, type FactoryRunKey } from "./records";
import type { FactoryRunInputs } from "./run-inputs";
import type { FactoryRunLifecycle, FactoryRunRequest } from "./run-lifecycle";
import { FactoryTransitionAuthorityError, type FactoryCurrentNode, type FactoryTransitionAuthority } from "./transition-authority";

export class FactoryRunControlError extends Error {
  constructor(readonly code: "factory_control_invalid" | "factory_control_stale" | "factory_control_widening" | "factory_control_corrupt") { super(code); this.name = "FactoryRunControlError"; }
}

function subset(values: readonly string[], existing: readonly string[]): boolean {
  const allowed = new Set(existing);
  return values.every(value => allowed.has(value));
}

/** Declared demand dimensions. A replacement may ask for less along each of them, never more. */
const LIMIT_DIMENSIONS = ["maxCostMicros", "maxTokens", "maxComputeMs", "memoryBytes"] as const;
type LimitDimension = (typeof LIMIT_DIMENSIONS)[number];

/**
 * The most any single node of a revision declares it may consume, and every class it may ask for.
 *
 * An absent declaration asks for nothing, so a revision that declares no resources at all is
 * bounded by every revision. The parent's delegated envelope still caps actual spend; this compares
 * only what each revision says it needs, which is what an operator is authorizing at replan time.
 */
function declaredCeiling(factory: CompiledFactory): { readonly limits: Readonly<Record<LimitDimension, bigint>>; readonly classes: ReadonlySet<string> } {
  const limits: Record<LimitDimension, bigint> = { maxCostMicros: 0n, maxTokens: 0n, maxComputeMs: 0n, memoryBytes: 0n };
  const classes = new Set<string>();
  for (const node of factoryGraphNodes(factory.definition.graph)) {
    const declared = [node.resources, node.kind === "loop" ? node.budget : undefined];
    for (const bounds of declared) {
      if (!bounds) continue;
      for (const dimension of LIMIT_DIMENSIONS) {
        const value = (bounds as Partial<Record<LimitDimension, string | number>>)[dimension];
        if (value === undefined) continue;
        const parsed = typeof value === "number" ? (Number.isSafeInteger(value) ? BigInt(value) : undefined) : /^\d+$/.test(value) ? BigInt(value) : undefined;
        if (parsed === undefined) throw new FactoryRunControlError("factory_control_corrupt");
        if (parsed > limits[dimension]) limits[dimension] = parsed;
      }
    }
    if (node.resources?.resourceClass !== undefined) classes.add(node.resources.resourceClass);
  }
  return { limits, classes };
}

/**
 * Whether a replacement revision stays inside the authority the run already holds.
 *
 * Exported so every denial can be proved on its own. The protected acceptance contract and both
 * port records must be identical, because a changed contract or a changed boundary is a different
 * agreement and needs a new explicitly authorized run. Bounds, capabilities, effects, declared
 * resource demand, and resource classes may only narrow: any of them growing is a widening of
 * authority that no in-run control may grant.
 */
export function factoryBoundedReplacement(current: CompiledFactory, replacement: CompiledFactory): boolean {
  const before = current.definition;
  const after = replacement.definition;
  const currentCeiling = declaredCeiling(current);
  const replacementCeiling = declaredCeiling(replacement);
  return after.interpreterCompatibility === before.interpreterCompatibility
    && digestObject(after.acceptance) === digestObject(before.acceptance)
    && digestObject(after.inputPorts) === digestObject(before.inputPorts)
    && digestObject(after.outputPorts) === digestObject(before.outputPorts)
    && (after.bounds.runDeadlineMs ?? Number.MAX_SAFE_INTEGER) <= (before.bounds.runDeadlineMs ?? Number.MAX_SAFE_INTEGER)
    && after.bounds.maxExpandedNodes <= before.bounds.maxExpandedNodes
    && after.bounds.maxScopeDepth <= before.bounds.maxScopeDepth
    && subset(after.capabilities, before.capabilities)
    && subset(after.effects, before.effects)
    && LIMIT_DIMENSIONS.every(dimension => replacementCeiling.limits[dimension] <= currentCeiling.limits[dimension])
    && subset([...replacementCeiling.classes], [...currentCeiling.classes]);
}

/** Admits one exact repair/replan event from verified current state into the existing interpreter inbox. */
export class FactoryRunControls {
  private readonly mutations: FactoryMutations;

  constructor(database: TransactionalDb, readonly tenantId: string, private readonly grants: FactoryGrants, private readonly lifecycle: FactoryRunLifecycle, private readonly authority: FactoryTransitionAuthority, private readonly definitions: FactoryDefinitions, private readonly inputs: FactoryRunInputs, private readonly now: () => number = Date.now) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId || lifecycle.tenantId !== tenantId || authority.tenantId !== tenantId) throw new FactoryRunControlError("factory_control_invalid");
    this.mutations = new FactoryMutations(database, tenantId, grants);
  }

  async request(principalValue: FactoryPrincipal, keyValue: FactoryRunKey, bodyValue: FactoryRunRevisionBody, expectedRevision: number, idempotencyKey: string): Promise<FactoryRunRequest> {
    const snapshot = JSON.parse(encodeFactoryPayload({ principal: principalValue, key: keyValue, body: bodyValue })) as { principal: FactoryPrincipal; key: FactoryRunKey; body: FactoryRunRevisionBody };
    const { principal, key, body } = snapshot;
    assertFactoryIdentity(key.projectId, key.runId, body.nodeId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER || (body.reason !== undefined && (!body.reason || body.reason.length > 2048))) throw new FactoryRunControlError("factory_control_invalid");
    return this.mutations.execute({ principal, projectId: key.projectId, action: "factory.run", idempotencyKey, input: { kind: "run.control", ...key, expectedRevision, body } }, async transaction => {
      const current = await this.authority.currentNodeInTransaction(transaction, key, body.nodeId).catch(error => {
        if (error instanceof FactoryTransitionAuthorityError) throw new FactoryRunControlError(error.code === "factory_control_corrupt" ? "factory_control_corrupt" : "factory_control_invalid");
        throw error;
      });
      if (current.fence.revision !== expectedRevision) throw new FactoryRunControlError("factory_control_stale");
      const inputOverride = Object.keys(body.parameters).length === 0 ? undefined : await this.inputs.resolveNodeInTransaction(transaction, key.projectId, body.parameters, current.node.inputPorts ?? {});
      const replacement = body.action === "replan" ? await this.replacementInTransaction(transaction, principal, current, body.replacement) : undefined;
      const reason = body.reason ?? (body.action === "repair" ? "Operator requested repair" : "Operator requested replan");
      const eventId = `factory-control:${digestObject({ tenantId: this.tenantId, ...key, interpreterId: current.interpreterId, sourceSequence: current.sourceSequence, sourceDigest: current.sourceDigest, expectedRevision, body })}`;
      const atMs = this.now();
      const event = body.action === "repair"
        ? { kind: "repair" as const, id: eventId, atMs, nodeId: body.nodeId, reason, ...(inputOverride === undefined ? {} : { inputOverride }) }
        : { kind: "replan" as const, id: eventId, atMs, nodeId: body.nodeId, reason, replacement: replacement!, ...(inputOverride === undefined ? {} : { inputOverride }) };
      this.assertApplies(current, event);
      return this.lifecycle.commitRevisionControlInTransaction(transaction, principal, key, current.interpreterId, expectedRevision, event, { sequence: current.sourceSequence, digest: current.sourceDigest });
    }, async transaction => {
      await this.lifecycle.authorizeRunInTransaction(transaction, key);
      await this.grants.authorizeInTransaction(transaction, principal, key.projectId, "factory.run");
    });
  }

  private async replacementInTransaction(transaction: MigrationDb, principal: FactoryPrincipal, current: FactoryCurrentNode, requested: FactoryReference): Promise<FactoryReference> {
    if (current.node.kind !== "subfactory") throw new FactoryRunControlError("factory_control_invalid");
    const currentReference = current.runtime.factoryOverride ?? current.node.factory;
    if (requested.id !== currentReference.id) throw new FactoryRunControlError("factory_control_widening");
    const before = await this.definitions.readVersionInTransaction(transaction, principal, { projectId: current.fence.projectId, factoryId: currentReference.id }, currentReference.version);
    const after = await this.definitions.readVersionInTransaction(transaction, principal, { projectId: current.fence.projectId, factoryId: requested.id }, requested.version);
    if (before.compiled.digest !== currentReference.digest || after.compiled.digest !== requested.digest) throw new FactoryRunControlError("factory_control_stale");
    if (!factoryBoundedReplacement(before.compiled, after.compiled)) throw new FactoryRunControlError("factory_control_widening");
    return { id: requested.id, version: requested.version, digest: requested.digest };
  }

  private assertApplies(current: FactoryCurrentNode, event: Parameters<typeof advanceKernel>[2]): void {
    let advanced: ReturnType<typeof advanceKernel>;
    try { advanced = advanceKernel(current.compiled, current.state, event); }
    catch (error) { if (error instanceof FactoryKernelError) throw new FactoryRunControlError("factory_control_invalid"); throw error; }
    const next = advanced.nextState.nodes[event.kind === "repair" || event.kind === "replan" ? event.nodeId : ""];
    const pending = event.kind === "repair" || event.kind === "replan" ? advanced.nextState.pendingRepair?.nodeIds.includes(event.nodeId) : false;
    if (!next || (!pending && next.candidateGeneration === current.runtime.candidateGeneration)) throw new FactoryRunControlError("factory_control_invalid");
  }
}
