import { randomUUID } from "node:crypto";

/** The only resource profiles admitted by the C03 pool ledger. */
export const POOL_RESOURCE_CLASSES = ["cpu", "memory", "provider", "gpu-host"] as const;
export type PoolResourceClass = typeof POOL_RESOURCE_CLASSES[number];
export type PoolResourceVector = Readonly<Partial<Record<PoolResourceClass, number>>>;
/**
 * Durable reservation states. C03's table names the first state `requested` and
 * lists no rejection state; this ledger keeps the durable names `queued` and
 * `rejected`, which the `factory_pool_requests` CHECK constraint below is built
 * from. `docs/factory-pool-admission.md` records the exact mapping and why the
 * names differ; POOL_STATE_CONTRACT_MAPPING is its executable copy.
 */
export const POOL_LEASE_STATES = ["queued", "held", "running", "revoking", "uncertain", "settled", "rejected"] as const;
export type PoolLeaseState = typeof POOL_LEASE_STATES[number];

/** The six reservation states named by the C03 contract table, in contract order. */
export const C03_RESERVATION_STATES = ["requested", "held", "running", "revoking", "uncertain", "settled"] as const;
export type C03ReservationState = typeof C03_RESERVATION_STATES[number];

/**
 * Ledger state to C03 contract state. `queued` and `rejected` are both the
 * contract's `requested` row: "wait for budget/capacity or fail by the
 * admission deadline". A rejected request never held capacity.
 */
export const POOL_STATE_CONTRACT_MAPPING: Readonly<Record<PoolLeaseState, C03ReservationState>> = Object.freeze({
  queued: "requested",
  held: "held",
  running: "running",
  revoking: "revoking",
  uncertain: "uncertain",
  settled: "settled",
  rejected: "requested",
});

/** Structural Bun.sql subset; this database is intentionally not the product database. */
export interface PoolSql {
  unsafe(query: string, params?: readonly unknown[]): Promise<unknown>;
  begin<Result>(work: (transaction: PoolSql) => Promise<Result>): Promise<Result>;
}

export interface PoolClock { now(): Date }
export interface PoolRequest {
  reservationId: string;
  tenantId: string;
  grantRevision: number;
  resources: PoolResourceVector;
  priority?: number;
  readySequence?: number;
  nodeId?: string;
  admissionDeadline: Date;
}
export interface PoolTenantPolicy {
  tenantId: string;
  weight?: number;
  reservedMinimum?: PoolResourceVector;
}
export interface PoolLeaseFence {
  reservationId: string;
  tenantId: string;
  grantRevision: number;
  allocationGeneration: number;
  allocationToken: string;
}
export interface PoolStopConfirmation {
  reservationId: string;
  holderGeneration: number;
  hostId?: string;
}
export interface PoolHostRegistration { hostId: string }
export interface PoolGpuReimageReceipt {
  reservationId: string;
  hostId: string;
  holderGeneration: number;
  receipt: string;
}
export interface PoolDecision {
  status: "queued" | "rejected" | "admitted" | "cancelled";
  reservationId: string;
  reason?: string;
  retryAfterSeconds?: number;
  queueAgeMs?: number;
  blockingResource?: PoolResourceClass;
  lease?: PoolLease;
}
export interface PoolLease {
  reservationId: string;
  tenantId: string;
  grantRevision: number;
  allocationGeneration: number;
  holderGeneration: number;
  allocationToken: string;
  fence: string;
  deadlineAt: Date;
  resources: PoolResourceVector;
  hostId?: string;
}
export interface PoolLeaseStatus {
  reservationId: string;
  tenantId: string;
  state: PoolLeaseState;
  allocationGeneration: number;
  holderGeneration: number;
  effects: number;
  resources: PoolResourceVector;
  hostId?: string;
  reason?: string;
}

const leaseMs = 30_000;
const ageLaneMs = 30_000;
const resourceSet = new Set<string>(POOL_RESOURCE_CLASSES);

export interface PoolQueueLimits {
  /** Outstanding admission requests allowed for one tenant. */
  readonly perTenant: number;
  /** Outstanding admission requests allowed across the whole pool. */
  readonly pool: number;
}

/** C03 bounds outstanding admission requests at 10,000 per tenant and 100,000 per pool. */
export const POOL_DEFAULT_QUEUE_LIMITS: PoolQueueLimits = Object.freeze({ perTenant: 10_000, pool: 100_000 });

/** C03 rejects a new start on a full queue with HTTP 429 and a retry interval. */
export const POOL_QUEUE_FULL_REASON = "queue-full";
export const POOL_QUEUE_FULL_HTTP_STATUS = 429;
export const POOL_QUEUE_FULL_RETRY_SECONDS = 1;

/** A deployment may tighten an outstanding-request bound. It may never raise one. */
function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Pool outstanding-request limit must be a whole number between 1 and the C03 maximum.");
  return value;
}

