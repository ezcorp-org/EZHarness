import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertJson, canonicalJson, type InstallationRecord } from "@ezcorp/extension-contract";
import type { MigrationDb } from "../../db/migrations/types";
import { releaseRows as resultRows, type ReleaseDatabase } from "../../db/queries/extension-releases";
import { LifecycleError } from "./types";

export interface ExtensionDelivery {
  id: string;
  installationId: string;
  releaseId: string;
  generation: number;
  principalId: string;
  scope: string;
  deduplicationId: string;
  kind: "event" | "webhook" | "schedule";
  input: unknown;
  transportContext?: Record<string, unknown>;
  state: "queued" | "leased" | "delivered" | "cancelled" | "dead_letter" | "outcome_unknown";
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leaseUntil: number;
  leaseToken?: string;
  failureCode?: string;
  createdAt: number;
}

type DeliveryRow = { payload: string; state: ExtensionDelivery["state"] };

function decode(row: DeliveryRow): ExtensionDelivery { return { ...JSON.parse(row.payload), state: row.state }; }

async function write(transaction: MigrationDb, delivery: ExtensionDelivery): Promise<void> {
  await transaction.execute(sql`UPDATE extension_release_deliveries SET state = ${delivery.state}, available_at = ${delivery.availableAt}, lease_until = ${delivery.leaseUntil}, payload = ${JSON.stringify(delivery)} WHERE id = ${delivery.id}`);
}

export class RetryableDeliveryError extends Error {
  constructor(public readonly code: string) { super("Delivery failed before an external effect."); }
}

export class ExtensionDeliveryQueue {
  constructor(private readonly database: ReleaseDatabase, private readonly now: () => number = Date.now) {}

  async enqueue(input: Pick<ExtensionDelivery, "installationId" | "releaseId" | "generation" | "principalId" | "scope" | "deduplicationId" | "kind" | "input" | "transportContext">): Promise<ExtensionDelivery> {
    return this.database.transaction(transaction => ExtensionDeliveryQueue.enqueueInTransaction(transaction, input, this.now));
  }

  static async enqueueInTransaction(transaction: MigrationDb, input: Pick<ExtensionDelivery, "installationId" | "releaseId" | "generation" | "principalId" | "scope" | "deduplicationId" | "kind" | "input" | "transportContext">, now: () => number = Date.now): Promise<ExtensionDelivery> {
    assertJson(input.input);
    if (input.transportContext !== undefined) assertJson(input.transportContext);
    for (const value of [input.installationId, input.releaseId, input.principalId, input.scope, input.deduplicationId]) if (!value || value.length > 512) throw new LifecycleError("invalid_delivery", "Delivery identity fields are required and bounded.");
    if (!["event", "webhook", "schedule"].includes(input.kind)) throw new LifecycleError("invalid_delivery", "Unsupported delivery kind.");
      const installations = resultRows<{ payload: string }>(await transaction.execute(sql`SELECT payload FROM extension_release_installations WHERE id = ${input.installationId} FOR UPDATE`));
      const installation: InstallationRecord | undefined = installations[0] ? JSON.parse(installations[0].payload) : undefined;
      if (!installation?.enabled || installation.uninstalled || installation.generation !== input.generation || installation.activeReleaseId !== input.releaseId || installation.ownerId !== input.principalId || installation.scope !== input.scope) throw new LifecycleError("delivery_authority_changed", "Delivery does not match its active installation and recorded owner.");
      const existing = resultRows<DeliveryRow>(await transaction.execute(sql`SELECT payload, state FROM extension_release_deliveries WHERE installation_id = ${input.installationId} AND deduplication_id = ${input.deduplicationId}`));
      if (existing[0]) {
        const previous = decode(existing[0]);
        const identity = ({ installationId, releaseId, generation, principalId, scope, deduplicationId, kind, input: data }: typeof input) => ({ installationId, releaseId, generation, principalId, scope, deduplicationId, kind, input: data });
        if (canonicalJson(identity(previous)) !== canonicalJson(identity(input))) throw new LifecycleError("delivery_conflict", "Deduplication ID already identifies another delivery.");
        return previous;
      }
      const delivery: ExtensionDelivery = { ...input, id: randomUUID(), state: "queued", attempts: 0, maxAttempts: 3, availableAt: now(), leaseUntil: 0, createdAt: now() };
      await transaction.execute(sql`INSERT INTO extension_release_deliveries (id, installation_id, deduplication_id, generation, state, available_at, lease_until, payload) VALUES (${delivery.id}, ${delivery.installationId}, ${delivery.deduplicationId}, ${delivery.generation}, ${delivery.state}, ${delivery.availableAt}, 0, ${JSON.stringify(delivery)})`);
      return delivery;
  }

