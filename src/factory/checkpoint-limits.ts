import { FACTORY_CHECKPOINT_MAX_AGE_SECONDS } from "../db/migrations/add-factory-recovery";

/**
 * The part of C06's checkpoint barrier (W15) that the pool service shares: the
 * limits and the two pool-side sources. The pool runs on Node, so this module
 * must stay a leaf: the barrier itself links the product database driver,
 * which a Node bundle cannot load. `checkpoint-barrier` re-exports all of it.
 */

export const FACTORY_CHECKPOINT_LIMITS = Object.freeze({
  targetMs: 2_000,
  maximumMs: 10_000,
  maxConcurrentBarriers: 16,
  maxAgeMs: FACTORY_CHECKPOINT_MAX_AGE_SECONDS * 1_000,
  /** The longest the drain step waits for in-flight senders before fencing them. */
  drainMs: 1_000,
  pollMs: 5,
  /** A seal write starts only with this much of the maximum left, so a claimed seal is never written after it. */
  sealMarginMs: 500,
});

export interface FactoryCheckpointPoolSnapshot {
  /** The pool database's own position for the snapshot. */
  readonly position: string;
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * The cluster-wide barrier limit (C06/C12). The pool service holds sixteen
 * slots for every tenant that shares it; a barrier runs only while it holds
 * one, so at most sixteen barriers are in flight across the deployment.
 */
export interface FactoryCheckpointSlotSource {
  /** A slot token, or null when every slot is held by another tenant. */
  acquire(signal?: AbortSignal): Promise<{ readonly token: string } | null>;
  release(token: string, signal?: AbortSignal): Promise<void>;
}

/** The tenant's rows of the shared pool ledger, read in one pool transaction. */
export interface FactoryCheckpointPoolSource {
  snapshotTenant(tenantId: string, signal?: AbortSignal): Promise<FactoryCheckpointPoolSnapshot>;
}
