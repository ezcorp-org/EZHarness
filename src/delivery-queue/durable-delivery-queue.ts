import { canonicalJson } from "@ezcorp/extension-contract";
import { createHash } from "node:crypto";

export const DELIVERY_STATES = ["queued", "leased", "delivered", "cancelled", "dead_letter", "outcome_unknown"] as const;

export type DurableDeliveryState = typeof DELIVERY_STATES[number];

export interface DurableDeliveryRecord {
  id: string;
  state: DurableDeliveryState;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leaseUntil: number;
  leaseToken?: string;
  failureCode?: string;
  createdAt: number;
}

export interface DurableDeliveryStore<Record extends DurableDeliveryRecord> {
  findDuplicate(scope: string, deduplicationId: string): Promise<Record | null>;
  insert(record: Record): Promise<boolean>;
  claimCandidate(scope: string | null, now: number): Promise<Record | null>;
  findById(scope: string, id: string): Promise<Record | null>;
  write(record: Record): Promise<void>;
  inspect(scope: string, id: string): Promise<Record | null>;
}

export type DeliveryErrorFactory = (code: string, message: string) => Error;

export function durableInputHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function validateLease(leaseMs: number, error: DeliveryErrorFactory): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
    throw error("invalid_lease", "Delivery lease must be between 1 ms and 5 minutes.");
  }
}

export interface EnqueueRecord<Record extends DurableDeliveryRecord> {
  scope: string;
  deduplicationId: string;
  inputHash: string;
  hashExisting: (record: Record) => string;
  create: () => Record;
}

/** One queue state machine shared by extension deliveries and factory commands. */
export class DurableDeliveryQueue<Record extends DurableDeliveryRecord> {
  constructor(private readonly error: DeliveryErrorFactory, private readonly uuid: () => string) {}

  async enqueue(store: DurableDeliveryStore<Record>, input: EnqueueRecord<Record>): Promise<Record> {
    const existing = await store.findDuplicate(input.scope, input.deduplicationId);
    if (existing) {
      if (input.hashExisting(existing) !== input.inputHash) {
        throw this.error("delivery_conflict", "Deduplication ID already identifies another delivery.");
      }
      return existing;
    }
    const record = input.create();
    if (await store.insert(record)) return record;
    const raced = await store.findDuplicate(input.scope, input.deduplicationId);
    if (!raced) throw this.error("delivery_conflict", "Concurrent delivery insert did not preserve the deduplication record.");
    if (input.hashExisting(raced) !== input.inputHash) {
      throw this.error("delivery_conflict", "Deduplication ID already identifies another delivery.");
    }
    return raced;
  }

  async claim(store: DurableDeliveryStore<Record>, scope: string | null, now: number, leaseMs = 60_000): Promise<Record | null> {
    validateLease(leaseMs, this.error);
    const record = await store.claimCandidate(scope, now);
    if (!record) return null;
    if (record.state === "leased") {
      record.state = "outcome_unknown";
      record.failureCode = "worker_lease_expired";
      record.leaseUntil = 0;
      await store.write(record);
      return null;
    }
    if (record.attempts >= record.maxAttempts) {
      record.state = "dead_letter";
      record.failureCode = "attempts_exhausted";
      await store.write(record);
      return null;
    }
    record.state = "leased";
    record.attempts += 1;
    record.leaseUntil = now + leaseMs;
    record.leaseToken = this.uuid();
    await store.write(record);
    return record;
  }

  /** The live lease `claimed` still owns. Settle and renew share this one check. */
  private async owned(store: DurableDeliveryStore<Record>, scope: string, claimed: Record, now: number): Promise<Record> {
    const current = await store.findById(scope, claimed.id);
    if (!current) throw this.error("not_found", "Delivery not found.");
    if (current.state !== "leased" || current.leaseToken !== claimed.leaseToken || current.leaseUntil <= now) {
      throw this.error("delivery_lease_lost", "Delivery is no longer owned by this worker.");
    }
    return current;
  }

  async settle(store: DurableDeliveryStore<Record>, scope: string, claimed: Record, now: number, outcome: "delivered" | "retry" | "cancelled" | "outcome_unknown", failureCode?: string): Promise<Record> {
    const current = await this.owned(store, scope, claimed, now);
    current.state = outcome === "retry"
      ? current.attempts >= current.maxAttempts ? "dead_letter" : "queued"
      : outcome;
    current.availableAt = now + Math.min(60_000, 1000 * 2 ** (current.attempts - 1));
    current.leaseUntil = 0;
    if (failureCode) current.failureCode = /^[a-zA-Z0-9_-]{1,128}$/.test(failureCode) ? failureCode : "delivery_failed";
    await store.write(current);
    return current;
  }