function rows<Result>(result: unknown): Result[] {
  if (Array.isArray(result)) return result as Result[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return result.rows as Result[];
  throw new Error("Pool ledger received an unsupported PostgreSQL result.");
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function validOpaque(value: string): boolean {
  return value.length > 0 && value.length <= 256 && ![...value].some(character => character.codePointAt(0)! < 32);
}

function assertOpaque(value: string, label: string): void {
  if (!validOpaque(value)) throw new Error(`Pool ${label} is malformed.`);
}

function assertCounter(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Pool ${label} is malformed.`);
}

export function normalizePoolResourceVector(vector: PoolResourceVector): PoolResourceVector {
  if (!vector || typeof vector !== "object" || Array.isArray(vector)) throw new Error("Pool resource vector is malformed.");
  const output = Object.create(null) as Record<PoolResourceClass, number>;
  let count = 0;
  for (const key of Object.keys(vector)) {
    if (!resourceSet.has(key)) throw new Error("Pool resource class is unsupported.");
    const value = vector[key as PoolResourceClass];
    if (!Number.isSafeInteger(value) || value === undefined || value <= 0 || value > 1_000_000) throw new Error("Pool resource quantity is malformed.");
    output[key as PoolResourceClass] = value;
    count += 1;
  }
  if (count === 0) throw new Error("Pool resource vector is empty.");
  if (output["gpu-host"] !== undefined && output["gpu-host"] !== 1) throw new Error("A GPU admission must request one whole host.");
  return output;
}

function decodeVector(value: unknown): PoolResourceVector {
  const decoded = typeof value === "string" ? JSON.parse(value) : value;
  return normalizePoolResourceVector(decoded as PoolResourceVector);
}

function vectorJson(vector: PoolResourceVector): string {
  const normal = normalizePoolResourceVector(vector);
  const ordered = Object.create(null) as Record<string, number>;
  for (const resource of POOL_RESOURCE_CLASSES) if (normal[resource] !== undefined) ordered[resource] = normal[resource];
  return JSON.stringify(ordered);
}

function vectorEqual(left: PoolResourceVector, right: PoolResourceVector): boolean {
  return vectorJson(left) === vectorJson(right);
}

function asDate(value: unknown): Date {
  const output = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(output.getTime())) throw new Error("Pool ledger stored an invalid timestamp.");
  return output;
}

function iso(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Pool timestamp is malformed.");
  return date.toISOString();
}

function activeResources(row: RequestRow): PoolResourceVector {
  const vector = decodeVector(row.resources_json);
  if (row.reason === "awaiting-gpu-reimage") {
    const gpu = vector["gpu-host"];
    return gpu === undefined ? Object.create(null) as Record<PoolResourceClass, number> : Object.assign(Object.create(null), { "gpu-host": gpu });
  }
  return vector;
}

interface ResourceRow { resource_class: PoolResourceClass; total_units: number | string; allocated_units: number | string }
interface RequestRow {
  reservation_id: string; tenant_id: string; grant_revision: number | string; resources_json: unknown;
  priority: number | string; ready_sequence: number | string; node_id: string; queued_at: unknown;
  admission_deadline: unknown; state: PoolLeaseState; allocation_generation: number | string; holder_generation: number | string;
  allocation_token: string | null; fence: string; lease_deadline: unknown | null; host_id: string | null; effects: number | string; reason: string | null;
}
interface HostRow { host_id: string; state: string; reservation_id: string | null; holder_generation: number | string | null }

function readRequest(row: RequestRow): PoolLeaseStatus {
  return {
    reservationId: row.reservation_id,
    tenantId: row.tenant_id,
    state: row.state,
    allocationGeneration: Number(row.allocation_generation),
    holderGeneration: Number(row.holder_generation),
    effects: Number(row.effects),
    resources: decodeVector(row.resources_json),
    ...(row.host_id ? { hostId: row.host_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

function toLease(row: RequestRow): PoolLease {
  if (!row.allocation_token || !row.lease_deadline) throw new Error("Pool admission row is incomplete.");
  return {
    reservationId: row.reservation_id,
    tenantId: row.tenant_id,
    grantRevision: Number(row.grant_revision),
    allocationGeneration: Number(row.allocation_generation),
    holderGeneration: Number(row.holder_generation),
    allocationToken: row.allocation_token,
    fence: row.fence,
    deadlineAt: asDate(row.lease_deadline),
    resources: decodeVector(row.resources_json),
    ...(row.host_id ? { hostId: row.host_id } : {}),
  };
}

/**
 * Additive bootstrap for the independent C03 PostgreSQL database. It must not
 * be called by the product `migrate()` path.
 */
export async function setupFactoryPoolLedger(database: Pick<PoolSql, "unsafe">): Promise<void> {
  await database.unsafe(`CREATE TABLE IF NOT EXISTS factory_pool_resources (
    resource_class text PRIMARY KEY CHECK (resource_class IN ('cpu', 'memory', 'provider', 'gpu-host')),
    total_units integer NOT NULL CHECK (total_units >= 0),
    allocated_units integer NOT NULL DEFAULT 0 CHECK (allocated_units >= 0 AND allocated_units <= total_units)
  )`);
  // The ledger bootstrap is additive. Existing C03 pools predate memory, so
  // replace only this closed enum check before admitting a memory reservation.
  await database.unsafe("ALTER TABLE factory_pool_resources DROP CONSTRAINT IF EXISTS factory_pool_resources_resource_class_check");
  await database.unsafe("ALTER TABLE factory_pool_resources ADD CONSTRAINT factory_pool_resources_resource_class_check CHECK (resource_class IN ('cpu', 'memory', 'provider', 'gpu-host'))");
  await database.unsafe(`CREATE TABLE IF NOT EXISTS factory_pool_tenants (
    tenant_id text PRIMARY KEY,
    weight integer NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 1000)
  )`);
  await database.unsafe(`CREATE TABLE IF NOT EXISTS factory_pool_tenant_minima (
    tenant_id text NOT NULL REFERENCES factory_pool_tenants(tenant_id) ON DELETE CASCADE,
    resource_class text NOT NULL REFERENCES factory_pool_resources(resource_class),
    minimum_units integer NOT NULL CHECK (minimum_units >= 0),
    PRIMARY KEY (tenant_id, resource_class)
  )`);
  await database.unsafe(`CREATE TABLE IF NOT EXISTS factory_pool_round_members (
    resource_class text NOT NULL REFERENCES factory_pool_resources(resource_class),
    tenant_id text NOT NULL,
    PRIMARY KEY (resource_class, tenant_id)
  )`);
  await database.unsafe(`CREATE TABLE IF NOT EXISTS factory_pool_hosts (
    host_id text PRIMARY KEY,
    state text NOT NULL CHECK (state IN ('available', 'assigned', 'quarantined', 'reimage_required')),
    reservation_id text UNIQUE,
    tenant_id text,
    holder_generation integer,
    reimage_receipt text
  )`);
  await database.unsafe(`CREATE TABLE IF NOT EXISTS factory_pool_requests (
    reservation_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    grant_revision integer NOT NULL CHECK (grant_revision >= 0),
    resources_json jsonb NOT NULL,
    priority integer NOT NULL DEFAULT 0,
    ready_sequence bigint NOT NULL DEFAULT 0,
    node_id text NOT NULL DEFAULT '',
    queued_at timestamptz NOT NULL,
    admission_deadline timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN (${POOL_LEASE_STATES.map(state => `'${state}'`).join(", ")})),
    allocation_generation integer NOT NULL DEFAULT 1 CHECK (allocation_generation > 0),
    holder_generation integer NOT NULL DEFAULT 0 CHECK (holder_generation >= 0),
    allocation_token text,
    fence text NOT NULL,
    lease_deadline timestamptz,
    host_id text REFERENCES factory_pool_hosts(host_id),
    effects integer NOT NULL DEFAULT 0 CHECK (effects >= 0),
    reason text
  )`);
  await database.unsafe("CREATE INDEX IF NOT EXISTS factory_pool_requests_queue ON factory_pool_requests (state, queued_at, priority DESC, ready_sequence, node_id)");
  await database.unsafe("CREATE INDEX IF NOT EXISTS factory_pool_requests_tenant_queue ON factory_pool_requests (tenant_id, state)");
}

export class FactoryPoolLedger {
  private readonly limits: PoolQueueLimits;

  constructor(private readonly database: PoolSql, private readonly clock: PoolClock = { now: () => new Date() }, limits: Partial<PoolQueueLimits> = {}) {
    this.limits = Object.freeze({ perTenant: boundedLimit(limits.perTenant, POOL_DEFAULT_QUEUE_LIMITS.perTenant), pool: boundedLimit(limits.pool, POOL_DEFAULT_QUEUE_LIMITS.pool) });
  }

  /** The outstanding-request bounds this ledger compares against. */
  get queueLimits(): PoolQueueLimits { return this.limits; }

  /** Validate and snapshot a request before any caller writes related durable facts. */
  validateRequest(input: PoolRequest): PoolRequest {
    assertOpaque(input.reservationId, "reservation id"); assertOpaque(input.tenantId, "tenant id"); assertCounter(input.grantRevision, "grant revision");
    const resources = normalizePoolResourceVector(input.resources); iso(input.admissionDeadline);
    if (input.admissionDeadline.getTime() <= this.clock.now().getTime()) throw new Error("Pool admission deadline has expired.");
    if (input.priority !== undefined) assertCounter(input.priority, "priority");
    if (input.readySequence !== undefined) assertCounter(input.readySequence, "ready sequence");
    if (input.nodeId !== undefined) assertOpaque(input.nodeId, "node id");
    return { reservationId: input.reservationId, tenantId: input.tenantId, grantRevision: input.grantRevision, resources, admissionDeadline: new Date(input.admissionDeadline), ...(input.priority === undefined ? {} : { priority: input.priority }), ...(input.readySequence === undefined ? {} : { readySequence: input.readySequence }), ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }) };
  }

  async configureCapacity(resourceClass: Exclude<PoolResourceClass, "gpu-host">, totalUnits: number): Promise<void> {
    if (resourceClass !== "cpu" && resourceClass !== "memory" && resourceClass !== "provider") throw new Error("GPU capacity is derived only from registered hosts.");
    assertCounter(totalUnits, "capacity");
    await this.database.begin(async (transaction) => {
      await this.lock(transaction);
      const current = rows<ResourceRow>(await transaction.unsafe("SELECT resource_class, total_units, allocated_units FROM factory_pool_resources WHERE resource_class = $1 FOR UPDATE", [resourceClass]))[0];
      if (current && Number(current.allocated_units) > totalUnits) throw new Error("Pool capacity cannot drop below allocated capacity.");
      const minima = rows<{ units: number | string }>(await transaction.unsafe("SELECT COALESCE(SUM(minimum_units), 0) AS units FROM factory_pool_tenant_minima WHERE resource_class = $1", [resourceClass]))[0];
      if (Number(minima?.units ?? 0) > totalUnits) throw new Error("Pool capacity cannot drop below tenant reserved minima.");
      await transaction.unsafe("INSERT INTO factory_pool_resources(resource_class, total_units, allocated_units) VALUES ($1, $2, 0) ON CONFLICT(resource_class) DO UPDATE SET total_units = EXCLUDED.total_units", [resourceClass, totalUnits]);
    });
  }

  async registerGpuHost(input: PoolHostRegistration): Promise<void> {
    assertOpaque(input.hostId, "host id");
    await this.database.begin(async (transaction) => {
      await this.lock(transaction);
      const prior = rows<HostRow>(await transaction.unsafe("SELECT host_id, state, reservation_id, holder_generation FROM factory_pool_hosts WHERE host_id = $1 FOR UPDATE", [input.hostId]))[0];
      if (prior) return;
      await transaction.unsafe("INSERT INTO factory_pool_hosts(host_id, state) VALUES ($1, 'available')", [input.hostId]);
      await transaction.unsafe("INSERT INTO factory_pool_resources(resource_class, total_units, allocated_units) VALUES ('gpu-host', 1, 0) ON CONFLICT(resource_class) DO UPDATE SET total_units = factory_pool_resources.total_units + 1");
    });
  }

  async setTenantPolicy(policy: PoolTenantPolicy): Promise<void> {
    assertOpaque(policy.tenantId, "tenant id");
    const weight = policy.weight ?? 1;
    assertCounter(weight, "tenant weight", 1);
    const minimum = policy.reservedMinimum ? normalizePoolResourceVector(policy.reservedMinimum) : Object.create(null) as Record<PoolResourceClass, number>;
    await this.database.begin(async (transaction) => {
      await this.lock(transaction);
      await transaction.unsafe("INSERT INTO factory_pool_tenants(tenant_id, weight) VALUES ($1, $2) ON CONFLICT(tenant_id) DO UPDATE SET weight = EXCLUDED.weight", [policy.tenantId, weight]);
      await transaction.unsafe("DELETE FROM factory_pool_tenant_minima WHERE tenant_id = $1", [policy.tenantId]);
      for (const resourceClass of POOL_RESOURCE_CLASSES) {
        const units = minimum[resourceClass];
        if (units !== undefined) {
          const capacity = rows<ResourceRow>(await transaction.unsafe("SELECT resource_class, total_units, allocated_units FROM factory_pool_resources WHERE resource_class = $1", [resourceClass]))[0];
          if (!capacity || units > Number(capacity.total_units)) throw new Error("Tenant reserved minimum exceeds pool capacity.");
          await transaction.unsafe("INSERT INTO factory_pool_tenant_minima(tenant_id, resource_class, minimum_units) VALUES ($1, $2, $3)", [policy.tenantId, resourceClass, units]);
        }
      }
      const aggregate = rows<{ resource_class: PoolResourceClass; minimum_units: number | string; total_units: number | string }>(await transaction.unsafe("SELECT minimum.resource_class, SUM(minimum.minimum_units) AS minimum_units, resource.total_units FROM factory_pool_tenant_minima minimum JOIN factory_pool_resources resource ON resource.resource_class = minimum.resource_class GROUP BY minimum.resource_class, resource.total_units HAVING SUM(minimum.minimum_units) > resource.total_units"));
      if (aggregate.length) throw new Error("Tenant reserved minima exceed pool capacity.");
    });
  }

  async request(input: PoolRequest): Promise<PoolDecision> {
    input = this.validateRequest(input);
    const now = this.clock.now();
    return this.database.begin(async (transaction) => {
      await this.lock(transaction);
      await this.expireLocked(transaction, now);
      const existing = rows<RequestRow>(await transaction.unsafe("SELECT * FROM factory_pool_requests WHERE reservation_id = $1 FOR UPDATE", [input.reservationId]))[0];
      if (existing) {
        if (existing.tenant_id !== input.tenantId || Number(existing.grant_revision) !== input.grantRevision || !vectorEqual(decodeVector(existing.resources_json), input.resources) || Number(existing.priority) !== (input.priority ?? 0) || Number(existing.ready_sequence) !== (input.readySequence ?? 0) || existing.node_id !== (input.nodeId ?? "") || asDate(existing.admission_deadline).getTime() !== input.admissionDeadline.getTime()) throw new Error("Pool reservation id conflicts with a different admission request.");
        return this.decisionFor(existing, now);
      }
      const vector = normalizePoolResourceVector(input.resources);
      const capacities = await this.capacities(transaction, "FOR SHARE");
      for (const resourceClass of POOL_RESOURCE_CLASSES) {
        const units = vector[resourceClass];
        if (units !== undefined && (!Object.hasOwn(capacities, resourceClass) || units > capacities[resourceClass].total)) {
          await transaction.unsafe("INSERT INTO factory_pool_requests(reservation_id, tenant_id, grant_revision, resources_json, priority, ready_sequence, node_id, queued_at, admission_deadline, state, fence, reason) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,'rejected',$10,'request-exceeds-configured-capacity')", [input.reservationId, input.tenantId, input.grantRevision, vectorJson(vector), input.priority ?? 0, input.readySequence ?? 0, input.nodeId ?? "", iso(now), iso(input.admissionDeadline), randomUUID()]);
          return { status: "rejected", reservationId: input.reservationId, reason: "request-exceeds-configured-capacity" };
        }
      }
      const tenantQueued = rows<{ count: number | string }>(await transaction.unsafe("SELECT COUNT(*) AS count FROM factory_pool_requests WHERE tenant_id = $1 AND state = 'queued'", [input.tenantId]))[0];
      const allQueued = rows<{ count: number | string }>(await transaction.unsafe("SELECT COUNT(*) AS count FROM factory_pool_requests WHERE state = 'queued'"))[0];
      if (Number(tenantQueued?.count ?? 0) >= this.limits.perTenant || Number(allQueued?.count ?? 0) >= this.limits.pool) return { status: "rejected", reservationId: input.reservationId, reason: POOL_QUEUE_FULL_REASON, retryAfterSeconds: POOL_QUEUE_FULL_RETRY_SECONDS };
      await transaction.unsafe("INSERT INTO factory_pool_tenants(tenant_id, weight) VALUES ($1, 1) ON CONFLICT DO NOTHING", [input.tenantId]);
      await transaction.unsafe("INSERT INTO factory_pool_requests(reservation_id, tenant_id, grant_revision, resources_json, priority, ready_sequence, node_id, queued_at, admission_deadline, state, fence) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,'queued',$10)", [input.reservationId, input.tenantId, input.grantRevision, vectorJson(vector), input.priority ?? 0, input.readySequence ?? 0, input.nodeId ?? "", iso(now), iso(input.admissionDeadline), randomUUID()]);
      return { status: "queued", reservationId: input.reservationId, queueAgeMs: 0 };
    });
  }

  /** Allocate at most one complete resource vector under a single pool lock. */
  async schedule(): Promise<PoolDecision | undefined> {
    const now = this.clock.now();
    return this.database.begin(async (transaction) => {
      await this.lock(transaction);
      await this.expireLocked(transaction, now);
      await transaction.unsafe("UPDATE factory_pool_requests SET state = 'rejected', reason = 'admission-deadline-expired' WHERE state = 'queued' AND admission_deadline <= $1", [iso(now)]);
      const candidates = rows<RequestRow>(await transaction.unsafe("SELECT * FROM factory_pool_requests WHERE state = 'queued' ORDER BY queued_at, reservation_id FOR UPDATE"));
      if (!candidates.length) return undefined;
      const capacities = await this.capacities(transaction, "FOR UPDATE");
      const feasible = candidates.filter(candidate => this.fits(decodeVector(candidate.resources_json), capacities));
      const old = candidates.filter(candidate => now.getTime() - asDate(candidate.queued_at).getTime() >= ageLaneMs).sort((left, right) => asDate(left.queued_at).getTime() - asDate(right.queued_at).getTime() || compareCodeUnits(left.reservation_id, right.reservation_id));
      let candidate: RequestRow | undefined;
      if (old.length) {
        const oldest = old[0]!;
        if (!this.fits(decodeVector(oldest.resources_json), capacities)) {
          const oldVector = decodeVector(oldest.resources_json);
          const unrelated = feasible.filter(entry => POOL_RESOURCE_CLASSES.every(resource => oldVector[resource] === undefined || decodeVector(entry.resources_json)[resource] === undefined));
          candidate = unrelated.length ? await this.chooseFair(transaction, unrelated, capacities) : undefined;
          if (!candidate) return this.blockedDecision(oldest, now, capacities);
        } else candidate = oldest;
      } else {
        candidate = await this.chooseFair(transaction, feasible, capacities);
      }
      if (!candidate) return this.blockedDecision(candidates[0]!, now, capacities);
      const vector = decodeVector(candidate.resources_json);
      if (!await this.respectsReservedMinimums(transaction, candidate.tenant_id, vector, capacities)) return this.blockedDecision(candidate, now, capacities);
      let hostId: string | undefined;
      if (vector["gpu-host"] !== undefined) {
        const host = rows<HostRow>(await transaction.unsafe("SELECT host_id, state, reservation_id, holder_generation FROM factory_pool_hosts WHERE state = 'available' ORDER BY host_id FOR UPDATE LIMIT 1"))[0];
        if (!host) return this.blockedDecision(candidate, now, capacities, "gpu-host");
        hostId = host.host_id;
      }
      const token = randomUUID();
      const generation = Number(candidate.allocation_generation);
      const deadline = new Date(now.getTime() + leaseMs);
      for (const resourceClass of POOL_RESOURCE_CLASSES) {
        const units = vector[resourceClass];
        if (units !== undefined) await transaction.unsafe("UPDATE factory_pool_resources SET allocated_units = allocated_units + $1 WHERE resource_class = $2 AND allocated_units + $1 <= total_units", [units, resourceClass]);
      }
      const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'held', holder_generation = allocation_generation, allocation_token = $1, lease_deadline = $2, host_id = $3, reason = NULL WHERE reservation_id = $4 AND state = 'queued' RETURNING *", [token, iso(deadline), hostId ?? null, candidate.reservation_id]))[0];
      if (!updated) throw new Error("Pool admission changed while scheduled.");
      if (hostId) await transaction.unsafe("UPDATE factory_pool_hosts SET state = 'assigned', reservation_id = $1, tenant_id = $2, holder_generation = $3, reimage_receipt = NULL WHERE host_id = $4 AND state = 'available'", [candidate.reservation_id, candidate.tenant_id, generation, hostId]);
      for (const resourceClass of POOL_RESOURCE_CLASSES) if (vector[resourceClass] !== undefined) await transaction.unsafe("INSERT INTO factory_pool_round_members(resource_class, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [resourceClass, candidate.tenant_id]);
      return { status: "admitted", reservationId: candidate.reservation_id, lease: toLease(updated) };
    });
  }

  async acknowledgeStart(fence: PoolLeaseFence): Promise<PoolLease> {
    return this.withLiveFence(fence, async (transaction, row, now) => {
      const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'running', effects = effects + 1 WHERE reservation_id = $1 AND state = 'held' RETURNING *", [row.reservation_id]))[0];
      if (!updated && row.state !== "running") throw new Error("Pool lease cannot acknowledge start.");
      return toLease(updated ?? row);
    });
  }

  async renew(fence: PoolLeaseFence): Promise<PoolLease> {
    return this.withLiveFence(fence, async (transaction, row, now) => {
      const deadline = new Date(now.getTime() + leaseMs);
      const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET lease_deadline = $1 WHERE reservation_id = $2 AND state IN ('held','running') RETURNING *", [iso(deadline), row.reservation_id]))[0];
      if (!updated) throw new Error("Pool lease cannot renew.");
      return toLease(updated);
    });
  }

  /** A revocation fences future gateway effects but deliberately retains capacity. */
  /** Cancel a queued admission immediately; a holder follows the fenced stop path. */
  async cancel(reservationId: string, expectedGeneration?: number): Promise<PoolLeaseStatus> {
    assertOpaque(reservationId, "reservation id");
    if (expectedGeneration !== undefined) assertCounter(expectedGeneration, "allocation generation", 1);
    return this.database.begin(async (transaction) => {
      await this.lock(transaction);
      const row = rows<RequestRow>(await transaction.unsafe("SELECT * FROM factory_pool_requests WHERE reservation_id = $1 FOR UPDATE", [reservationId]))[0];
      if (!row) throw new Error("Pool reservation does not exist.");
      if (expectedGeneration !== undefined && Number(row.allocation_generation) !== expectedGeneration) throw new Error("Pool lease is fenced.");
      if (row.state === "queued") {
        const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'settled', reason = 'cancelled-before-admission' WHERE reservation_id = $1 RETURNING *", [reservationId]))[0];
        return readRequest(updated!);
      }
      if (row.state === "held" || row.state === "running") {
        const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'revoking', allocation_generation = allocation_generation + 1, reason = 'cancelled' WHERE reservation_id = $1 RETURNING *", [reservationId]))[0];
        return readRequest(updated!);
      }
      return readRequest(row);
    });
  }

  /** Explicit reconciliation acknowledges uncertainty but never frees capacity. */
  async acknowledgeUncertainEffects(reservationId: string, expectedFence: string, acknowledge: boolean): Promise<PoolLeaseStatus> {
    assertOpaque(reservationId, "reservation id"); assertOpaque(expectedFence, "lease fence");
    if (acknowledge !== true) throw new Error("Pool uncertainty requires explicit acknowledgement.");
    return this.database.begin(async (transaction) => {
      await this.lock(transaction);
      const row = rows<RequestRow>(await transaction.unsafe("SELECT * FROM factory_pool_requests WHERE reservation_id = $1 FOR UPDATE", [reservationId]))[0];
      if (!row || row.fence !== expectedFence || row.state !== "uncertain") throw new Error("Pool uncertainty recovery is fenced.");
      const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'revoking', reason = 'uncertainty-acknowledged' WHERE reservation_id = $1 RETURNING *", [reservationId]))[0];
      return readRequest(updated!);
    });
  }

  async revoke(reservationId: string, expectedGeneration: number): Promise<PoolLeaseStatus> {
    assertOpaque(reservationId, "reservation id"); assertCounter(expectedGeneration, "allocation generation", 1);
    return this.database.begin(async (transaction) => {
      await this.lock(transaction);
      const row = rows<RequestRow>(await transaction.unsafe("SELECT * FROM factory_pool_requests WHERE reservation_id = $1 FOR UPDATE", [reservationId]))[0];
      if (!row) throw new Error("Pool reservation does not exist.");
      if (Number(row.allocation_generation) !== expectedGeneration) throw new Error("Pool lease is fenced.");
      if (row.state === "settled" || row.state === "rejected") return readRequest(row);
      if (row.state === "queued") {
        const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'settled', reason = 'revoked-before-admission' WHERE reservation_id = $1 RETURNING *", [reservationId]))[0];
        return readRequest(updated!);
      }
      const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'revoking', allocation_generation = allocation_generation + 1, reason = 'revoked' WHERE reservation_id = $1 RETURNING *", [reservationId]))[0];
      return readRequest(updated!);
    });
  }

  /** Expiry fences the holder; it never changes allocated capacity. */
  async expire(): Promise<number> {
    return this.database.begin(async (transaction) => {
      await this.lock(transaction);
      return this.expireLocked(transaction, this.clock.now());
    });
  }

  /** Process restart/lost pool ledger recovery: all still-live leases become uncertain. */
  async recoverAfterLedgerLoss(): Promise<number> {
    return this.database.begin(async (transaction) => {
      await this.lock(transaction);
      const affected = rows<{ reservation_id: string }>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'uncertain', allocation_generation = allocation_generation + 1, reason = 'ledger-recovery' WHERE state IN ('held','running','revoking') RETURNING reservation_id"));
      await transaction.unsafe("UPDATE factory_pool_hosts SET state = 'quarantined' WHERE reservation_id IN (SELECT reservation_id FROM factory_pool_requests WHERE state = 'uncertain')");
      return affected.length;
    });
  }

  /** Positive supervisor/provider proof releases non-GPU capacity; GPUs still require reimage. */
  async confirmStopped(input: PoolStopConfirmation): Promise<PoolLeaseStatus> {
    assertOpaque(input.reservationId, "reservation id"); assertCounter(input.holderGeneration, "holder generation", 1);
    if (input.hostId !== undefined) assertOpaque(input.hostId, "host id");
    return this.database.begin(async (transaction) => {
      await this.lock(transaction);
      const row = rows<RequestRow>(await transaction.unsafe("SELECT * FROM factory_pool_requests WHERE reservation_id = $1 FOR UPDATE", [input.reservationId]))[0];
      if (!row) throw new Error("Pool reservation does not exist.");
      if (Number(row.holder_generation) !== input.holderGeneration) throw new Error("Pool stop confirmation is stale.");
      if (input.hostId !== undefined && row.host_id !== input.hostId) throw new Error("Pool stop confirmation host is stale.");
      if (row.state === "settled" || row.reason === "awaiting-gpu-reimage") return readRequest(row);
      if (row.state === "queued" || row.state === "rejected") throw new Error("Pool stop confirmation has no holder.");
      const vector = decodeVector(row.resources_json);
      for (const resourceClass of POOL_RESOURCE_CLASSES) {
        const units = vector[resourceClass];
        if (units !== undefined && resourceClass !== "gpu-host") await transaction.unsafe("UPDATE factory_pool_resources SET allocated_units = allocated_units - $1 WHERE resource_class = $2 AND allocated_units >= $1", [units, resourceClass]);
      }
      if (row.host_id) {
        await transaction.unsafe("UPDATE factory_pool_hosts SET state = 'reimage_required' WHERE host_id = $1 AND reservation_id = $2 AND holder_generation = $3", [row.host_id, row.reservation_id, row.holder_generation]);
        const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'uncertain', effects = 0, reason = 'awaiting-gpu-reimage' WHERE reservation_id = $1 RETURNING *", [row.reservation_id]))[0];
        return readRequest(updated!);
      }
      const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'settled', effects = 0, reason = 'stopped-confirmed' WHERE reservation_id = $1 RETURNING *", [row.reservation_id]))[0];
      return readRequest(updated!);
    });
  }

  async confirmGpuReimage(input: PoolGpuReimageReceipt): Promise<PoolLeaseStatus> {
    assertOpaque(input.reservationId, "reservation id"); assertOpaque(input.hostId, "host id"); assertOpaque(input.receipt, "reimage receipt"); assertCounter(input.holderGeneration, "holder generation", 1);
    return this.database.begin(async (transaction) => {
      await this.lock(transaction);
      const row = rows<RequestRow>(await transaction.unsafe("SELECT * FROM factory_pool_requests WHERE reservation_id = $1 FOR UPDATE", [input.reservationId]))[0];
      if (!row || row.host_id !== input.hostId || Number(row.holder_generation) !== input.holderGeneration || row.state !== "uncertain") throw new Error("GPU reimage confirmation is stale.");
      const host = rows<HostRow>(await transaction.unsafe("SELECT host_id, state, reservation_id, holder_generation FROM factory_pool_hosts WHERE host_id = $1 FOR UPDATE", [input.hostId]))[0];
      if (host?.state !== "reimage_required" || host.reservation_id !== input.reservationId || Number(host.holder_generation) !== input.holderGeneration) throw new Error("GPU host cannot be reused yet.");
      await transaction.unsafe("UPDATE factory_pool_resources SET allocated_units = allocated_units - 1 WHERE resource_class = 'gpu-host' AND allocated_units > 0");
      await transaction.unsafe("UPDATE factory_pool_hosts SET state = 'available', reservation_id = NULL, tenant_id = NULL, holder_generation = NULL, reimage_receipt = $1 WHERE host_id = $2", [input.receipt, input.hostId]);
      const updated = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'settled', reason = 'gpu-reimage-confirmed' WHERE reservation_id = $1 RETURNING *", [input.reservationId]))[0];
      return readRequest(updated!);
    });
  }

  async status(reservationId: string): Promise<PoolLeaseStatus | undefined> {
    assertOpaque(reservationId, "reservation id");
    const row = rows<RequestRow>(await this.database.unsafe("SELECT * FROM factory_pool_requests WHERE reservation_id = $1", [reservationId]))[0];
    return row ? readRequest(row) : undefined;
  }

  private async withLiveFence<Result>(fence: PoolLeaseFence, work: (transaction: PoolSql, row: RequestRow, now: Date) => Promise<Result>): Promise<Result> {
    assertOpaque(fence.reservationId, "reservation id"); assertOpaque(fence.tenantId, "tenant id"); assertOpaque(fence.allocationToken, "allocation token"); assertCounter(fence.grantRevision, "grant revision"); assertCounter(fence.allocationGeneration, "allocation generation", 1);
    return this.database.begin(async (transaction) => {
      await this.lock(transaction);
      const now = this.clock.now();
      await this.expireLocked(transaction, now);
      const row = rows<RequestRow>(await transaction.unsafe("SELECT * FROM factory_pool_requests WHERE reservation_id = $1 FOR UPDATE", [fence.reservationId]))[0];
      if (!row || row.tenant_id !== fence.tenantId || Number(row.grant_revision) !== fence.grantRevision || Number(row.allocation_generation) !== fence.allocationGeneration || row.allocation_token !== fence.allocationToken || !["held", "running"].includes(row.state)) throw new Error("Pool lease is fenced.");
      return work(transaction, row, now);
    });
  }

  private async lock(transaction: PoolSql): Promise<void> {
    await transaction.unsafe("SELECT pg_advisory_xact_lock(hashtext('factory_pool_scheduler_v1'))");
  }

  private async capacities(transaction: PoolSql, lockClause: "FOR SHARE" | "FOR UPDATE"): Promise<Record<PoolResourceClass, { total: number; allocated: number }>> {
    const result = Object.create(null) as Record<PoolResourceClass, { total: number; allocated: number }>;
    for (const row of rows<ResourceRow>(await transaction.unsafe(`SELECT resource_class, total_units, allocated_units FROM factory_pool_resources ORDER BY resource_class ${lockClause}`))) result[row.resource_class] = { total: Number(row.total_units), allocated: Number(row.allocated_units) };
    return result;
  }

  private fits(vector: PoolResourceVector, capacities: Record<PoolResourceClass, { total: number; allocated: number }>): boolean {
    for (const resourceClass of POOL_RESOURCE_CLASSES) {
      const units = vector[resourceClass];
      if (units !== undefined && (!Object.hasOwn(capacities, resourceClass) || capacities[resourceClass].total - capacities[resourceClass].allocated < units)) return false;
    }
    return true;
  }

  private blockedDecision(row: RequestRow, now: Date, capacities: Record<PoolResourceClass, { total: number; allocated: number }>, forced?: PoolResourceClass): PoolDecision {
    const vector = decodeVector(row.resources_json);
    const blockingResource = forced ?? POOL_RESOURCE_CLASSES.find(resource => vector[resource] !== undefined && (!Object.hasOwn(capacities, resource) || capacities[resource].total - capacities[resource].allocated < vector[resource]!));
    return { status: "queued", reservationId: row.reservation_id, queueAgeMs: Math.max(0, now.getTime() - asDate(row.queued_at).getTime()), ...(blockingResource ? { blockingResource } : {}) };
  }

  private async chooseFair(transaction: PoolSql, candidates: RequestRow[], capacities: Record<PoolResourceClass, { total: number; allocated: number }>): Promise<RequestRow | undefined> {
    const top = new Map<string, RequestRow>();
    for (const candidate of candidates) {
      if (!this.fits(decodeVector(candidate.resources_json), capacities)) continue;
      const current = top.get(candidate.tenant_id);
      if (!current || Number(candidate.priority) > Number(current.priority) || Number(candidate.priority) === Number(current.priority) && (Number(candidate.ready_sequence) < Number(current.ready_sequence) || Number(candidate.ready_sequence) === Number(current.ready_sequence) && compareCodeUnits(candidate.node_id, current.node_id) < 0)) top.set(candidate.tenant_id, candidate);
    }
    const weights = new Map(rows<{ tenant_id: string; weight: number | string }>(await transaction.unsafe("SELECT tenant_id, weight FROM factory_pool_tenants FOR SHARE")).map(row => [row.tenant_id, Number(row.weight)]));
    const active = rows<RequestRow>(await transaction.unsafe("SELECT * FROM factory_pool_requests WHERE state IN ('held','running','revoking','uncertain') FOR SHARE"));
    const service = new Map<string, Record<PoolResourceClass, number>>();
    for (const row of active) {
      const tenantService = service.get(row.tenant_id) ?? Object.create(null) as Record<PoolResourceClass, number>;
      const vector = activeResources(row);
      for (const resourceClass of POOL_RESOURCE_CLASSES) tenantService[resourceClass] = (tenantService[resourceClass] ?? 0) + (vector[resourceClass] ?? 0);
      service.set(row.tenant_id, tenantService);
    }
    const ordered = [...top.values()].sort((left, right) => {
      const leftScore = this.dominantServiceScore(left, service, weights);
      const rightScore = this.dominantServiceScore(right, service, weights);
      return leftScore - rightScore || compareCodeUnits(left.tenant_id, right.tenant_id) || Number(right.priority) - Number(left.priority) || Number(left.ready_sequence) - Number(right.ready_sequence) || compareCodeUnits(left.node_id, right.node_id);
    });
    const allowed = [] as RequestRow[];
    for (const candidate of ordered) {
      const vector = decodeVector(candidate.resources_json);
      if (await this.respectsReservedMinimums(transaction, candidate.tenant_id, vector, capacities)) allowed.push(candidate);
    }
    if (!allowed.length) return undefined;
    const served = new Set(rows<{ resource_class: PoolResourceClass; tenant_id: string }>(await transaction.unsafe("SELECT resource_class, tenant_id FROM factory_pool_round_members FOR SHARE")).map(row => `${row.resource_class}:${row.tenant_id}`));
    const inRound = allowed.filter(candidate => this.isRoundEligible(candidate, served));
    if (inRound.length) return inRound[0];
    // Every feasible tenant has taken its turn in every class it asked for.
    // Start the next deterministic round; this does not free or invent capacity.
    await transaction.unsafe("DELETE FROM factory_pool_round_members");
    return allowed[0];
  }

  /**
   * CPU, memory bytes, provider permits, and whole GPU hosts have unrelated units. Compare a
   * request only with its tenant's service in the classes it consumes. The
   * largest weighted class is the max-min (dominant) score for a multi-class
   * request, so a large CPU allocation cannot make its first provider turn
   * lose to a tenant that has already consumed provider capacity.
   */
  private dominantServiceScore(candidate: RequestRow, service: ReadonlyMap<string, Record<PoolResourceClass, number>>, weights: ReadonlyMap<string, number>): number {
    const vector = decodeVector(candidate.resources_json);
    const consumed = service.get(candidate.tenant_id);
    const weight = weights.get(candidate.tenant_id) ?? 1;
    let score = 0;
    for (const resourceClass of POOL_RESOURCE_CLASSES) {
      if (vector[resourceClass] !== undefined) score = Math.max(score, (consumed?.[resourceClass] ?? 0) / weight);
    }
    return score;
  }


  /**
   * C03 gives each runnable tenant one feasible allocation per round for each
   * resource class it requests, so a tenant that already took its turn in any
   * class it needs waits for the next round. Ending the round is what returns
   * the turn: an earlier rule let a served tenant run again whenever no peer
   * was still unserved, which never ended the round and let the smallest tenant
   * id take every allocation once finished work released its capacity.
   */
  private isRoundEligible(candidate: RequestRow, served: ReadonlySet<string>): boolean {
    const vector = decodeVector(candidate.resources_json);
    return POOL_RESOURCE_CLASSES.every(resourceClass => vector[resourceClass] === undefined || !served.has(`${resourceClass}:${candidate.tenant_id}`));
  }

  private async respectsReservedMinimums(transaction: PoolSql, tenantId: string, vector: PoolResourceVector, capacities: Record<PoolResourceClass, { total: number; allocated: number }>): Promise<boolean> {
    const minima = rows<{ tenant_id: string; resource_class: PoolResourceClass; minimum_units: number | string }>(await transaction.unsafe("SELECT tenant_id, resource_class, minimum_units FROM factory_pool_tenant_minima FOR SHARE"));
    const active = rows<RequestRow>(await transaction.unsafe("SELECT * FROM factory_pool_requests WHERE state IN ('held','running','revoking','uncertain') FOR SHARE"));
    const held = new Map<string, Record<PoolResourceClass, number>>();
    for (const row of active) {
      const allocation = held.get(row.tenant_id) ?? Object.create(null) as Record<PoolResourceClass, number>;
      for (const resourceClass of POOL_RESOURCE_CLASSES) allocation[resourceClass] = (allocation[resourceClass] ?? 0) + (activeResources(row)[resourceClass] ?? 0);
      held.set(row.tenant_id, allocation);
    }
    for (const resourceClass of POOL_RESOURCE_CLASSES) {
      const availableAfter = (capacities[resourceClass]?.total ?? 0) - (capacities[resourceClass]?.allocated ?? 0) - (vector[resourceClass] ?? 0);
      const protectedForOthers = minima.filter(minimum => minimum.resource_class === resourceClass && minimum.tenant_id !== tenantId).reduce((sum, minimum) => sum + Math.max(0, Number(minimum.minimum_units) - (held.get(minimum.tenant_id)?.[resourceClass] ?? 0)), 0);
      if (availableAfter < protectedForOthers) return false;
    }
    return true;
  }

  private async expireLocked(transaction: PoolSql, now: Date): Promise<number> {
    const expired = rows<RequestRow>(await transaction.unsafe("UPDATE factory_pool_requests SET state = 'uncertain', allocation_generation = allocation_generation + 1, reason = 'lease-expired' WHERE state IN ('held','running') AND lease_deadline <= $1 RETURNING *", [iso(now)]));
    for (const row of expired) if (row.host_id) await transaction.unsafe("UPDATE factory_pool_hosts SET state = 'quarantined' WHERE host_id = $1 AND reservation_id = $2", [row.host_id, row.reservation_id]);
    return expired.length;
  }

  private decisionFor(row: RequestRow, now: Date): PoolDecision {
    if (row.state === "held" || row.state === "running") return { status: "admitted", reservationId: row.reservation_id, lease: toLease(row) };
    if (row.state === "rejected") return { status: "rejected", reservationId: row.reservation_id, reason: row.reason ?? "rejected" };
    if (row.state === "settled") return { status: "cancelled", reservationId: row.reservation_id, reason: row.reason ?? "settled" };
    return { status: "queued", reservationId: row.reservation_id, ...(row.reason ? { reason: row.reason } : {}), queueAgeMs: Math.max(0, now.getTime() - asDate(row.queued_at).getTime()) };
  }
}
