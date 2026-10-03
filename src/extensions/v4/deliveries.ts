import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertJson, type InstallationRecord } from "@ezcorp/extension-contract";
import type { MigrationDb } from "../../db/migrations/types";
import { releaseRows as resultRows, type ReleaseDatabase } from "../../db/queries/extension-releases";
import { DurableDeliveryQueue, dispatchDurableDelivery, durableInputHash, type DurableDeliveryStore } from "../../delivery-queue/durable-delivery-queue";
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

class ExtensionDeliveryStore implements DurableDeliveryStore<ExtensionDelivery> {
  constructor(private readonly database: MigrationDb) {}

  async findDuplicate(installationId: string, deduplicationId: string): Promise<ExtensionDelivery | null> {
    const rows = resultRows<DeliveryRow>(await this.database.execute(sql`SELECT payload, state FROM extension_release_deliveries WHERE installation_id = ${installationId} AND deduplication_id = ${deduplicationId}`));
    return rows[0] ? decode(rows[0]) : null;
  }

  async insert(delivery: ExtensionDelivery): Promise<boolean> {
    const inserted = resultRows(await this.database.execute(sql`INSERT INTO extension_release_deliveries (id, installation_id, deduplication_id, generation, state, available_at, lease_until, payload) VALUES (${delivery.id}, ${delivery.installationId}, ${delivery.deduplicationId}, ${delivery.generation}, ${delivery.state}, ${delivery.availableAt}, 0, ${JSON.stringify(delivery)}) ON CONFLICT (installation_id, deduplication_id) DO NOTHING RETURNING id`));
    return inserted.length === 1;
  }

  async claimCandidate(_scope: string | null, now: number): Promise<ExtensionDelivery | null> {
    const rows = resultRows<DeliveryRow>(await this.database.execute(sql`SELECT payload, state FROM extension_release_deliveries WHERE (state = 'queued' AND available_at <= ${now}) OR (state = 'leased' AND lease_until <= ${now}) ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`));
    return rows[0] ? decode(rows[0]) : null;
  }

  async findById(installationId: string, id: string): Promise<ExtensionDelivery | null> {
    const rows = resultRows<DeliveryRow>(await this.database.execute(sql`SELECT payload, state FROM extension_release_deliveries WHERE installation_id = ${installationId} AND id = ${id} FOR UPDATE`));
    return rows[0] ? decode(rows[0]) : null;
  }

  async write(delivery: ExtensionDelivery): Promise<void> {
    await this.database.execute(sql`UPDATE extension_release_deliveries SET state = ${delivery.state}, available_at = ${delivery.availableAt}, lease_until = ${delivery.leaseUntil}, payload = ${JSON.stringify(delivery)} WHERE id = ${delivery.id}`);
  }

  async inspect(installationId: string, id: string): Promise<ExtensionDelivery | null> {
    const rows = resultRows<DeliveryRow>(await this.database.execute(sql`SELECT payload, state FROM extension_release_deliveries WHERE installation_id = ${installationId} AND id = ${id}`));
    return rows[0] ? decode(rows[0]) : null;
  }
}

const stateMachine = new DurableDeliveryQueue<ExtensionDelivery>((code, message) => new LifecycleError(code, message), randomUUID);

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
      const identity = ({ installationId, releaseId, generation, principalId, scope, deduplicationId, kind, input: data }: typeof input) => ({ installationId, releaseId, generation, principalId, scope, deduplicationId, kind, input: data });
      return stateMachine.enqueue(new ExtensionDeliveryStore(transaction), {
        scope: input.installationId,
        deduplicationId: input.deduplicationId,
        inputHash: durableInputHash(identity(input)),
        hashExisting: previous => durableInputHash(identity(previous)),
        create: () => ({ ...input, id: randomUUID(), state: "queued", attempts: 0, maxAttempts: 3, availableAt: now(), leaseUntil: 0, createdAt: now() }),
      });
  }

  async claim(leaseMs = 60_000): Promise<ExtensionDelivery | null> {
    return this.database.transaction(transaction => stateMachine.claim(new ExtensionDeliveryStore(transaction), null, this.now(), leaseMs));
  }

  async settle(delivery: ExtensionDelivery, outcome: "delivered" | "retry" | "outcome_unknown", failureCode?: string): Promise<ExtensionDelivery> {
    return this.database.transaction(transaction => stateMachine.settle(new ExtensionDeliveryStore(transaction), delivery.installationId, delivery, this.now(), outcome, failureCode));
  }

  async inspect(installationId: string, deliveryId: string): Promise<ExtensionDelivery | null> {
    return stateMachine.inspect(new ExtensionDeliveryStore(this.database), installationId, deliveryId);
  }

  async dispatch(handler: (delivery: ExtensionDelivery) => Promise<void>): Promise<ExtensionDelivery | null> {
    return dispatchDurableDelivery(() => this.claim(), (delivery, outcome, code) => this.settle(delivery, outcome, code), handler, error => {
      if (error instanceof LifecycleError && error.code === "delivery_lease_lost") throw error;
      return error instanceof RetryableDeliveryError ? error.code : null;
    });
  }
}
