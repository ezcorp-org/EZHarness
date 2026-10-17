/**
 * The pool's closed sets, alone, so a process that loads TypeScript with type
 * stripping only (the Node orchestrator, through the metric registry) can read
 * them without loading the ledger.
 */

/** The only resource profiles admitted by the C03 pool ledger. */
export const POOL_RESOURCE_CLASSES = ["cpu", "memory", "provider", "gpu-host"] as const;
export type PoolResourceClass = typeof POOL_RESOURCE_CLASSES[number];
/**
 * Durable reservation states. C03's table names the first state `requested` and
 * lists no rejection state; the ledger keeps the durable names `queued` and
 * `rejected`, which the `factory_pool_requests` CHECK constraint is built
 * from. `docs/factory-pool-admission.md` records the exact mapping and why the
 * names differ; POOL_STATE_CONTRACT_MAPPING is its executable copy.
 */
export const POOL_LEASE_STATES = ["queued", "held", "running", "revoking", "uncertain", "settled", "rejected"] as const;
export type PoolLeaseState = typeof POOL_LEASE_STATES[number];