  async claim(leaseMs = 60_000): Promise<ExtensionDelivery | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new LifecycleError("invalid_lease", "Delivery lease must be between 1 ms and 5 minutes.");
    return this.database.transaction(async (transaction) => {
      const rows = resultRows<DeliveryRow>(await transaction.execute(sql`SELECT payload, state FROM extension_release_deliveries WHERE (state = 'queued' AND available_at <= ${this.now()}) OR (state = 'leased' AND lease_until <= ${this.now()}) ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`));
      if (!rows[0]) return null;
      const delivery = decode(rows[0]);
      if (delivery.state === "leased") { delivery.state = "outcome_unknown"; delivery.failureCode = "worker_lease_expired"; delivery.leaseUntil = 0; await write(transaction, delivery); return null; }
      if (delivery.attempts >= delivery.maxAttempts) { delivery.state = "dead_letter"; delivery.failureCode = "attempts_exhausted"; await write(transaction, delivery); return null; }
      delivery.state = "leased";
      delivery.attempts += 1;
      delivery.leaseUntil = this.now() + leaseMs;
      delivery.leaseToken = randomUUID();
      await write(transaction, delivery);
      return delivery;
    });
  }

  async settle(delivery: ExtensionDelivery, outcome: "delivered" | "retry" | "outcome_unknown", failureCode?: string): Promise<ExtensionDelivery> {
    return this.database.transaction(async (transaction) => {
      const rows = resultRows<DeliveryRow>(await transaction.execute(sql`SELECT payload, state FROM extension_release_deliveries WHERE id = ${delivery.id} FOR UPDATE`));
      if (!rows[0]) throw new LifecycleError("not_found", "Delivery not found.");
      const current = decode(rows[0]);
      if (current.state !== "leased" || current.leaseToken !== delivery.leaseToken || current.leaseUntil <= this.now()) throw new LifecycleError("delivery_lease_lost", "Delivery is no longer owned by this worker.");
      current.state = outcome === "retry" ? current.attempts >= current.maxAttempts ? "dead_letter" : "queued" : outcome;
      current.availableAt = this.now() + Math.min(60_000, 1000 * 2 ** (current.attempts - 1));
      current.leaseUntil = 0;
      if (failureCode) current.failureCode = /^[a-zA-Z0-9_-]{1,128}$/.test(failureCode) ? failureCode : "delivery_failed";
      await write(transaction, current);
      return current;
    });
  }

  async inspect(installationId: string, deliveryId: string): Promise<ExtensionDelivery | null> {
    const rows = resultRows<DeliveryRow>(await this.database.execute(sql`SELECT payload, state FROM extension_release_deliveries WHERE installation_id = ${installationId} AND id = ${deliveryId}`));
    return rows[0] ? decode(rows[0]) : null;
  }

  async dispatch(handler: (delivery: ExtensionDelivery) => Promise<void>): Promise<ExtensionDelivery | null> {
    const delivery = await this.claim();
    if (!delivery) return null;
    try { await handler(delivery); return await this.settle(delivery, "delivered"); }
    catch (error) {
      if (error instanceof LifecycleError && error.code === "delivery_lease_lost") throw error;
      return this.settle(delivery, error instanceof RetryableDeliveryError ? "retry" : "outcome_unknown", error instanceof RetryableDeliveryError ? error.code : "external_outcome_unknown");
    }
  }
}