  /**
   * Extend the lease its owner still holds. Fenced like `settle`: a lease that
   * another worker holds, that a claim already marked `outcome_unknown`, or that
   * has run out is never taken back.
   */
  async renew(store: DurableDeliveryStore<Record>, scope: string, claimed: Record, now: number, leaseMs: number): Promise<Record> {
    validateLease(leaseMs, this.error);
    const current = await this.owned(store, scope, claimed, now);
    current.leaseUntil = now + leaseMs;
    await store.write(current);
    return current;
  }

  /** Cancel work that has not been leased. Leased work needs an owned settlement. */
  async cancel(store: DurableDeliveryStore<Record>, scope: string, id: string, failureCode?: string): Promise<Record> {
    const current = await store.findById(scope, id);
    if (!current) throw this.error("not_found", "Delivery not found.");
    if (current.state === "cancelled") return current;
    if (current.state !== "queued") throw this.error("delivery_already_dispatched", "Only queued delivery work can be cancelled.");
    current.state = "cancelled";
    current.leaseUntil = 0;
    if (failureCode) current.failureCode = /^[a-zA-Z0-9_-]{1,128}$/.test(failureCode) ? failureCode : "delivery_cancelled";
    await store.write(current);
    return current;
  }

  async inspect(store: DurableDeliveryStore<Record>, scope: string, id: string): Promise<Record | null> {
    return store.inspect(scope, id);
  }

  /** A verified external receipt may resolve work regardless of a lost queue acknowledgement. */
  async recoverDelivered(store: DurableDeliveryStore<Record>, scope: string, id: string): Promise<Record> {
    const current = await store.findById(scope, id);
    if (!current) throw this.error("not_found", "Delivery not found.");
    if (current.state === "delivered") return current;
    if (!["queued", "leased", "outcome_unknown"].includes(current.state)) throw this.error("delivery_recovery_invalid", "This delivery cannot accept a recovered receipt.");
    current.state = "delivered";
    current.leaseUntil = 0;
    delete current.leaseToken;
    delete current.failureCode;
    await store.write(current);
    return current;
  }
}

/**
 * Keeps a claimed lease alive while its handler runs. `start` schedules `beat`
 * and returns the function that stops it; `renew` extends the lease.
 */
export interface LeaseHeartbeat<Record extends DurableDeliveryRecord> {
  start(beat: () => Promise<void>): () => void;
  renew(record: Record): Promise<Record>;
}

/** The production schedule: renew at a third of the lease, so two beats may fail before it lapses. */
export function intervalHeartbeat(leaseMs: number): LeaseHeartbeat<never>["start"] {
  return beat => {
    const timer = setInterval(() => { void beat(); }, Math.max(1, Math.floor(leaseMs / 3)));
    timer.unref?.();
    return () => clearInterval(timer);
  };
}

export async function dispatchDurableDelivery<Record extends DurableDeliveryRecord>(
  claim: () => Promise<Record | null>,
  settle: (record: Record, outcome: "delivered" | "retry" | "outcome_unknown", failureCode?: string) => Promise<Record>,
  handler: (record: Record) => Promise<void>,
  retryCode: (error: unknown) => string | null,
  heartbeat?: LeaseHeartbeat<Record>,
): Promise<Record | null> {
  const record = await claim();
  if (!record) return null;
  // A lost lease stops the renewals; the settle below then reports it, fenced.
  let renewing = true;
  let inFlight: Promise<void> | undefined;
  const stop = heartbeat?.start(() => {
    if (!renewing || inFlight) return inFlight ?? Promise.resolve();
    inFlight = heartbeat.renew(record).then(() => undefined, () => { renewing = false; }).finally(() => { inFlight = undefined; });
    return inFlight;
  });
  let failure: { error: unknown } | undefined;
  try {
    await handler(record);
  } catch (error) {
    failure = { error };
  } finally {
    // Renewals end before any settle, so none can race the settlement.
    stop?.();
    await inFlight;
  }
  if (!failure) return settle(record, "delivered");
  const code = retryCode(failure.error);
  return settle(record, code ? "retry" : "outcome_unknown", code ?? "external_outcome_unknown");
}
