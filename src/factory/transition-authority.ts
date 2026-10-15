import { assertKernelContinuationState, nodeFor } from "@ezcorp/factory-sdk/kernel";
import type { FactoryNode, KernelNodeState, KernelState } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { FactoryPrincipal } from "./grants";
import { FactoryArtifactError } from "./artifacts";
import { assertFactoryIdentity, type FactoryRunKey } from "./records";
import type { FactoryRunFence, FactoryRunLifecycle } from "./run-lifecycle";
import type { FactoryTransitionArtifacts } from "./transition-artifacts";

type HeadRow = { interpreter_id: string; source_sequence: number | string; digest: string };

export interface FactoryCurrentNode {
  readonly interpreterId: string;
  readonly sourceSequence: number;
  readonly sourceDigest: string;
  readonly node: FactoryNode;
  readonly runtime: KernelNodeState;
  readonly state: KernelState;
  readonly fence: FactoryRunFence;
  readonly initiator: FactoryPrincipal;
  readonly compiled: Awaited<ReturnType<FactoryRunLifecycle["readExecutionPlanInTransaction"]>>["compiled"];
}

export class FactoryTransitionAuthorityError extends Error {
  constructor(readonly code: "factory_control_not_current" | "factory_control_corrupt") { super(code); this.name = "FactoryTransitionAuthorityError"; }
}

/** Resolves one exact node from the verified latest interpreter transition while the canonical run row is locked. */
export class FactoryTransitionAuthority {
  constructor(readonly tenantId: string, private readonly lifecycle: FactoryRunLifecycle, private readonly transitions: FactoryTransitionArtifacts) {
    assertFactoryIdentity(tenantId);
    if (lifecycle.tenantId !== tenantId) throw new FactoryTransitionAuthorityError("factory_control_corrupt");
  }

  async currentNodeInTransaction(transaction: MigrationDb, keyValue: FactoryRunKey, nodeId: string): Promise<FactoryCurrentNode> {
    const key = { projectId: keyValue.projectId, runId: keyValue.runId };
    assertFactoryIdentity(key.projectId, key.runId, nodeId);
    const plan = await this.lifecycle.readExecutionPlanInTransaction(transaction, key);
    const heads = rows<HeadRow>(await transaction.execute(sql`SELECT DISTINCT ON (interpreter_id) interpreter_id,source_sequence,digest FROM factory_audit_batches WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} ORDER BY interpreter_id,source_sequence DESC LIMIT 10001`));
    if (heads.length === 0) throw new FactoryTransitionAuthorityError("factory_control_not_current");
    if (heads.length > 10_000) throw new FactoryTransitionAuthorityError("factory_control_corrupt");
    const candidates: FactoryCurrentNode[] = [];
    for (const head of heads) {
      const sourceSequence = Number(head.source_sequence);
      if (!Number.isSafeInteger(sourceSequence) || sourceSequence < 1 || !/^[a-f0-9]{64}$/.test(head.digest)) throw new FactoryTransitionAuthorityError("factory_control_corrupt");
      const transition = await this.transitions.loadCommittedTransition({ tenantId: this.tenantId, projectId: key.projectId, logicalRunId: key.runId, interpreterId: head.interpreter_id }, sourceSequence, transaction).catch(error => {
        if (error instanceof FactoryArtifactError) throw new FactoryTransitionAuthorityError("factory_control_corrupt");
        throw error;
      });
      const state = transition.nextState;
      try { assertKernelContinuationState(plan.compiled, state); }
      catch { throw new FactoryTransitionAuthorityError("factory_control_corrupt"); }
      const expectedInterpreter = state.partition?.id ?? "root";
      if (expectedInterpreter !== head.interpreter_id || state.logicalRunId !== key.runId || state.definitionDigest !== plan.fence.definitionDigest || state.runDeadlineAtMs !== plan.fence.deadlineAtMs || state.cancellationEpoch !== plan.fence.cancellationEpoch) throw new FactoryTransitionAuthorityError("factory_control_not_current");
      if (!Object.hasOwn(state.nodes, nodeId)) continue;
      const runtime = state.nodes[nodeId]!;
      const node = nodeFor(plan.compiled, nodeId);
      if (!node || !["running", "waiting"].includes(state.status) || state.pendingRepair || runtime.status === "blocked" || runtime.status === "ready" || runtime.status === "stopping" || runtime.attempts.some(attempt => attempt.uncertain)) throw new FactoryTransitionAuthorityError("factory_control_not_current");
      candidates.push({ interpreterId: head.interpreter_id, sourceSequence, sourceDigest: head.digest, node, runtime, state, ...plan });
    }
    if (candidates.length !== 1) throw new FactoryTransitionAuthorityError(candidates.length === 0 ? "factory_control_not_current" : "factory_control_corrupt");
    return candidates[0]!;
  }
}
